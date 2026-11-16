// Pull Worker protocol derived from dsh-mota-executor (MIT, MoTA.ai).
import { buildFailureEnvelope, resultLanguage } from './output.js';
import { LeaseLost, PullTransport, WorkerStopped, sleep } from './transport.js';

const iso = () => new Date().toISOString();
const code = (error, fallback) => typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
  ? error.code : fallback;
const wait = (ms, signal) => sleep(ms, signal).catch(() => {});
const PENDING_LIMIT = 1000;
export const PENDING_RETENTION_MS = 24 * 60 * 60_000;
const RECOVERY_INTERVAL_MS = 30_000;
const RECOVERY_BATCH_SIZE = 8;
const MAX_RECOVERY_ATTEMPTS = 3;
const DEFAULT_SELF_CHECK_INTERVAL_MS = 900_000;
const MAX_SELF_CHECK_INTERVAL_MS = 3_600_000;
const MAX_CONSECUTIVE_SELF_CHECK_FAILURES = 3;

export class MotaWorker {
  constructor({ config, connection, executor, journal, onStatus, onLog, transport }) {
    this.connection = connection;
    this.config = config;
    this.executor = executor;
    this.journal = journal;
    this.onStatus = onStatus;
    this.onLog = onLog;
    this.life = new AbortController();
    this.claims = new AbortController();
    this.transport = transport ?? new PullTransport({
      ...connection, signal: this.life.signal,
      allowInsecureLoopback: config.allowInsecureLoopback === true,
    });
    this.active = new Map();
    this.claimFlights = new Set();
    this.recoveryAttempts = new Map();
    this.state = { phase: 'connecting', executorReady: false, claimsPaused: false, pendingCount: 0 };
    this.usageMissing = 0;
    this.probeResult = null;
    this.selfCheckIntervalMs = DEFAULT_SELF_CHECK_INTERVAL_MS;
    this.selfCheckFailures = 0;
    this.nextSelfCheckAt = 0;
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.onStatus?.({ ...this.state, activeRunIds: [...this.active.keys()], pendingCount: this.journal.pending.size });
  }

  log(event, detail = {}) {
    this.onLog?.({ agentCode: this.connection.agentCode, event, ...detail });
  }

  fatal(error) {
    if (this.life.signal.aborted) return;
    const reason = code(error, 'WORKER_INTERNAL_ERROR');
    this.claims.abort();
    this.life.abort();
    this.update({ phase: 'blocked', lastError: reason });
    this.log('worker-blocked', { reason });
  }

  start() {
    if (this.done) return this.done;
    this.update({ startedAt: iso() });
    const guard = (promise) => promise.catch((error) => {
      if (!this.life.signal.aborted) this.fatal(error);
    });
    this.recovery = guard(this.recoverPending());
    this.lanes = Promise.all(Array.from({ length: this.config.concurrency ?? 1 },
      () => guard(this.claimLoop())));
    this.done = Promise.all([guard(this.heartbeatLoop()), this.lanes, this.recovery]).then(async () => {
      await this.probeFlight;
      if (this.state.phase !== 'blocked') this.update({ phase: 'stopped' });
    });
    return this.done;
  }

  stop({ graceMs = 20_000 } = {}) {
    this.stopFlight ??= this.drain(graceMs);
    return this.stopFlight;
  }

  async drain(graceMs) {
    this.claims.abort();
    if (this.state.phase !== 'blocked' && this.state.phase !== 'stopped') this.update({ phase: 'draining' });
    // Creator may assign a run after the client disconnects. Keep each
    // already-issued poll alive until its transport deadline, or we can
    // leave a valid lease behind that another Worker cannot use.
    await Promise.allSettled(this.claimFlights);
    const timer = setTimeout(() => this.life.abort(), graceMs);
    try {
      await Promise.all([this.lanes, this.recovery]);
    } finally {
      clearTimeout(timer);
      this.life.abort();
    }
    await this.done;
  }

  launchProbe() {
    if (this.probeFlight || this.claims.signal.aborted ||
        this.selfCheckFailures >= MAX_CONSECUTIVE_SELF_CHECK_FAILURES || Date.now() < this.nextSelfCheckAt) return;
    this.probeFlight = (async () => {
      let result;
      try {
        const readiness = this.executor.ready();
        result = readiness.ok === true
          ? await this.executor.probe({ connection: this.connection, signal: this.life.signal })
          : { pass: false, latencyMs: 0, error: 'CODEX_NOT_READY' };
      } catch {
        result = { pass: false, latencyMs: 0, error: 'CODEX_SELFCHECK_FAILED' };
      }
      if (this.life.signal.aborted) return;
      const pass = result.pass === true;
      this.selfCheckFailures = pass ? 0 : this.selfCheckFailures + 1;
      const retryDelay = Math.min(MAX_SELF_CHECK_INTERVAL_MS,
        this.selfCheckIntervalMs * 2 ** Math.max(0, this.selfCheckFailures - 1));
      this.nextSelfCheckAt = Date.now() + retryDelay;
      const selfCheckPaused = this.selfCheckFailures >= MAX_CONSECUTIVE_SELF_CHECK_FAILURES;
      this.probeResult = { pass, latencyMs: Math.max(0, Math.round(result.latencyMs || 0)),
        error: pass ? null : code({ code: result.error }, 'CODEX_SELFCHECK_FAILED') };
      this.update({ executorReady: pass, lastSelfCheckAt: iso(), selfCheck: this.probeResult,
        selfCheckPaused, nextSelfCheckAt: selfCheckPaused ? null : new Date(this.nextSelfCheckAt).toISOString() });
      this.log('self-check', this.probeResult);
      if (selfCheckPaused) this.log('self-check-paused', { failures: this.selfCheckFailures });
    })().catch((error) => this.fatal(error)).finally(() => { this.probeFlight = null; });
  }

  async heartbeatLoop() {
    const { signal } = this.life;
    let intervalMs = 60_000;
    while (!signal.aborted) {
      let delay = intervalMs;
      const reported = this.probeResult;
      try {
        const body = await this.transport.heartbeat(reported ? { selfCheck: reported } : {});
        if (reported && this.probeResult === reported) this.probeResult = null;
        if (Number.isFinite(body.heartbeatIntervalSeconds) && body.heartbeatIntervalSeconds > 0) {
          intervalMs = Math.min(600, body.heartbeatIntervalSeconds) * 1000;
        }
        if (Number.isFinite(body.selfCheckIntervalSeconds) && body.selfCheckIntervalSeconds > 0) {
          this.selfCheckIntervalMs = Math.min(MAX_SELF_CHECK_INTERVAL_MS, body.selfCheckIntervalSeconds * 1000);
        }
        delay = intervalMs;
        this.update({
          phase: this.claims.signal.aborted ? 'draining' : 'online',
          queueDepth: body.queueDepth, lastHeartbeatAt: iso(), heartbeatError: null,
        });
        if ((!this.state.executorReady || body.selfCheckRequired === true) && this.probeResult === null) this.launchProbe();
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WorkerStopped) throw error;
        const reason = code(error, 'HEARTBEAT_FAILED');
        if (this.state.heartbeatError !== reason) this.log('heartbeat-retry', { reason });
        this.update({ phase: this.claims.signal.aborted ? 'draining' : 'reconnecting', heartbeatError: reason });
        delay = error.retryAfterMs ?? 5000;
      }
      await wait(delay, signal);
    }
  }

  async recoverPending() {
    const { signal } = this.claims;
    while (!signal.aborted) {
      if (!this.state.lastHeartbeatAt) {
        await wait(250, signal);
        continue;
      }
      const retired = this.journal.retireBefore(Date.now() - PENDING_RETENTION_MS);
      if (retired.length) {
        this.log('unconfirmed-receipts-retired', { count: retired.length, reason: 'LOCAL_RECEIPT_UNCONFIRMED_EXPIRED' });
        this.refreshPause();
        this.update({});
      }
      for (const id of this.recoveryAttempts.keys()) {
        if (!this.journal.pending.has(id)) this.recoveryAttempts.delete(id);
      }
      if (this.state.phase === 'online') {
        let remaining = RECOVERY_BATCH_SIZE;
        for (const [runId, pending] of this.journal.pending) {
          if (signal.aborted || remaining === 0) break;
          // A 409 from renew can also mean another Worker has a fresh lease.
          // Use only a still-live recorded lease, or wait for a fresh claim.
          if (pending.leaseExpireAt <= Date.now() || this.active.has(runId)) continue;
          const attempts = this.recoveryAttempts.get(runId) ?? 0;
          if (attempts >= MAX_RECOVERY_ATTEMPTS) continue;
          this.recoveryAttempts.set(runId, attempts + 1);
          remaining -= 1;
          await this.runTask({ runId, leaseExpireAt: pending.leaseExpireAt }, pending.leaseWindowMs, { recovery: true });
        }
      }
      await wait(RECOVERY_INTERVAL_MS, signal);
    }
  }

  async claimLoop() {
    const { signal } = this.claims;
    while (!signal.aborted) {
      this.refreshPause();
      if (!this.state.executorReady || this.state.claimsPaused || this.state.phase !== 'online') {
        await wait(250, signal);
        continue;
      }
      // Reserve a journal slot for each open poll and each execution which
      // has yet to persist a result. Parallel lanes share the same journal.
      const unstaged = [...this.active.keys()].filter(id => !this.journal.pending.has(id)).length;
      if (this.journal.pending.size + this.claimFlights.size + unstaged >= PENDING_LIMIT) {
        await wait(250, signal);
        continue;
      }
      let task;
      const flight = this.transport.claim(this.life.signal);
      this.claimFlights.add(flight);
      try {
        task = await flight;
      } catch (error) {
        this.claimFlights.delete(flight);
        if (signal.aborted) return;
        if (error instanceof WorkerStopped) throw error;
        const reason = code(error, 'CLAIM_FAILED');
        if (this.state.claimError !== reason) this.log('claim-retry', { reason });
        this.update({ claimError: reason });
        await wait(error.retryAfterMs ?? 5000, signal);
        continue;
      }
      this.claimFlights.delete(flight);
      if (!task) continue;
      // A successful claim racing with SIGTERM still owns a lease. Finish it
      // under the same drain budget; no new calls to claim follow.
      this.update({ lastClaimAt: iso(), claimError: null });
      await this.runTask(task);
    }
  }

  refreshPause() {
    const reason = this.usageMissing >= 3 ? 'THREE_EXECUTIONS_WITHOUT_USAGE'
      : this.journal.pending.size >= PENDING_LIMIT ? 'PENDING_JOURNAL_FULL' : null;
    if (reason === this.pauseReason) return;
    const previous = this.pauseReason;
    this.pauseReason = reason;
    if (reason) {
      this.update({ claimsPaused: true, pauseReason: reason, lastError: reason });
      this.log('claims-paused', { reason });
    } else if (previous) {
      this.update({ claimsPaused: false, pauseReason: null,
        ...(this.state.lastError === previous ? { lastError: null } : {}) });
      this.log('claims-resumed', { reason: previous });
    }
  }

  async runTask(task, recordedWindowMs, { recovery = false } = {}) {
    const { runId } = task;
    // A fresh Creator claim could race a recovery request. Retain the claim
    // until the current replay settles, then retry the same persisted bytes.
    while (this.active.has(runId)) {
      if (recovery) return;
      await this.active.get(runId);
    }
    if (this.life.signal.aborted || this.journal.completed.has(runId)) return;
    const flight = Promise.resolve().then(() => this.executeRun(task, recordedWindowMs, recovery));
    this.active.set(runId, flight);
    this.update({});
    try {
      await flight;
    } finally {
      this.active.delete(runId);
      this.refreshPause();
      this.update({});
    }
  }

  async executeRun(task, recordedWindowMs, recovery) {
    const { runId } = task;
    let expires = task.leaseExpireAt;
    const now = Date.now();
    if (expires <= now) return;
    const leaseWindowMs = Number.isSafeInteger(recordedWindowMs) && recordedWindowMs > 0
      ? recordedWindowMs : Math.min(300_000, expires - now);
    const lease = new AbortController();
    const signal = AbortSignal.any([lease.signal, this.life.signal]);
    let expiryTimer;
    const lose = (reason) => {
      if (signal.aborted) return;
      lease.abort();
      this.log('lease-lost', { runId, reason });
    };
    const armExpiry = () => {
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => lose('LEASE_EXPIRED'), Math.min(2_147_483_647, Math.max(0, expires - Date.now())));
    };
    armExpiry();
    const renew = (async () => {
      let retryMs = null;
      while (!signal.aborted) {
        await wait(retryMs ?? Math.max(50, Math.floor((expires - Date.now()) / 3)), signal);
        if (signal.aborted) break;
        const requestedAt = Date.now();
        if (requestedAt >= expires) {
          lose('LEASE_EXPIRED');
          break;
        }
        try {
          const result = await this.transport.renew(runId, signal);
          // Creator implementations may return just code=OK on renewal.
          // Bound the fallback by the observed initial lease window and use
          // the local send time (not the later receive time).
          const next = Number.isSafeInteger(result.leaseExpireAt)
            ? result.leaseExpireAt : requestedAt + leaseWindowMs;
          if (next <= Date.now()) {
            lose('LEASE_EXPIRED');
            break;
          }
          const previousLeaseExpireAt = expires;
          expires = next;
          armExpiry();
          if (this.journal.pending.has(runId)) this.journal.extend(runId, expires);
          this.log('lease-renewed', { runId, leaseExpireAt: expires, previousLeaseExpireAt,
            inferred: !Number.isSafeInteger(result.leaseExpireAt) });
          retryMs = null;
        } catch (error) {
          if (error instanceof WorkerStopped) throw error;
          if (error instanceof LeaseLost || signal.aborted) {
            lose(code(error, 'LEASE_LOST'));
            break;
          }
          if (Number.isFinite(error?.retryAfterMs)) retryMs = error.retryAfterMs;
          else if (code(error, '') === 'JOURNAL_WRITE_FAILED') throw error;
          else retryMs = 1000;
        }
      }
    })().catch((error) => this.fatal(error));

    try {
      let pending = this.journal.pending.get(runId);
      if (!pending) {
        let envelope;
        let reason = null;
        this.log('claimed', { runId });
        try {
          ({ envelope } = await this.executor.execute({ connection: this.connection, task, signal }));
          this.usageMissing = 0;
        } catch (error) {
          if (signal.aborted) return;
          reason = code(error, 'CODEX_EXECUTION_FAILED');
          const measuredUsage = error?.usage;
          const usageGap = !measuredUsage || ['RUNTIME_USAGE_MISSING', 'RUNTIME_USAGE_INVALID'].includes(reason);
          this.usageMissing = usageGap ? this.usageMissing + 1 : 0;
          if (['CODEX_START_FAILED', 'CODEX_PROFILE_REQUIRED'].includes(reason)) {
            this.update({ executorReady: false, lastError: reason });
          }
          this.refreshPause();
          ({ envelope } = buildFailureEnvelope(this.connection.positionType, {
            language: resultLanguage(task, this.config.language), reason, runId, measuredUsage,
          }));
          this.log('executor-failed', { runId, reason });
        }
        if (signal.aborted || expires <= Date.now()) return;
        pending = { bytes: JSON.stringify(envelope), leaseExpireAt: expires, leaseWindowMs, failure: reason !== null };
        // If this throws, stop the binding. Never transmit an unjournaled result.
        this.journal.stage(runId, pending);
      } else {
        this.journal.extend(runId, expires);
        this.log('replaying', { runId });
      }
      let receipt;
      try {
        if (signal.aborted || expires <= Date.now()) return;
        // The result can commit immediately before a concurrent renew sees
        // 409. Read an in-flight receipt to its HTTP deadline; no fresh
        // attempt should be started after expiry or loss of ownership.
        receipt = await this.transport.complete(runId, pending.bytes, {
          signal: this.life.signal,
          retrySignal: signal,
          leaseDeadline: () => expires,
          maxAttempts: recovery ? 1 : undefined,
        });
      } catch (error) {
        if (error instanceof WorkerStopped) throw error;
        if (error instanceof LeaseLost && error.code === 'BOUND_RUN_NOT_FOUND') {
          const result = { accepted: false, runStatus: error.code, failureReported: pending.failure, finishedAt: iso() };
          this.journal.settle(runId, result);
          this.update({ lastResult: { runId, ...result } });
          this.log('run-not-found', { runId });
        } else {
          this.log('delivery-unconfirmed', { runId, reason: code(error, 'DELIVERY_UNCONFIRMED') });
        }
        return;
      }
      // Never copy free-text model/provider/receipt messages into logs or status.
      const result = {
        accepted: receipt.accepted,
        runStatus: /^[A-Z0-9_]{1,64}$/.test(receipt.runStatus ?? '') ? receipt.runStatus : null,
        failureReported: pending.failure,
        finishedAt: iso(),
      };
      this.journal.settle(runId, result);
      this.update({ lastResult: { runId, ...result } });
      this.log('receipt', { runId, ...result });
    } finally {
      lease.abort();
      clearTimeout(expiryTimer);
      await renew;
    }
  }
}
