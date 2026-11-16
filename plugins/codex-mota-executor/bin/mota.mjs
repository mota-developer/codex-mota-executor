#!/usr/bin/env node
import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { normalizeConnection, parseBindingText } from '../lib/connection.js';
import { TaskExecutor } from '../lib/executor.js';
import { Service } from '../lib/service.js';
import { defaultDataDir, lockFile, privateDirectory, readConfig, readJSON, RunJournal,
  updateConfig, writeJSON } from '../lib/store.js';
import { MotaWorker } from '../lib/worker.js';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const print = (value) => console.log(JSON.stringify(value, null, 2));
const safeCode = (value, fallback) => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value)
  ? value : fallback;

const help = `MoTA Creator Pull Worker for Codex (macOS)
  bind --file /absolute/bundle [--codex-bin /absolute/codex] [--codex-home /absolute/auth-dir]
       [--model MODEL] [--reasoning-effort EFFORT] [--concurrency 1-8] [--timeout 30-1800]
       [--language zh|en]
  check [agentCode]
  enable <agentCode> | disable <agentCode>
  status | logs [--lines 1-200]
  start | stop | restart | run
  Add --data-dir /absolute/path to use a separate instance.
  New bindings are disabled. Config changes apply on the next start/restart.`;

function absolute(path, label) {
  if (!isAbsolute(path ?? '') || /[\u0000-\u001f]/u.test(path)) throw new Error(`${label} 必须是绝对路径`);
  return resolve(path);
}

function integer(raw, min, max, label) {
  const n = Number(raw);
  if (!/^\d+$/.test(raw ?? '') || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${label} 必须是 ${min}–${max} 的整数`);
  }
  return n;
}

function executable(path) {
  if (path) {
    const full = absolute(path, 'Codex 路径');
    try {
      accessSync(full, constants.X_OK);
      if (statSync(full).isFile()) return full;
    } catch {}
    throw new Error('指定的 Codex CLI 不可执行');
  }
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const full = join(dir, 'codex');
    try { accessSync(full, constants.X_OK); if (statSync(full).isFile()) return full; } catch {}
  }
  throw new Error('未找到 Codex CLI：请安装或用 --codex-bin 指定');
}

function readBundle(path) {
  const fd = openSync(absolute(path, '绑定文件'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 65_536) {
      throw new Error('绑定文件须为当前用户的私有普通文件（chmod 600），且大小不超过 64 KiB');
    }
    const raw = readFileSync(fd, 'utf8').trim();
    if (raw.startsWith('{')) {
      try { return JSON.parse(raw); } catch { throw new Error('Creator 绑定文件不是有效的 JSON'); }
    }
    const { found, missing } = parseBindingText(raw);
    if (missing.length) throw new Error(`Creator 绑定信息缺少：${missing.join(', ')}`);
    return found;
  } finally {
    closeSync(fd);
  }
}

function describe(agent) {
  return {
    agentCode: agent.agentCode, queueUrl: agent.queueUrl, positionType: agent.positionType,
    workerId: agent.workerId, enabled: agent.enabled, model: agent.model ?? null,
    concurrency: agent.concurrency, codexHome: agent.codexHome,
  };
}

function readLogs(dir, lines) {
  let fd;
  try {
    fd = openSync(join(dir, 'worker.log'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Worker 日志不是普通文件');
    const length = Math.min(256_000, stat.size);
    const offset = stat.size - length;
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    const found = buffer.toString('utf8', 0, read).trimEnd().split('\n');
    if (offset) found.shift();
    return found.slice(-lines).join('\n');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function run(dir) {
  const release = lockFile(join(dir, 'worker.lock'));
  if (!release) throw new Error('该数据目录已有 Worker 正在运行');
  const statusPath = join(dir, 'status.json');
  const journalDir = privateDirectory(join(dir, 'runs'));
  const runningAt = new Date().toISOString();
  const state = Object.create(null);
  const runtimeRelease = process.env.MOTA_WORKER_RELEASE ?? null;
  let processPhase = 'starting';
  const writeStatus = () => writeJSON(statusPath, {
    pid: process.pid, processPhase, runningAt, runtimeRelease, agents: state,
  });
  const log = (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const workers = [];
  try {
    const config = readConfig(dir);
    writeStatus();
    for (const agent of config.agents.filter((candidate) => candidate.enabled)) {
      try {
        const executor = new TaskExecutor({ config: agent });
        const worker = new MotaWorker({ config: agent, connection: agent, executor,
          journal: new RunJournal(journalDir, agent),
          onStatus: (value) => {
            state[agent.agentCode] = value;
            // Journal errors are fatal, but status is telemetry only. Leaving a
            // stale status snapshot should never change the queue outcome.
            try { writeStatus(); } catch {}
          }, onLog: log });
        workers.push(worker);
        void worker.start();
      } catch (error) {
        const reason = safeCode(error?.code, 'WORKER_SETUP_FAILED');
        state[agent.agentCode] = { phase: 'blocked', lastError: reason };
        log({ agentCode: agent.agentCode, event: 'worker-blocked', reason });
      }
    }
    processPhase = 'running';
    writeStatus();
    log({ event: 'daemon-started', pid: process.pid, agents: workers.length });
    // Don't crash-loop on credential revocation or when all bindings are disabled.
    if (!controller.signal.aborted) {
      const keepAlive = setInterval(() => {}, 60_000);
      try { await new Promise((done) => controller.signal.addEventListener('abort', done, { once: true })); }
      finally { clearInterval(keepAlive); }
    }
  } finally {
    processPhase = 'draining';
    try {
      await Promise.all(workers.map((worker) => worker.stop()));
      processPhase = 'stopped';
      writeStatus();
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      release();
    }
  }
  log({ event: 'daemon-stopped', pid: process.pid });
}

const common = { 'data-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' } };
const commandOptions = {
  bind: {
    file: { type: 'string' }, 'codex-bin': { type: 'string' }, 'codex-home': { type: 'string' },
    model: { type: 'string' }, 'reasoning-effort': { type: 'string' }, language: { type: 'string' },
    concurrency: { type: 'string' }, timeout: { type: 'string' },
  },
  logs: { lines: { type: 'string' } },
  enable: {}, disable: {}, check: {}, status: {}, start: {}, stop: {}, restart: {}, run: {},
};

async function main(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) return console.log(help);
  const [command, ...rest] = argv;
  if (!Object.hasOwn(commandOptions, command)) throw new Error('命令不受支持，请运行 --help');
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
      ...common, ...commandOptions[command],
    } }));
  } catch { throw new Error('参数无效，请运行 --help'); }
  if (values.help) return console.log(help);
  const required = ['enable', 'disable'].includes(command);
  if (positionals.length > (required || command === 'check' ? 1 : 0) || (required && positionals.length !== 1)) {
    throw new Error('参数无效，请运行 --help');
  }
  const dir = values['data-dir'] ? absolute(values['data-dir'], '--data-dir') : defaultDataDir();
  const exists = existsSync(dir);
  if (exists || !['status', 'logs', 'stop', 'check'].includes(command)) privateDirectory(dir);
  const service = new Service({ dataDir: dir, pluginRoot });

  if (command === 'bind') {
    if (!values.file) throw new Error('请用 --file 指定 Creator 绑定文件的绝对路径');
    const input = readBundle(values.file);
    const connection = normalizeConnection(input);
    const saved = updateConfig(dir, (config) => {
      const existing = config.agents.find((agent) => agent.agentCode === connection.agentCode);
      if (existing && (existing.queueUrl !== connection.queueUrl || existing.positionType !== connection.positionType ||
          (input.workerId && existing.workerId !== connection.workerId))) {
        throw new Error('该 Agent Code 已绑定不同的队列、岗位或 Worker ID，请为不同身份使用独立数据目录');
      }
      if (values.model && !/^[A-Za-z0-9._:-]{1,128}$/.test(values.model)) throw new Error('模型名称无效');
      if (values['reasoning-effort'] && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(values['reasoning-effort'])) {
        throw new Error('reasoning effort 参数无效');
      }
      if (values.language && !['zh', 'en'].includes(values.language)) throw new Error('语言必须是 zh 或 en');
      const authPath = values['codex-home']
        ? absolute(values['codex-home'], '--codex-home') : existing?.codexHome ?? join(dir, 'codex-auth');
      if (authPath === join(dir, 'runs') || authPath === dir) throw new Error('Codex 登录目录必须单独设置');
      const agent = {
        ...connection, workerId: existing?.workerId ?? connection.workerId, enabled: existing?.enabled ?? false,
        codexHome: privateDirectory(authPath),
        codexPath: executable(values['codex-bin'] ?? existing?.codexPath),
        model: values.model ?? existing?.model,
        language: values.language ?? existing?.language ?? 'zh',
        reasoningEffort: values['reasoning-effort'] ?? existing?.reasoningEffort,
        taskTimeoutSeconds: values.timeout ? integer(values.timeout, 30, 1800, 'timeout')
          : existing?.taskTimeoutSeconds ?? 600,
        concurrency: values.concurrency ? integer(values.concurrency, 1, 8, 'concurrency')
          : existing?.concurrency ?? 1,
      };
      config.agents = [...config.agents.filter((item) => item.agentCode !== agent.agentCode), agent];
      return describe(agent);
    });
    return print({ ...saved, appliesOnNextStart: true });
  }

  if (command === 'status') {
    const observed = readJSON(join(dir, 'status.json'), null);
    let alive = false;
    if (Number.isInteger(observed?.pid) && observed.processPhase !== 'stopped') {
      try { process.kill(observed.pid, 0); alive = true; } catch {}
    }
    return print({ service: await service.status(), dataDir: dir,
      worker: alive ? observed : observed ? { ...observed, processPhase: 'stopped' } : null,
      bindings: readConfig(dir).agents.map(describe) });
  }
  if (command === 'logs') return console.log(readLogs(dir, values.lines ? integer(values.lines, 1, 200, 'lines') : 30));
  if (command === 'run') return run(dir);
  if (required) {
    const binding = updateConfig(dir, (config) => {
      const agent = config.agents.find(({ agentCode }) => agentCode === positionals[0]);
      if (!agent) throw new Error('未找到该 Agent，请先 bind');
      agent.enabled = command === 'enable';
      return describe(agent);
    });
    return print({ ...binding, appliesOnNextStart: true });
  }
  if (command === 'check') {
    const agents = readConfig(dir).agents.filter(({ agentCode }) => !positionals.length || agentCode === positionals[0]);
    if (!agents.length) throw new Error('没有需要检查的 Agent，请先 bind');
    const results = [];
    for (const agent of agents) {
      const executor = new TaskExecutor({ config: agent });
      const readiness = executor.ready();
      const result = readiness.ok ? await executor.probe({ connection: agent }) : { pass: false, error: readiness.reason };
      results.push({ agentCode: agent.agentCode, pass: result.pass,
        latencyMs: result.latencyMs ?? null, usage: result.usage ?? null,
        error: result.pass ? null : safeCode(result.error, 'CODEX_SELFCHECK_FAILED') });
    }
    print(results);
    if (results.some((result) => !result.pass)) process.exitCode = 1;
    return;
  }
  if (command === 'stop' && !exists) return print(await service.stop());
  const release = lockFile(join(dir, 'service.lock'));
  if (!release) throw new Error('已有另一条命令正在操作服务，请重试');
  try {
    if (command !== 'stop' && !readConfig(dir).agents.some((agent) => agent.enabled)) {
      if (command === 'restart' && (await service.status()).loaded) return print(await service.stop());
      throw new Error('没有已启用的 Agent，请先 bind 和 enable');
    }
    print(await service[command]());
  } finally { release(); }
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('MoTA Executor 需要 Node.js 22 或更新版本');
  process.exitCode = 1;
} else {
  main(process.argv.slice(2)).catch((error) => {
    // Never render input text or command stderr. The only argv with secrets is
    // a local file path; its contents stay in this process.
    console.error(String(error?.message ?? 'MoTA command failed').replace(/mpk_[a-z0-9]+/gi, '[REDACTED]'));
    process.exitCode = 1;
  });
}
