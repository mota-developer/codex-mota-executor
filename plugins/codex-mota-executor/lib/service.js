import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, mkdir, mkdtemp, open, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function launchctl(args) {
  const { stdout } = await execFileAsync('/bin/launchctl', args, { timeout: args[0] === 'bootout' ? 75_000 : 5_000 });
  return stdout;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function plist({ label, nodePath, entry, dataDir, runtimeRelease }) {
  const args = [nodePath, entry, 'run', '--data-dir', dataDir];
  // npm-installed Codex can be a script with an `env node` shebang.
  const searchPath = xml(`${dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`);
  const logPath = xml(join(dataDir, 'worker.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(dataDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>65</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${searchPath}</string>
    <key>MOTA_WORKER_RELEASE</key><string>${xml(runtimeRelease)}</string>
  </dict>
</dict>
</plist>
`;
}

async function ifPresent(getValue) {
  try {
    return await getValue();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export class Service {
  constructor({
    dataDir, pluginRoot, nodePath = process.execPath,
    launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents'),
    platform = process.platform, uid = process.getuid?.(), runLaunchctl = launchctl,
    startupTimeoutMs = 15_000,
  }) {
    for (const [name, value] of Object.entries({ dataDir, pluginRoot, nodePath })) {
      if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f]/u.test(value)) {
        throw new TypeError(`${name} must be an absolute path without control characters`);
      }
    }
    this.dataDir = resolve(dataDir);
    this.pluginRoot = resolve(pluginRoot);
    this.nodePath = nodePath;
    const scope = createHash('sha256').update(this.dataDir).digest('hex').slice(0, 16);
    this.label = `ai.mota.codex-executor.${scope}`;
    this.domain = `gui/${uid}`;
    this.target = `${this.domain}/${this.label}`;
    this.launchAgentsDir = launchAgentsDir;
    this.plistPath = join(launchAgentsDir, `${this.label}.plist`);
    this.runtime = join(this.dataDir, 'runtime');
    this.releases = join(this.dataDir, 'runtimes');
    this.supported = platform === 'darwin' && Number.isInteger(uid);
    this.runLaunchctl = runLaunchctl;
    this.startupTimeoutMs = startupTimeoutMs;
  }

  #assertSupported() {
    if (!this.supported) throw new Error('Service management requires a macOS login session. Use `run` for foreground execution.');
  }

  async #command(action, target, ...args) {
    try {
      return await this.runLaunchctl([action, target, ...args]);
    } catch (error) {
      if ((action === 'print' || action === 'bootout') && error.code === 113) return null;
      const code = typeof error.code === 'number' ? ` (exit ${error.code})` : '';
      throw new Error(`launchctl ${action} failed for ${this.label}${code}`);
    }
  }

  async status() {
    const details = this.supported ? await this.#command('print', this.target) : null;
    const pid = details?.match(/^\s*pid = (\d+)\s*$/m)?.[1];
    const lastExit = details?.match(/^\s*last exit code = (-?\d+)\s*$/m)?.[1];
    return {
      label: this.label,
      supported: this.supported,
      installed: (await ifPresent(() => readFile(this.plistPath))) !== null,
      loaded: details !== null,
      running: pid !== undefined,
      pid: pid === undefined ? null : Number(pid),
      lastExitStatus: lastExit === undefined ? null : Number(lastExit),
    };
  }

  async #bootout() {
    const deadline = performance.now() + 75_000;
    await this.#command('bootout', this.target);
    // bootout can return during SIGTERM handling. Wait until launchd has
    // unloaded this job before switching the runtime or starting another copy.
    while (await this.#command('print', this.target) !== null) {
      if (performance.now() >= deadline) throw new Error(`Timed out unloading ${this.label}`);
      await delay(100);
    }
  }

  async #awaitStartup(startedAt, runtimeRelease) {
    const deadline = performance.now() + this.startupTimeoutMs;
    while (performance.now() < deadline) {
      const status = await this.status();
      if (status.running) {
        const raw = await ifPresent(() => readFile(join(this.dataDir, 'status.json'), 'utf8'));
        let worker;
        try { worker = raw === null ? null : JSON.parse(raw); } catch { worker = null; }
        // A PID on its own only means launchd called exec. The worker
        // acknowledges this release after local initialization and locking.
        if (worker?.pid === status.pid && worker.processPhase === 'running' &&
            Date.parse(worker.runningAt) >= startedAt &&
            (!runtimeRelease || worker.runtimeRelease === runtimeRelease)) return status;
      }
      await delay(100);
    }
    throw new Error(`Worker did not acknowledge startup for ${this.label}`);
  }

  async #copyRuntime() {
    await access(this.nodePath, constants.X_OK);
    await mkdir(this.releases, { recursive: true, mode: 0o700 });
    const release = await mkdtemp(join(this.releases, 'release-'));
    try {
      for (const item of ['bin', 'lib', 'schemas', 'package.json', 'LICENSE']) {
        await cp(join(this.pluginRoot, item), join(release, item), { recursive: true, dereference: true });
      }
      await access(join(release, 'bin', 'mota.mjs'), constants.R_OK);
      return release;
    } catch (error) {
      await rm(release, { recursive: true, force: true });
      throw error;
    }
  }

  async #linkRuntime(release) {
    if (release === null) {
      await rm(this.runtime, { force: true });
      return;
    }
    const temporary = join(this.dataDir, `.runtime-${randomUUID()}`);
    try {
      await symlink(release, temporary, 'dir');
      await rename(temporary, this.runtime);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #writePlist(content) {
    if (content === null) {
      await rm(this.plistPath, { force: true });
      return;
    }
    await mkdir(this.launchAgentsDir, { recursive: true });
    const temporary = join(this.launchAgentsDir, `.${this.label}.${randomUUID()}`);
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.plistPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #install(wasLoaded) {
    const previous = await ifPresent(() => readlink(this.runtime));
    const previousPlist = await ifPresent(() => readFile(this.plistPath));
    const release = await this.#copyRuntime();
    const content = plist({
      label: this.label,
      nodePath: this.nodePath,
      entry: join(this.runtime, 'bin', 'mota.mjs'),
      dataDir: this.dataDir,
      runtimeRelease: basename(release),
    });
    let started;
    let bootstrapAttempted = false;
    let stopped = false;
    let linked = false;
    let wrotePlist = false;
    try {
      const log = await open(join(this.dataDir, 'worker.log'), constants.O_APPEND | constants.O_WRONLY |
        constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { await log.chmod(0o600); } finally { await log.close(); }
      if (wasLoaded) {
        await this.#bootout();
        stopped = true;
      }
      await this.#linkRuntime(release);
      linked = true;
      await this.#writePlist(content);
      wrotePlist = true;
      const startedAt = Date.now();
      bootstrapAttempted = true;
      await this.#command('bootstrap', this.domain, this.plistPath);
      started = await this.#awaitStartup(startedAt, basename(release));
    } catch (error) {
      try {
        if (bootstrapAttempted && (await this.status()).loaded) await this.#bootout();
        if (linked) await this.#linkRuntime(previous);
        if (wrotePlist) await this.#writePlist(previousPlist);
        if (stopped && previousPlist !== null) {
          const restartedAt = Date.now();
          await this.#command('bootstrap', this.domain, this.plistPath);
          // The previous installation may predate release acknowledgements.
          await this.#awaitStartup(restartedAt);
        }
        await rm(release, { recursive: true, force: true });
      } catch (rollback) {
        throw new Error(`${error.message}. Restoring the previous service also failed: ${rollback.message}`);
      }
      throw error;
    }
    if (previous && dirname(previous) === this.releases) {
      await rm(previous, { recursive: true, force: true }).catch(() => {});
    }
    return started;
  }

  async start() {
    this.#assertSupported();
    const status = await this.status();
    return status.loaded ? status : this.#install(false);
  }

  async restart() {
    this.#assertSupported();
    return this.#install((await this.status()).loaded);
  }

  async stop() {
    this.#assertSupported();
    if ((await this.status()).loaded) await this.#bootout();
    await this.#writePlist(null);
    return this.status();
  }
}
