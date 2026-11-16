import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { Service } from '../plugins/codex-mota-executor/lib/service.js';
import { RunJournal } from '../plugins/codex-mota-executor/lib/store.js';

const cli = resolve('plugins/codex-mota-executor/bin/mota.mjs');
const exec = promisify(execFile);
const token = 'mpk_fixtureNeverPrint987';
const agentCode = 'AGENT-fixture';
const positionType = 'FUNDAMENTAL_ANALYST';
const bundle = (queueUrl) => `Agent Code：${agentCode}\n岗位：${positionType}\nQueue URL：${queueUrl}\nAgent Token（BOUND_PULL）：${token}\n`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mota-cli-integration-'));
  const dataDir = join(root, 'data');
  const bundlePath = join(root, 'Creator receipt.txt');
  t.after(() => rm(root, { recursive: true, force: true }));
  const invoke = async (...args) => {
    const result = await exec(process.execPath, [cli, ...args, '--data-dir', dataDir]);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
    return JSON.parse(result.stdout);
  };
  return { root, dataDir, bundlePath, invoke };
}

test('binding persists private credentials and a stable worker ID without enabling or leaking it', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const { dataDir, bundlePath, invoke } = await fixture(t);
  const queue = 'https://creator.example/publics/bound/queue/' + agentCode;
  await writeFile(bundlePath, bundle(queue), { mode: 0o600 });
  const binding = await invoke('bind', '--file', bundlePath, '--codex-bin', process.execPath);
  assert.equal(binding.enabled, false);
  assert.equal(binding.codexHome, join(dataDir, 'codex-auth'));
  assert.equal(binding.appliesOnNextStart, true);
  const saved = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')).agents[0];
  assert.equal(saved.token, token);
  assert.equal((await stat(join(dataDir, 'config.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(binding.codexHome)).mode & 0o777, 0o700);
  assert.equal((await invoke('bind', '--file', bundlePath)).workerId, binding.workerId);
  assert.equal((await invoke('enable', agentCode)).enabled, true);
  assert.equal((await invoke('disable', agentCode)).enabled, false);
  await assert.rejects(invoke('start'), (error) => !error.stderr.includes(token) && /没有已启用/.test(error.stderr));
});

test('the real launchd daemon starts the packaged runner and completes a fake Creator probe', {
  skip: process.platform !== 'darwin' || process.env.MOTA_TEST_LAUNCHD !== '1',
}, async (t) => {
  const { root, dataDir, bundlePath, invoke } = await fixture(t);
  const codexPath = join(root, 'fixture-codex');
  await writeFile(codexPath, `#!/usr/bin/env node
require('node:fs').readFileSync(0);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({
  payload_result:{assessments:[],summary:'Synthetic task'}, payload_info:'No observed symbol',
})}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:24,output_tokens:7}}));
`, { mode: 0o700 });
  await writeFile(bundlePath, bundle('https://creator.example/publics/bound/queue/' + agentCode), { mode: 0o600 });
  await invoke('bind', '--file', bundlePath, '--codex-bin', codexPath);
  const checks = await invoke('check', agentCode);
  assert.equal(checks[0].pass, true);
  assert.equal(checks[0].usage.totalTokens, 31);
  await invoke('enable', agentCode);
  const configPath = join(dataDir, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  let claimed = false;
  let completeCount = 0;
  let observed;
  let anyUnexpectedAuth = false;
  const runId = 'RUN-integration-probe';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const action = url.pathname.split('/').at(-1);
    if (url.searchParams.get('token') !== token || req.headers.authorization) anyUnexpectedAuth = true;
    const reply = (code, value) => {
      if (res.destroyed) return;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    };
    if (action === 'heartbeat') return reply(200, { queueDepth: claimed ? 0 : 1, heartbeatIntervalSeconds: 1 });
    if (action === 'claim' && !claimed) {
      claimed = true;
      return reply(200, { runId, agentCode, positionType, templateInputData: [], leaseExpireAt: Date.now() + 60_000 });
    }
    if (action === 'claim') { await setTimeout(50); return reply(204); }
    if (action === 'complete') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      completeCount += 1;
      const journal = new RunJournal(join(dataDir, 'runs'), config.agents[0]);
      observed = { runId: req.headers['x-mota-run-id'], bytes: Buffer.concat(chunks).toString(),
        staged: journal.pending.get(runId)?.bytes };
      return reply(200, { code: 'OK', accepted: true, runStatus: 'SUCCEEDED' });
    }
    return reply(404);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const launchAgentsDir = join(root, 'LaunchAgents');
  await mkdir(launchAgentsDir);
  const service = new Service({ dataDir, pluginRoot: resolve('plugins/codex-mota-executor'), launchAgentsDir });
  try {
    Object.assign(config.agents[0], {
      queueUrl: `http://127.0.0.1:${server.address().port}/publics/bound/queue/${agentCode}`,
      allowInsecureLoopback: true,
    });
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await service.start();
    const deadline = Date.now() + 15_000;
    let status;
    while (Date.now() < deadline) {
      status = (await invoke('status')).worker?.agents?.[agentCode];
      if (status?.lastResult?.accepted) break;
      await setTimeout(100);
    }
    assert.equal(status?.lastResult?.accepted, true);
    assert.equal(completeCount, 1);
    assert.equal(observed.runId, runId);
    assert.equal(observed.bytes, observed.staged);
    assert.equal(JSON.parse(observed.bytes).usage.totalTokens, 31);
    assert.equal(anyUnexpectedAuth, false);
    assert.equal((await service.stop()).loaded, false);
    assert.equal((await invoke('status')).worker.processPhase, 'stopped');
    const journal = new RunJournal(join(dataDir, 'runs'), config.agents[0]);
    assert.equal(journal.pending.size, 0);
    assert.equal(journal.completed.get(runId).accepted, true);
    const log = await readFile(join(dataDir, 'worker.log'), 'utf8');
    assert.match(log, /daemon-stopped/);
    assert.doesNotMatch(log, new RegExp(token));
  } finally {
    try { await service.stop(); } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }
});
