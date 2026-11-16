import { spawn } from 'node:child_process';
import { Socket } from 'node:net';

// The Worker starts this supervisor as a separate process group. FD 3 stays
// open until the invocation is cancelled or the Worker dies.
const [executable, ...args] = process.argv.slice(2);
const owner = new Socket({ fd: 3, readable: true, writable: false });
const child = spawn(executable, args, { stdio: ['inherit', 'pipe', 'inherit'] });
let stopping = false;
let spawnFailed = false;

function signalGroup(signal) {
  try {
    process.kill(-process.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function cancel() {
  if (stopping) return;
  stopping = true;
  // Keep this process alive through the grace period even if the direct
  // child exits. Another process in the group may still be running.
  setTimeout(() => signalGroup('SIGKILL'), 1000);
  signalGroup('SIGTERM');
}

process.on('SIGTERM', cancel);
process.on('SIGINT', cancel);
owner.on('end', cancel);
owner.on('error', cancel);
owner.resume();
process.stdout.on('error', cancel);
child.stdout.pipe(process.stdout, { end: false });
child.on('error', () => { spawnFailed = true; });
child.on('close', (code) => {
  if (stopping) return;
  owner.destroy();
  process.exitCode = spawnFailed ? 125 : code ?? 1;
});
