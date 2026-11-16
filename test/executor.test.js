import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { TaskExecutor } from '../plugins/codex-mota-executor/lib/executor.js';

const connection = {
  agentCode: 'agent-local-test',
  positionType: 'FUNDAMENTAL_ANALYST',
  token: 'mpk_not_for_the_model',
};
const task = {
  runId: 'run-local-test',
  agentCode: connection.agentCode,
  positionType: connection.positionType,
  templateInputData: [
    { name: 'access_token', value: 'test-input-secret' },
    { name: 'observation', value: { date: '2026-09-01', api_key: 'test-nested-secret' } },
  ],
  taskBrief: { userCustomInstructions: '本地模拟，没有关注的标的', memo: connection.token },
  runtimeContext: { isFinal: false, privateField: 'test-disallowed-private-field' },
  upstream: {},
};
const validReply = JSON.stringify({
  payload_result: { assessments: [], summary: '本地模拟没有标的' },
  payload_info: '本地模拟没有标的，未执行评估。',
});
const measured = { input_tokens: 100, cached_input_tokens: 10, output_tokens: 21, reasoning_output_tokens: 5 };

async function runWithFakeCodex(t, replies) {
  const directory = await mkdtemp(join(tmpdir(), 'mota-test-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fake-codex');
  const invocations = join(directory, 'invocations.jsonl');
  const grandchildReady = join(directory, 'grandchild.pid');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const count = fs.existsSync(${JSON.stringify(invocations)})
  ? fs.readFileSync(${JSON.stringify(invocations)}, 'utf8').trim().split('\\n').length : 0;
const plan = ${JSON.stringify(replies)}[count];
const prompt = fs.readFileSync(0, 'utf8');
if (plan?.ignoreTerm) process.on('SIGTERM', () => {});
if (plan?.grandchild) {
  const child = require('node:child_process').spawn(process.execPath, ['-e',
    'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);',
    ${JSON.stringify(grandchildReady)},
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.unref();
}
fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), prompt, pid: process.pid, codexHome: process.env.CODEX_HOME,
}) + '\\n');
const emit = (event) => console.log(JSON.stringify(event));
if (plan?.hang) {
  setInterval(() => {}, 1000);
} else {
  if (plan?.tool) emit({type: 'item.started', item: {type: plan.tool}});
  emit({type: 'item.completed', item: {type: 'agent_message', text: plan?.reply}});
  emit({type: 'turn.completed', usage: plan?.usage});
}
`, { mode: 0o700 });
  return {
    executor: new TaskExecutor({ config: { codexPath: executable, codexHome: directory } }),
    directory,
    executable,
    async grandchildPid() {
      const pid = await readFile(grandchildReady, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      return Number(pid);
    },
    async invocations() {
      const raw = await readFile(invocations, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      return raw.trim().split('\n').filter(Boolean).map(JSON.parse);
    },
  };
}

test('Codex repairs preserve redacted task inputs and aggregate metered usage', async (t) => {
  const fixture = await runWithFakeCodex(t, [{ reply: '不是 JSON', usage: measured }, { reply: validReply, usage: measured }]);
  const { envelope } = await fixture.executor.execute({ connection, task });
  assert.equal(envelope.usage.totalTokens, 242);
  assert.equal(envelope.usage.promptTokens, 200);
  assert.equal(envelope.usage.completionTokens, 42);
  assert.equal(envelope.usage.cachedInputTokens, 20);
  assert.equal(envelope.usage.reasoningTokens, 10);
  assert.equal(envelope.usage.estimated, false);
  assert.match(envelope.payload_info, /不构成投资建议/);
  const calls = await fixture.invocations();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.argv.includes('--ignore-user-config'));
    assert.ok(call.argv.includes('shell_tool'));
    assert.ok(call.argv.includes('web_search="disabled"'));
    assert.equal(call.codexHome, await realpath(fixture.directory));
    assert.doesNotMatch(call.argv.join(' '), /本地模拟，没有关注的标的/);
    assert.match(call.prompt, /本地模拟，没有关注的标的/);
    assert.match(call.prompt, /2026-09-01/);
    assert.match(call.prompt, /"upstream":\{\}/);
    assert.doesNotMatch(call.prompt, /mpk_not_for_the_model|test-input-secret|test-nested-secret|test-disallowed-private-field/);
  }
  assert.match(calls[1].prompt, /你上一次的输出没有通过/);
  await assert.rejects(access(calls[0].cwd), { code: 'ENOENT' });
});

test('measured earlier output cannot make a repair with missing usage successful', async (t) => {
  const fixture = await runWithFakeCodex(t, [{ reply: '不是 JSON', usage: measured }, { reply: validReply }]);
  await assert.rejects(() => fixture.executor.execute({ connection, task }), (error) => {
    assert.equal(error.code, 'RUNTIME_USAGE_MISSING');
    assert.equal(error.usage.totalTokens, 121);
    return true;
  });
  assert.equal((await fixture.invocations()).length, 2);
});

test('identity and input shape are checked before invoking Codex', async (t) => {
  const fixture = await runWithFakeCodex(t, []);
  await assert.rejects(() => fixture.executor.execute({
    connection, task: { ...task, positionType: 'RISK_MANAGER' },
  }), { code: 'TASK_IDENTITY_INVALID' });
  await assert.rejects(() => fixture.executor.execute({
    connection, task: { ...task, agentCode: undefined },
  }), { code: 'TASK_IDENTITY_INVALID' });
  await assert.rejects(() => fixture.executor.execute({
    connection, task: { ...task, templateInputData: null },
  }), { code: 'TASK_SHAPE_INVALID' });
  assert.deepEqual(await fixture.invocations(), []);
});

test('a binding credential echoed by the model is removed from the completion', async (t) => {
  const fixture = await runWithFakeCodex(t, [{
    reply: validReply.replace('未执行评估。', `未执行评估。${connection.token}`), usage: measured,
  }]);
  const { envelope } = await fixture.executor.execute({ connection, task });
  assert.doesNotMatch(JSON.stringify(envelope), new RegExp(connection.token));
  assert.match(envelope.payload_info, /\[REDACTED\]/);
});

test('Codex homes with global instructions are rejected before invocation', async (t) => {
  const fixture = await runWithFakeCodex(t, []);
  await writeFile(join(fixture.directory, 'AGENTS.md'), 'test global instructions');
  assert.equal(fixture.executor.ready().ok, false);
  await assert.rejects(() => fixture.executor.execute({ connection, task }), { code: 'CODEX_PROFILE_REQUIRED' });
  assert.deepEqual(await fixture.invocations(), []);
});

test('unexpected tool activity fails closed and noncompliant outputs stop at three attempts', async (t) => {
  const unexpected = await runWithFakeCodex(t, [{ tool: 'mcp_tool_call', reply: validReply, usage: measured }]);
  await assert.rejects(() => unexpected.executor.execute({ connection, task }), { code: 'CODEX_TOOL_ACTIVITY' });
  const invalid = await runWithFakeCodex(t, Array(4).fill({ reply: '不是 JSON', usage: measured }));
  await assert.rejects(() => invalid.executor.execute({ connection, task }), (error) => {
    assert.equal(error.code, 'OUTPUT_CONTRACT_INVALID');
    assert.equal(error.usage.totalTokens, 363);
    return true;
  });
  assert.equal((await invalid.invocations()).length, 3);
});

async function waitFor(read) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await setTimeout(20);
  }
  assert.fail('Timed out waiting for test process');
}

function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

function killIfRunning(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

test('lease cancellation stops a CLI wrapper and descendant holding stdout', async (t) => {
  const fixture = await runWithFakeCodex(t, [{ hang: true, ignoreTerm: true, grandchild: true }]);
  const controller = new AbortController();
  const pending = fixture.executor.execute({ connection, task, signal: controller.signal, timeoutMs: 10_000 });
  const result = assert.rejects(pending, { code: 'TASK_CANCELLED' });
  let call, grandchild;
  try {
    call = await waitFor(async () => (await fixture.invocations())[0]);
    grandchild = await waitFor(fixture.grandchildPid);
    t.after(() => killIfRunning(grandchild));
  } finally {
    controller.abort();
    await result;
  }
  await waitFor(() => isGone(call.pid) && isGone(grandchild));
  await assert.rejects(access(call.cwd), { code: 'ENOENT' });
});

test('worker SIGKILL stops the CLI group through its owner pipe', async (t) => {
  const fixture = await runWithFakeCodex(t, [{ hang: true, ignoreTerm: true, grandchild: true }]);
  const worker = spawn(process.execPath, ['--input-type=module', '-e', `
import { TaskExecutor } from ${JSON.stringify(new URL('../plugins/codex-mota-executor/lib/executor.js', import.meta.url).href)};
const executor = new TaskExecutor({ config: {
  codexPath: ${JSON.stringify(fixture.executable)},
  codexHome: ${JSON.stringify(fixture.directory)},
} });
await executor.execute({ connection: ${JSON.stringify(connection)}, task: ${JSON.stringify(task)} });
`], { stdio: 'ignore' });
  t.after(() => killIfRunning(worker.pid));
  const call = await waitFor(async () => (await fixture.invocations())[0]);
  t.after(() => rm(call.cwd, { recursive: true, force: true }));
  const grandchild = await waitFor(fixture.grandchildPid);
  t.after(() => killIfRunning(grandchild));
  worker.kill('SIGKILL');
  await waitFor(() => isGone(call.pid) && isGone(grandchild));
});

test('preflight validates the role with a real invocation containing only synthetic inputs', async (t) => {
  const fixture = await runWithFakeCodex(t, [{ reply: validReply, usage: measured }]);
  const result = await fixture.executor.probe({ connection });
  assert.equal(result.pass, true);
  assert.equal(result.usage.totalTokens, 121);
  const [call] = await fixture.invocations();
  assert.match(call.prompt, /local-self-check/);
  assert.doesNotMatch(call.prompt, /agent-local-test|mpk_not_for_the_model/);
});
