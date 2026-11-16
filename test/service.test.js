import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Service } from '../plugins/codex-mota-executor/lib/service.js';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mota-launchd-test-'));
  const pluginRoot = join(root, 'plugin cache');
  const dataDir = join(root, 'data & config');
  const launchAgentsDir = join(root, 'LaunchAgents');
  const runner = join(pluginRoot, 'bin', 'mota.mjs');
  for (const directory of ['bin', 'lib', 'schemas']) {
    await mkdir(join(pluginRoot, directory), { recursive: true });
  }
  await writeFile(join(pluginRoot, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(pluginRoot, 'LICENSE'), 'Fixture license\n');
  await writeFile(runner, `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', () => setTimeout(() => {
  console.log('stopped', process.pid);
  clearInterval(timer);
}, 200));
writeFileSync(join(process.cwd(), 'status.json'), JSON.stringify({
  pid: process.pid, processPhase: 'running', runningAt: new Date().toISOString(),
  runtimeRelease: process.env.MOTA_WORKER_RELEASE,
}));
console.log('started', process.pid, JSON.stringify(process.argv.slice(2)));
`);
  const service = new Service({ dataDir, pluginRoot, launchAgentsDir, ...options });
  t.after(async () => {
    try {
      await service.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return { dataDir, pluginRoot, runner, service };
}

function fakeLaunchctl() {
  const actions = [];
  let running = false;
  let failNextLaunch = false;
  let omitNextAck = false;
  let dataDir;
  return {
    actions,
    setDataDir: (path) => { dataDir = path; },
    failNextLaunch: () => { failNextLaunch = true; },
    omitNextAck: () => { omitNextAck = true; },
    async run(args) {
      actions.push(args);
      if (args[0] === 'print') {
        if (running) return 'state = running\n\tpid = 2026\n\tlast exit code = 0\n\tprivate = do not expose';
        throw Object.assign(new Error('missing'), { code: 113 });
      }
      if (args[0] === 'bootstrap' && failNextLaunch) {
        failNextLaunch = false;
        throw Object.assign(new Error('launch failed'), { code: 5 });
      }
      running = args[0] === 'bootstrap';
      if (running && !omitNextAck) {
        const release = await readlink(join(dataDir, 'runtime'));
        await writeFile(join(dataDir, 'status.json'), JSON.stringify({
          pid: 2026, processPhase: 'running', runningAt: new Date().toISOString(),
          runtimeRelease: basename(release),
        }));
      }
      if (running) omitNextAck = false;
      return '';
    },
  };
}

test('the LaunchAgent references a stable copy and exposes only status fields', async (t) => {
  const launchctl = fakeLaunchctl();
  const { dataDir, runner, service } = await fixture(t, { runLaunchctl: launchctl.run, platform: 'darwin', uid: 501 });
  launchctl.setDataDir(dataDir);
  assert.equal((await service.status()).installed, false);
  assert.deepEqual(await service.start(), {
    label: service.label, supported: true, installed: true, loaded: true, running: true, pid: 2026, lastExitStatus: 0,
  });
  assert.equal((await service.start()).pid, 2026);
  assert.equal(launchctl.actions.filter(([action]) => action === 'bootstrap').length, 1);
  const plist = await readFile(service.plistPath, 'utf8');
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ExitTimeOut<\/key><integer>65<\/integer>/);
  assert.match(plist, /&amp; config\/runtime\/bin\/mota\.mjs/);
  assert.match(plist, /&amp; config\/worker\.log/);
  assert.ok(!plist.includes('plugin cache'));
  assert.equal(await readFile(join(service.runtime, 'bin', 'mota.mjs'), 'utf8'), await readFile(runner, 'utf8'));
  assert.equal(await readFile(join(service.runtime, 'LICENSE'), 'utf8'), 'Fixture license\n');
  assert.equal((await service.stop()).installed, false);
  assert.equal((await service.status()).running, false);
  assert.equal(await readFile(join(service.runtime, 'bin', 'mota.mjs'), 'utf8'), await readFile(runner, 'utf8'));
});

test('an interrupted update leaves the previous resident worker and runtime usable', async (t) => {
  const launchctl = fakeLaunchctl();
  const { dataDir, pluginRoot, runner, service } = await fixture(t, {
    runLaunchctl: launchctl.run, platform: 'darwin', uid: 501, startupTimeoutMs: 300,
  });
  launchctl.setDataDir(dataDir);
  await service.start();
  const initial = await readlink(service.runtime);
  await rename(join(pluginRoot, 'lib'), join(pluginRoot, 'lib-old'));
  await assert.rejects(service.restart(), { code: 'ENOENT' });
  assert.equal(await readlink(service.runtime), initial);
  assert.equal((await service.status()).running, true);
  assert.equal(launchctl.actions.filter(([action]) => action === 'bootout').length, 0);

  await rename(join(pluginRoot, 'lib-old'), join(pluginRoot, 'lib'));
  await writeFile(runner, 'console.log("new release");\n');
  launchctl.failNextLaunch();
  await assert.rejects(service.restart(), /launchctl bootstrap failed/);
  assert.equal((await service.status()).running, true);
  assert.equal(await readlink(service.runtime), initial);
  assert.match(await readFile(join(service.runtime, 'bin', 'mota.mjs'), 'utf8'), /started/);

  launchctl.omitNextAck();
  // A PID and stale status from the prior release cannot pass the check.
  await assert.rejects(service.restart(), /did not acknowledge startup/);
  assert.equal((await service.status()).running, true);
  assert.equal(await readlink(service.runtime), initial);
  const marker = JSON.parse(await readFile(join(dataDir, 'status.json'), 'utf8'));
  assert.equal(marker.runtimeRelease, basename(initial));
});

async function poll(read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  assert.fail('Timed out waiting for the test LaunchAgent');
}

test('launchd respawns the worker with the original plugin cache removed', {
  skip: process.platform !== 'darwin' || process.env.MOTA_TEST_LAUNCHD !== '1',
}, async (t) => {
  const { dataDir, pluginRoot, service } = await fixture(t);
  await service.start();
  const first = await poll(async () => {
    const status = await service.status();
    const log = await readFile(join(dataDir, 'worker.log'), 'utf8').catch(() => '');
    return status.pid && log.includes(`started ${status.pid}`) && status.pid;
  });
  await rename(pluginRoot, `${pluginRoot}-removed`);
  process.kill(first, 'SIGKILL');
  const second = await poll(async () => {
    const status = await service.status();
    const log = await readFile(join(dataDir, 'worker.log'), 'utf8').catch(() => '');
    return status.pid && status.pid !== first && log.includes(`started ${status.pid}`) && status.pid;
  });
  assert.notEqual(first, second);
  const logPath = join(dataDir, 'worker.log');
  assert.match(await readFile(logPath, 'utf8'), /\["run","--data-dir",/);
  assert.equal((await stat(logPath)).mode & 0o077, 0);
  assert.equal((await service.stop()).loaded, false);
  await poll(() => {
    try {
      process.kill(second, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  });
  assert.match(await readFile(logPath, 'utf8'), new RegExp(`stopped ${second}`));
});

test('launchd restores the prior runtime if bootstrap loads an entry that crashes', {
  skip: process.platform !== 'darwin' || process.env.MOTA_TEST_LAUNCHD !== '1',
}, async (t) => {
  const { runner, service } = await fixture(t, { startupTimeoutMs: 2500 });
  const started = await service.start();
  const initial = await readlink(service.runtime);
  await writeFile(runner, 'if ( {\n');
  await assert.rejects(service.restart(), /did not acknowledge startup/);
  const restored = await service.status();
  assert.equal(restored.running, true);
  assert.notEqual(restored.pid, started.pid);
  assert.equal(await readlink(service.runtime), initial);
  assert.match(await readFile(join(initial, 'bin', 'mota.mjs'), 'utf8'), /started/);
});
