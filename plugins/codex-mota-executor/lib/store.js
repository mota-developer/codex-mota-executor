import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const defaultDataDir = () => join(homedir(), 'Library', 'Application Support', 'codex-mota-executor');

export function privateDirectory(path) {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('数据目录必须是当前用户所有的私有目录（权限 700）');
  }
  return absolute;
}

export function readJSON(path, defaultValue) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return defaultValue;
    throw new Error('本地 MoTA 状态无法读取；请检查文件权限和 JSON 格式');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeJSON(path, data) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(data) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch {
    const error = new Error('无法持久化本地 MoTA 状态');
    error.code = 'JOURNAL_WRITE_FAILED';
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
  }
}

/**
 * Darwin open(2) O_EXLOCK takes an OS advisory lock during open. Node does not
 * export this flag. Kernel releases it even after SIGKILL; do not unlink it.
 */
export function lockFile(path) {
  if (process.platform !== 'darwin') throw new Error('常驻 Worker 目前仅支持 macOS');
  const O_EXLOCK = 0x00000020;
  let fd;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK |
      constants.O_NOFOLLOW | O_EXLOCK, 0o600);
  } catch (error) {
    if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return null;
    throw error;
  }
  try { fchmodSync(fd, 0o600); } catch (error) { closeSync(fd); throw error; }
  return () => closeSync(fd);
}

export function readConfig(dir) {
  const config = readJSON(join(dir, 'config.json'), { agents: [] });
  if (!Array.isArray(config?.agents)) throw new Error('MoTA 配置格式无效');
  return config;
}

export function updateConfig(dir, update) {
  const release = lockFile(join(dir, 'config.lock'));
  if (!release) throw new Error('已有另一条命令正在更新配置，请重试');
  try {
    const config = readConfig(dir);
    const result = update(config);
    writeJSON(join(dir, 'config.json'), config);
    return result;
  } finally {
    release();
  }
}

export class RunJournal {
  constructor(dir, connection) {
    const id = createHash('sha256')
      .update(JSON.stringify([connection.agentCode, connection.queueUrl, connection.positionType, connection.workerId]))
      .digest('hex');
    this.path = join(dir, `${id}.json`);
    const saved = readJSON(this.path, { pending: [], completed: [] });
    try {
      this.pending = new Map(saved.pending);
      this.completed = new Map(saved.completed);
      for (const [key, value] of this.pending) {
        if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key) || typeof value.bytes !== 'string' ||
            !Number.isSafeInteger(value.leaseExpireAt)) throw new Error();
      }
    } catch {
      throw new Error('MoTA 任务日志格式无效');
    }
  }

  commit(pending, completed) {
    writeJSON(this.path, { pending: [...pending], completed: [...completed] });
    this.pending = pending;
    this.completed = completed;
  }

  stage(runId, entry) {
    if (this.pending.has(runId)) throw new Error('Cannot replace a staged completion');
    this.commit(new Map(this.pending).set(runId, entry), this.completed);
  }

  extend(runId, leaseExpireAt) {
    const entry = this.pending.get(runId);
    if (!entry || entry.leaseExpireAt === leaseExpireAt) return;
    this.commit(new Map(this.pending).set(runId, { ...entry, leaseExpireAt }), this.completed);
  }

  retireBefore(cutoff) {
    const expired = [...this.pending].filter(([, entry]) => entry.leaseExpireAt <= cutoff);
    if (expired.length === 0) return [];
    const pending = new Map(this.pending);
    const completed = new Map(this.completed);
    for (const [runId, entry] of expired) {
      pending.delete(runId);
      completed.set(runId, {
        accepted: null,
        runStatus: 'LOCAL_RECEIPT_UNCONFIRMED_EXPIRED',
        failureReported: entry.failure === true,
        finishedAt: new Date().toISOString(),
      });
    }
    this.commitSettled(pending, completed);
    return expired.map(([runId]) => runId);
  }

  settle(runId, receipt) {
    const pending = new Map(this.pending);
    pending.delete(runId);
    const completed = new Map(this.completed).set(runId, receipt);
    this.commitSettled(pending, completed);
  }

  commitSettled(pending, completed) {
    while (completed.size > 1000) completed.delete(completed.keys().next().value);
    this.commit(pending, completed);
  }
}
