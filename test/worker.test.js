import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RunJournal } from '../plugins/codex-mota-executor/lib/store.js';
import { PullTransport } from '../plugins/codex-mota-executor/lib/transport.js';
import { MotaWorker, PENDING_RETENTION_MS } from '../plugins/codex-mota-executor/lib/worker.js';

const TOKEN = 'mpk_fake_worker_test';
const WORKER_ID = 'test-worker';
const RUN_ID = 'test-run';
const envelope = {
  payload_result: { assessments: [] },
  payload_info: '测试。',
  contract_version: 'V2',
  usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
};

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

function heartbeat(res, extra = {}) {
  json(res, 200, { queueDepth: 0, heartbeatIntervalSeconds: 0.05, selfCheckIntervalSeconds: 0.25, ...extra });
}

function claim(res, leaseMs = 10_000) {
  json(res, 200, { runId: RUN_ID, leaseExpireAt: Date.now() + leaseMs });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, description, timeoutMs = 3500) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

function memoryJournal() {
  return {
    pending: new Map(),
    completed: new Map(),
    stage(runId, pending) { this.pending.set(runId, pending); },
    extend(runId, leaseExpireAt) { Object.assign(this.pending.get(runId), { leaseExpireAt }); },
    retireBefore() { return []; },
    settle(runId, receipt) {
      this.pending.delete(runId);
      this.completed.set(runId, receipt);
    },
  };
}

async function rig(t, handlers = {}) {
  const workers = [];
  const requests = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const action = url.pathname.split('/').at(-1);
      assert.equal(req.method, 'POST');
      assert.ok(['heartbeat', 'claim', 'renew', 'complete'].includes(action));
      assert.equal(url.searchParams.get('token'), TOKEN);
      assert.equal(url.searchParams.get('workerId'), action === 'complete' ? null : WORKER_ID);
      assert.equal(req.headers.authorization, undefined);
      if (action === 'renew' || action === 'complete') {
        assert.equal(req.headers['x-mota-run-id'], RUN_ID);
      }
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      requests.push({ action, bytes });
      if (handlers[action]) await handlers[action](res, requests);
      else if (action === 'heartbeat') heartbeat(res);
      else if (action === 'complete') json(res, 200, { code: 'OK', accepted: true, runStatus: 'SUCCEEDED' });
      else if (action === 'renew') json(res, 200, { leaseExpireAt: Date.now() + 10_000 });
      else {
        await delay(25);
        res.writeHead(204).end();
      }
    } catch (error) {
      if (req.destroyed && error.code === 'ECONNRESET') return;
      errors.push(error);
      if (!res.headersSent) json(res, 500, { code: 'FAKE_QUEUE_ERROR' });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await Promise.all(workers.map(({ worker }) => worker.stop({ graceMs: 50 })));
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    assert.deepEqual(errors, []);
  });

  const queueUrl = `http://127.0.0.1:${server.address().port}/publics/bound/queue/test`;

  function start({ executor = {}, journal = memoryJournal() } = {}) {
    const statuses = [];
    const logs = [];
    const worker = new MotaWorker({
      config: { allowInsecureLoopback: true, concurrency: 1 },
      connection: {
        queueUrl,
        token: TOKEN, workerId: WORKER_ID, agentCode: 'test-agent', positionType: 'FUNDAMENTAL_ANALYST',
      },
      executor: {
        ready: () => ({ ok: true }),
        probe: async () => ({ pass: true, latencyMs: 5 }),
        execute: async () => ({ envelope }),
        ...executor,
      },
      journal,
      onStatus: (status) => statuses.push(status),
      onLog: (entry) => logs.push(entry),
    });
    const done = worker.start();
    const instance = { worker, statuses, logs, done };
    workers.push(instance);
    return instance;
  }

  return { start, queueUrl, requests, calls: (action) => requests.filter((req) => req.action === action) };
}

test('heartbeats continue during a delayed probe and claims wait until a probe passes', async (t) => {
  const first = deferred();
  const retry = deferred();
  t.after(() => { first.resolve({ pass: false }); retry.resolve({ pass: false }); });
  let probes = 0;
  const queue = await rig(t);
  const worker = queue.start({
    executor: { probe: () => [first, retry][probes++].promise },
  });
  await until(() => probes === 1 && queue.calls('heartbeat').length >= 3, 'heartbeats during the first probe');
  assert.equal(queue.calls('claim').length, 0);
  first.resolve({ pass: false, latencyMs: 10 });
  await until(() => probes === 2 && queue.calls('heartbeat').some((req) => JSON.parse(req.bytes).selfCheck?.pass === false), 'failed report and retry');
  assert.equal(queue.calls('claim').length, 0);
  retry.resolve({ pass: true, latencyMs: 15 });
  await until(
    () => queue.calls('claim').length > 0 &&
      queue.calls('heartbeat').some((req) => JSON.parse(req.bytes).selfCheck?.pass === true),
    'claims and report after the successful probe',
  );
  assert.ok(worker.statuses.some((status) => status.executorReady === true));
});

test('failed self-check uses the advertised retry interval and stops after three failures', async (t) => {
  const queue = await rig(t);
  const probes = [];
  const { statuses, logs } = queue.start({
    executor: {
      async probe() {
        probes.push(performance.now());
        return { pass: false, latencyMs: 5 };
      },
    },
  });
  await until(() => statuses.at(-1).selfCheckPaused === true, 'self-check failure budget exhausted');
  assert.equal(probes.length, 3);
  assert.ok(probes[1] - probes[0] >= 240);
  assert.ok(probes[2] - probes[1] >= 490);
  assert.equal(logs.at(-1).event, 'self-check-paused');
  const heartbeatCount = queue.calls('heartbeat').length;
  await until(() => queue.calls('heartbeat').length >= heartbeatCount + 3, 'heartbeats after the self-check limit');
  assert.equal(probes.length, 3);
  assert.equal(queue.calls('claim').length, 0);
});

test('a retryable initial heartbeat failure recovers and starts claiming', async (t) => {
  let heartbeats = 0;
  const queue = await rig(t, {
    heartbeat(res) {
      if (heartbeats++ === 0) return json(res, 503, { code: 'TEMPORARY' }, { 'retry-after': '1' });
      heartbeat(res);
    },
  });
  const { statuses } = queue.start();
  await until(() => statuses.some((status) => status.phase === 'reconnecting'), 'reconnect state');
  assert.equal(queue.calls('claim').length, 0);
  await until(() => queue.calls('claim').length > 0, 'claims after heartbeat recovery');
  assert.ok(statuses.some((status) => status.phase === 'online'));
});

test('completion retries and restart replay exact durable bytes without re-execution', async (t) => {
  const journal = memoryJournal();
  let claims = 0;
  let completions = 0;
  let executes = 0;
  let acceptCompletion = false;
  const queue = await rig(t, {
    async claim(res) {
      if (claims++ === 0) return claim(res);
      await delay(25);
      res.writeHead(204).end();
    },
    complete(res) {
      completions += 1;
      if (!acceptCompletion) return json(res, 503, { code: 'TEMPORARY' }, { 'retry-after': '1' });
      json(res, 200, { code: 'OK', accepted: true, runStatus: 'SUCCEEDED' });
    },
  });
  const executor = { execute: async () => { executes += 1; return { envelope }; } };
  const first = queue.start({ executor, journal });
  await until(() => completions >= 2, 'byte-identical HTTP retry');
  const submitted = queue.calls('complete').map(({ bytes }) => bytes);
  assert.deepEqual(submitted, [JSON.stringify(envelope), JSON.stringify(envelope)]);
  await first.worker.stop({ graceMs: 50 });
  assert.equal(journal.pending.get(RUN_ID).bytes, submitted[0]);
  assert.equal(journal.completed.has(RUN_ID), false);
  acceptCompletion = true;
  queue.start({ executor, journal });
  await until(() => journal.completed.has(RUN_ID), 'replayed completion receipt');
  assert.equal(executes, 1);
  assert.equal(journal.pending.size, 0);
  assert.equal(queue.calls('complete').at(-1).bytes, submitted[0]);
});

test('a renewal conflict aborts the executor and sends no completion', async (t) => {
  let claims = 0;
  let started = false;
  let aborted = false;
  const queue = await rig(t, {
    async claim(res) {
      if (claims++ === 0) return claim(res, 700);
      await delay(25);
      res.writeHead(204).end();
    },
    renew: (res) => json(res, 409, { code: 'BOUND_CLAIM_CONFLICT' }),
  });
  const journal = memoryJournal();
  queue.start({
    journal,
    executor: {
      async execute({ signal }) {
        started = true;
        await once(signal, 'abort');
        aborted = true;
        throw new Error('cancelled');
      },
    },
  });
  await until(() => aborted, 'executor abort after renewal conflict');
  assert.ok(started);
  assert.equal(queue.calls('renew').length, 1);
  assert.equal(queue.calls('complete').length, 0);
  assert.equal(journal.pending.size, 0);
});

test('a renewal conflict cannot discard the successful receipt of an already-sent completion', async (t) => {
  const renewed = deferred();
  let claims = 0;
  const queue = await rig(t, {
    async claim(res) {
      if (claims++ === 0) return claim(res, 700);
      await delay(25);
      res.writeHead(204).end();
    },
    async complete(res) {
      await renewed.promise;
      await delay(50);
      json(res, 200, { code: 'OK', accepted: true, runStatus: 'SUCCEEDED' });
    },
    renew(res) {
      json(res, 409, { code: 'BOUND_CLAIM_CONFLICT' });
      renewed.resolve();
    },
  });
  const journal = memoryJournal();
  queue.start({ journal });
  await until(() => journal.completed.has(RUN_ID), 'receipt after concurrent renew conflict');
  assert.equal(journal.completed.get(RUN_ID).accepted, true);
  assert.equal(queue.calls('complete').length, 1);
});

test('completion retries check the current deadline even before the expiry signal aborts', async (t) => {
  let leaseDeadline = Date.now() + 60_000;
  const queue = await rig(t, {
    complete(res) {
      leaseDeadline = Date.now();
      json(res, 503, { code: 'TEMPORARY' }, { 'retry-after': '1' });
    },
  });
  const lease = new AbortController();
  const transport = new PullTransport({
    queueUrl: queue.queueUrl,
    token: TOKEN,
    workerId: WORKER_ID,
    allowInsecureLoopback: true,
  });
  await assert.rejects(
    transport.complete(RUN_ID, JSON.stringify(envelope), {
      maxAttempts: 2,
      retrySignal: lease.signal,
      leaseDeadline: () => leaseDeadline,
    }),
    { code: 'COMPLETION_LEASE_EXPIRED' },
  );
  assert.equal(lease.signal.aborted, false);
  assert.equal(queue.calls('complete').length, 1);
});

test('an OK renew receipt without a structured expiry preserves the lease', async (t) => {
  const leaseMs = 750;
  let claims = 0;
  let firstExpiry = 0;
  const queue = await rig(t, {
    async claim(res) {
      if (claims++ === 0) {
        firstExpiry = Date.now() + leaseMs;
        return json(res, 200, { runId: RUN_ID, leaseExpireAt: firstExpiry });
      }
      await delay(25);
      res.writeHead(204).end();
    },
    renew: (res) => json(res, 200, { code: 'OK', message: '续租成功' }),
  });
  const journal = memoryJournal();
  let emittedAfterOriginalExpiry = false;
  queue.start({
    journal,
    executor: {
      async execute({ signal }) {
        await delay(leaseMs + 100, undefined, { signal });
        emittedAfterOriginalExpiry = Date.now() > firstExpiry;
        return { envelope };
      },
    },
  });
  await until(() => journal.completed.has(RUN_ID), 'delivery after the original claim lease');
  assert.equal(emittedAfterOriginalExpiry, true);
  assert.ok(queue.calls('renew').length >= 1);
  assert.equal(queue.calls('complete').length, 1);
});

test('stop drains an active task and keeps heartbeats while stopping new claims', async (t) => {
  const finish = deferred();
  t.after(() => finish.resolve({ envelope }));
  let claims = 0;
  let started = false;
  const queue = await rig(t, {
    async claim(res) {
      if (claims++ === 0) return claim(res);
      await delay(25);
      res.writeHead(204).end();
    },
  });
  const journal = memoryJournal();
  const { worker, statuses } = queue.start({
    journal,
    executor: { execute: () => { started = true; return finish.promise; } },
  });
  await until(() => started, 'active task');
  const heartbeatCount = queue.calls('heartbeat').length;
  const stopped = worker.stop();
  await until(() => queue.calls('heartbeat').length > heartbeatCount, 'heartbeat while draining');
  assert.equal(statuses.at(-1).phase, 'draining');
  assert.equal(queue.calls('claim').length, 1);
  finish.resolve({ envelope });
  await stopped;
  assert.equal(statuses.at(-1).phase, 'stopped');
  assert.equal(queue.calls('claim').length, 1);
  assert.equal(journal.completed.get(RUN_ID).accepted, true);
});

test('stop accepts the lease returned by an in-flight claim and opens no further poll', async (t) => {
  const releaseClaim = deferred();
  let claims = 0;
  const queue = await rig(t, {
    async claim(res) {
      claims += 1;
      if (claims !== 1) return res.writeHead(204).end();
      await Promise.race([releaseClaim.promise, delay(600)]);
      claim(res);
    },
  });
  const journal = memoryJournal();
  let executions = 0;
  const { worker } = queue.start({
    journal,
    executor: { execute: async () => { executions += 1; return { envelope }; } },
  });
  await until(() => queue.calls('claim').length === 1, 'open long poll');
  const stopped = worker.stop({ graceMs: 50 });
  await delay(100);
  assert.equal(executions, 0);
  releaseClaim.resolve();
  await stopped;
  assert.equal(executions, 1);
  assert.equal(queue.calls('claim').length, 1);
  assert.equal(journal.completed.get(RUN_ID).accepted, true);
});

test('expired durable result waits for a fresh claim before replaying its bytes', async (t) => {
  let allowClaim = false;
  const queue = await rig(t, {
    async claim(res) {
      if (allowClaim) {
        allowClaim = false;
        return claim(res);
      }
      await delay(25);
      res.writeHead(204).end();
    },
  });
  const journal = memoryJournal();
  const bytes = JSON.stringify(envelope);
  journal.stage(RUN_ID, { bytes, leaseExpireAt: Date.now() - 1000 });
  queue.start({
    journal,
    executor: { execute: async () => { assert.fail('Durable output must not be recomputed'); } },
  });
  await until(() => queue.calls('claim').length >= 2, 'polls without a lease for the pending run');
  assert.equal(queue.calls('complete').length, 0);
  allowClaim = true;
  await until(() => journal.completed.has(RUN_ID), 'receipt on the freshly claimed lease');
  assert.equal(journal.completed.get(RUN_ID).accepted, true);
  assert.deepEqual(queue.calls('complete').map(request => request.bytes), [bytes]);
});

test('a full journal of stale unconfirmed receipts is retired without claiming old outcomes succeeded', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mota-worker-stale-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const connection = { queueUrl: 'https://example.test/publics/bound/queue/test', workerId: WORKER_ID,
    agentCode: 'test-agent', positionType: 'FUNDAMENTAL_ANALYST' };
  const journal = new RunJournal(directory, connection);
  const stale = { bytes: JSON.stringify(envelope), leaseExpireAt: Date.now() - PENDING_RETENTION_MS - 1000 };
  journal.commit(new Map(Array.from({ length: 1000 }, (_, i) => [`stale-${i}`, stale])), new Map());
  const queue = await rig(t);
  const { logs, statuses } = queue.start({ journal });
  await until(() => queue.calls('claim').length > 0, 'claims resume after journal retirement');
  assert.equal(queue.calls('complete').length, 0);
  assert.equal(statuses.at(-1).claimsPaused, false);
  assert.ok(logs.some(entry => entry.event === 'unconfirmed-receipts-retired' && entry.count === 1000));
  const restored = new RunJournal(directory, connection);
  assert.equal(restored.pending.size, 0);
  assert.equal(restored.completed.size, 1000);
  assert.equal(restored.completed.get('stale-999').accepted, null);
  assert.equal(restored.completed.get('stale-999').runStatus, 'LOCAL_RECEIPT_UNCONFIRMED_EXPIRED');
});

test('an HTTP auth rejection blocks the worker even when its response is plain text', async (t) => {
  const queue = await rig(t, {
    heartbeat: (res) => res.writeHead(401).end('Unauthorized'),
  });
  const { statuses, logs } = queue.start();
  await until(() => statuses.at(-1).phase === 'blocked', 'auth blocked status', 1000);
  assert.equal(statuses.at(-1).lastError, 'AGENT_TOKEN_UNAUTHORIZED');
  assert.equal(queue.calls('heartbeat').length, 1);
  assert.equal(queue.calls('claim').length, 0);
  assert.equal(logs.at(-1).event, 'worker-blocked');
});
