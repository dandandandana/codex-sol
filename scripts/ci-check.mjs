import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeIntegrationFile = 'native-integration.test.mjs';

function nativeExecutableError(message) {
  return new Error(`Native CI requires CODEX_SOL_PATCH_EXECUTABLE: ${message}`);
}

function validateNativeExecutable(value, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!value || !pathApi.isAbsolute(value)) {
    throw nativeExecutableError('configure an absolute path to the installed Codex executable.');
  }
  if (!['win32', 'linux'].includes(platform)) {
    throw new Error('Native CI is supported only on Windows and Linux.');
  }
  if (platform === 'win32' && path.win32.extname(value).toLowerCase() !== '.exe') {
    throw nativeExecutableError('Windows requires the installed .exe, not a command shim.');
  }

  let info;
  try {
    info = statSync(value);
  } catch {
    throw nativeExecutableError('the configured executable is unavailable.');
  }
  if (!info.isFile()) {
    throw nativeExecutableError('the configured executable must be a regular file.');
  }
  if (platform === 'linux') {
    try {
      accessSync(value, fsConstants.X_OK);
    } catch {
      throw nativeExecutableError('the configured Linux executable must have execute permission.');
    }
  }
}

export function discoverTestFiles(mode, { testsDir = path.join(root, 'tests'), env = process.env, platform = process.platform } = {}) {
  if (!['portable', 'native', 'all'].includes(mode)) {
    throw new TypeError(`Unknown CI test mode: ${mode}. Expected portable, native or all.`);
  }

  if (mode === 'native') validateNativeExecutable(env.CODEX_SOL_PATCH_EXECUTABLE, platform);

  const files = readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => entry.name)
    .sort();

  const selected = mode === 'portable' ? files.filter((name) => name !== nativeIntegrationFile) : files;
  return selected.map((name) => path.resolve(testsDir, name));
}

function signalExitCode(signal) {
  const signalNumber = osSignalNumbers[signal];
  return signalNumber ? 128 + signalNumber : 1;
}

const osSignalNumbers = { SIGINT: 2, SIGTERM: 15 };

function runTests(mode) {
  const files = discoverTestFiles(mode);
  const childEnv = { ...process.env };
  if (mode === 'portable') {
    delete childEnv.CODEX_SOL_PATCH_EXECUTABLE;
    console.log('Portable CI excludes tests/native-integration.test.mjs and does not cover real Codex patch execution.');
    console.log('Native patch cases in tests/change.test.mjs and tests/linux.test.mjs remain skipped unless their existing platform conditions are met.');
  } else if (mode === 'native') {
    console.log('Native CI uses the configured installed Codex executable; all test files are selected.');
  } else {
    console.log('All test files are selected; native cases retain their existing platform and executable conditions.');
  }

  const child = spawn(process.execPath, [fileURLToPath(new URL('./test-runner.mjs', import.meta.url)), ...files], {
    cwd: root,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  let requestedSignal = null;
  const forwardSignal = (signal) => {
    if (requestedSignal) return;
    requestedSignal = signal;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else if (child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.once('error', (error) => console.error(`Could not terminate the test process tree (${error.code ?? 'UNKNOWN'}).`));
        killer.once('close', (code) => { if (code !== 0) console.error('Test process tree termination failed.'); });
      } else child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(`Could not forward ${signal} to the test process (${error.code ?? 'UNKNOWN'}).`);
    }
  };
  const onInterrupt = () => forwardSignal('SIGINT');
  const onTerminate = () => forwardSignal('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  let spawnFailed = false;
  child.once('error', (error) => {
    spawnFailed = true;
    console.error(`Could not start the Node test runner (${error.code ?? 'UNKNOWN'}).`);
  });
  child.once('close', (code, signal) => {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    if (requestedSignal) {
      process.exitCode = signalExitCode(requestedSignal);
    } else if (signal) {
      process.exitCode = signalExitCode(signal);
    } else {
      process.exitCode = spawnFailed ? 127 : (code ?? 1);
    }
  });
}

function main() {
  const mode = process.argv[2];
  if (!['portable', 'native', 'all'].includes(mode) || process.argv.length > 3) {
    console.error('Usage: node scripts/ci-check.mjs <portable|native|all>');
    process.exitCode = 2;
    return;
  }

  try {
    runTests(mode);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
