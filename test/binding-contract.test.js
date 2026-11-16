import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { normalizeConnection, parseBindingText } from '../plugins/codex-mota-executor/lib/connection.js';
import { TaskExecutor } from '../plugins/codex-mota-executor/lib/executor.js';
import { validateCompletion } from '../plugins/codex-mota-executor/lib/schema.js';

const binding = {
  token: 'mpk_activeSynthetic123',
  queueUrl: 'https://creator.example/publics/bound/queue/test-agent',
  agentCode: 'test-agent',
  positionType: 'FUNDAMENTAL_ANALYST',
};
const candidateToken = 'mpk_candidateSynthetic123';
const bindingInstruction = (tokenLine) => [
  'Agent Code: test-agent',
  `Queue URL: ${binding.queueUrl}`,
  'Position: FUNDAMENTAL_ANALYST',
  tokenLine,
].join('\n');

test('bind parser rejects Creator rotation text and ambiguous tokens without printing them', () => {
  const active = bindingInstruction(`Agent Token (BOUND_PULL): ${binding.token}`);
  assert.equal(parseBindingText(active).found.token, binding.token);

  for (const label of ['新 Agent Token（BOUND_PULL）：', 'New Agent Token (BOUND_PULL): ']) {
    const candidate = bindingInstruction(label + candidateToken);
    assert.throws(() => parseBindingText(candidate), (error) =>
      error.field === 'token' && /候选/.test(error.message) && !error.message.includes(candidateToken));
  }

  assert.throws(() => parseBindingText(`${active}\nAnother value: ${candidateToken}`), /多个不同/);
  assert.throws(() => normalizeConnection({ ...binding, token: candidateToken, tokenStatus: 'CANDIDATE' }), /候选/);
  assert.throws(() => normalizeConnection({ ...binding, candidate: { kind: 'WORKER_TOKEN' } }), /候选/);
});

test('a failed candidate rebind leaves the existing private config byte-for-byte unchanged', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mota-bind-rotation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../plugins/codex-mota-executor/bin/mota.mjs', import.meta.url));
  const dataDir = join(directory, 'data');
  const file = join(directory, 'instruction.txt');
  const invoke = (...args) => promisify(execFile)(process.execPath, [cli, ...args, '--data-dir', dataDir]);
  await writeFile(file, bindingInstruction(`Agent Token (BOUND_PULL): ${binding.token}`), { mode: 0o600 });
  await invoke('bind', '--file', file, '--codex-bin', process.execPath);
  await invoke('enable', binding.agentCode);
  const savedConfig = join(dataDir, 'config.json');
  const before = await readFile(savedConfig);
  await writeFile(file, bindingInstruction(`New Agent Token (BOUND_PULL): ${candidateToken}`));
  await assert.rejects(invoke('bind', '--file', file), (error) => /候选/.test(error.stderr) && !error.stderr.includes(candidateToken));
  assert.deepEqual(await readFile(savedConfig), before);
});

const positionType = 'PORTFOLIO_MANAGER';
const processResult = {
  decision_type: 'NO_ACTION',
  rationale: 'Maintain the synthetic allocation.',
  target_allocation: [{ symbol: 'MOTASIM', target_weight_pct: 50, reasoning: 'Synthetic holding is unchanged.' }],
};
const finalResult = {
  timestamp: '2026-01-02T15:00:00Z',
  orders: [],
  report_markdown: 'No orders for the synthetic portfolio.',
};
const envelope = (payload_result) => ({
  payload_result, payload_info: 'Synthetic test', contract_version: 'V2',
  usage: { totalTokens: 15, promptTokens: 10, completionTokens: 5, status: 'FINAL', estimated: false },
});

test('portfolio result follows explicit Creator isFinal and accepts either branch when omitted', () => {
  assert.equal(validateCompletion(positionType, envelope(processResult), { isFinal: false }).ok, true);
  assert.equal(validateCompletion(positionType, envelope(finalResult), { isFinal: false }).ok, false);
  assert.equal(validateCompletion(positionType, envelope(finalResult), { isFinal: true }).ok, true);
  assert.equal(validateCompletion(positionType, envelope(processResult), { isFinal: true }).ok, false);
  assert.equal(validateCompletion(positionType, envelope(processResult)).ok, true);
  assert.equal(validateCompletion(positionType, envelope(finalResult)).ok, true);
});

test('portfolio self-check repairs the wrong process output and requires a separate final-stage pass', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mota-pm-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fake-codex');
  const calls = join(directory, 'calls');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
const task = JSON.parse(prompt.split('\\n')[1]);
const isFinal = task.runtimeContext.isFinal;
const instructions = process.argv.find(arg => arg.startsWith('developer_instructions='));
const repaired = prompt.includes('你上一次的输出没有通过');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  isFinal, repaired, positions: task.runtimeContext.positions,
  processSchema: instructions.includes('target_allocation'), finalSchema: instructions.includes('report_markdown'),
}) + '\\n');
const payload_result = isFinal || !repaired ? ${JSON.stringify(finalResult)} : ${JSON.stringify(processResult)};
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({payload_result,payload_info:'Synthetic test'})}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
`, { mode: 0o700 });
  const executor = new TaskExecutor({ config: { codexPath: executable, codexHome: directory } });
  const result = await executor.probe({ connection: { positionType }, timeoutMs: 30_000 });
  assert.equal(result.pass, true);
  assert.equal(result.usage.totalTokens, 45);
  const attempts = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(attempts.map((call) => [call.isFinal, call.repaired]), [[false, false], [false, true], [true, false]]);
  for (const call of attempts) {
    assert.equal(call.positions[0].symbol, 'MOTASIM');
    assert.equal(call.processSchema, !call.isFinal);
    assert.equal(call.finalSchema, call.isFinal);
  }
});
