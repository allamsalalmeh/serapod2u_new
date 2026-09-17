#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { realpathSync } = require('fs');
const path = require('path');

const PORT = 3000; // Must agree with `next dev -p 3000`; never read process.env.PORT.
const TIMEOUT_MS = 5000;

// Inject OS operations so refusal and escalation tests never signal real processes.
function createGuard(overrides = {}) {
  const deps = {
    run: (command, args) => spawnSync(command, args, {
      encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    }),
    appDir: realpathSync(path.resolve(__dirname, '..')),
    cwd: () => realpathSync(process.cwd()),
    nodePath: realpathSync(process.execPath),
    nextVersion: require('../node_modules/next/package.json').version,
    uid: () => process.getuid(),
    platform: process.platform,
    kill: (pid, signal) => process.kill(pid, signal),
    now: Date.now,
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    log: console.log,
    ...overrides,
  };

  function inspect(command, args, allowNoMatch = false) {
    const result = deps.run(command, args);
    if (result.error || result.signal || typeof result.stdout !== 'string' ||
        typeof result.stderr !== 'string' || result.stderr.trim()) {
      throw new Error(`${command} inspection failed; refusing automatic termination.`);
    }
    // Only lsof exit 1 with empty output is an ordinary empty selection.
    // Warnings, permission errors, missing binaries and timeouts fail closed.
    if (allowNoMatch && result.status === 1 && !result.stdout.trim()) return null;
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error(`${command} inspection returned an unexpected result.`);
    }
    return result.stdout.trim();
  }

  function listeners() {
    const output = inspect('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], true);
    if (output === null) return [];
    const lines = output.split('\n');
    if (lines.some((line) => !/^[1-9]\d*$/.test(line) ||
        !Number.isSafeInteger(Number(line)) || Number(line) <= 1)) {
      throw new Error('Invalid listener PID output.');
    }
    const pids = [...new Set(lines.map(Number))];
    if (pids.length !== 1) throw new Error('Multiple listeners; stop them manually.');
    return pids;
  }

  function ps(pid, field) {
    return inspect('ps', ['-ww', '-p', String(pid), '-o', `${field}=`]);
  }

  function identity(pid) {
    const uid = ps(pid, 'uid');
    if (!/^\d+$/.test(uid) || Number(uid) === 0 || Number(uid) !== deps.uid()) {
      throw new Error('Listener or parent is not owned by the current non-root user.');
    }
    const cwd = inspect('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    if (cwd !== `p${pid}\nfcwd\nn${deps.appDir}`) {
      throw new Error('Listener or parent working directory does not match this development app.');
    }
    const records = inspect('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']).split('\n');
    if (records[0] !== `p${pid}` || !records.includes('ftxt') ||
        !records.includes(`n${deps.nodePath}`) ||
        records.some((line, index) => index > 0 && !/^[fn]/.test(line))) {
      throw new Error('Cannot verify the Node executable for listener or parent.');
    }
    const ppid = ps(pid, 'ppid');
    if (!/^[1-9]\d*$/.test(ppid) || !Number.isSafeInteger(Number(ppid))) {
      throw new Error('Cannot establish parent PID.');
    }
    return { pid, uid, ppid: Number(ppid), started: ps(pid, 'lstart'), command: ps(pid, 'command'), cwd };
  }

  function verify(pid) {
    const child = identity(pid);
    // Next replaces its worker argv with this title. The title alone is NOT proof:
    // its direct parent must have this app's exact Next development invocation.
    if (child.command !== `next-server (v${deps.nextVersion})` || child.ppid <= 1 || child.ppid === pid) {
      throw new Error('Listener is not an identifiable Next.js development worker.');
    }
    const parent = identity(child.ppid);
    const commands = ['node', deps.nodePath].flatMap((node) => [
      `${node} ${deps.appDir}/node_modules/.bin/next dev -p ${PORT}`,
      `${node} ${deps.appDir}/node_modules/next/dist/bin/next dev -p ${PORT}`,
    ]);
    if (!commands.includes(parent.command)) {
      throw new Error('Parent arguments do not identify this project\'s Next.js dev server on port 3000.');
    }
    return JSON.stringify({ child, parent });
  }

  function stillOwnsPort(pid) {
    const pids = listeners();
    if (!pids.length) return false;
    if (pids[0] !== pid) throw new Error('Port 3000 ownership changed; refusing termination.');
    return true;
  }

  function signalVerified(pid, signature, signal) {
    if (!stillOwnsPort(pid)) return;
    if (verify(pid) !== signature) throw new Error('Process identity changed; refusing termination.');
    if (!stillOwnsPort(pid)) return;
    // macOS has no atomic PID-identity-and-signal API; minimize the race window.
    // Never signal a parent, process group, or command pattern.
    deps.kill(pid, signal);
  }

  function waitForRelease(pid) {
    const deadline = deps.now() + TIMEOUT_MS;
    do {
      if (!stillOwnsPort(pid)) return true;
      deps.sleep(100);
    } while (deps.now() < deadline);
    return !stillOwnsPort(pid);
  }

  return function guard() {
    // lsof/ps identity checks are macOS-only. On Windows/Linux just continue;
    // Next.js will report if port 3000 is already in use.
    if (deps.platform !== 'darwin') {
      deps.log(`[dev] Skipping macOS port guard on ${deps.platform}.`);
      return;
    }
    if (deps.uid() === 0 || deps.cwd() !== deps.appDir) {
      throw new Error('Run as a non-root macOS user from this development app directory.');
    }
    const pids = listeners();
    if (pids.length) {
      const pid = pids[0];
      const signature = verify(pid);
      deps.log(`[dev] Sending SIGTERM to verified project Next.js listener ${pid}.`);
      signalVerified(pid, signature, 'SIGTERM');
      if (!waitForRelease(pid)) {
        deps.log(`[dev] Rechecking listener ${pid} before SIGKILL.`);
        signalVerified(pid, signature, 'SIGKILL');
        if (!waitForRelease(pid)) throw new Error('Port 3000 was not released.');
      }
    }
    if (listeners().length) throw new Error('Port 3000 was claimed again; refusing startup.');
    deps.log('[dev] Port 3000 is free.');
  };
}

module.exports = { createGuard };

if (require.main === module) {
  try {
    createGuard()();
  } catch (error) {
    console.error(`[dev] ${error.message}`);
    process.exitCode = 1;
  }
}
