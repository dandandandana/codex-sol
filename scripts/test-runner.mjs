import { spawn } from 'node:child_process';

// Node 20.8 has no CLI concurrency flag and its programmatic AbortSignal does
// not reach file children. Own those children explicitly so cancellation also
// prevents queued files from starting. Each file keeps Node's standard reporter.
const files = process.argv.slice(2);
if (!files.length) {
  console.error('Test runner requires an explicit test file list.');
  process.exitCode = 2;
} else {
  const children = new Set();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let nextFile = 0;
  let interrupted = null;
  let failed = false;

  const stop = (signal) => {
    if (interrupted) return;
    interrupted = signal;
    for (const child of children) {
      try {
        // These process groups belong only to this runner. Force cancellation
        // so test-installed signal handlers cannot keep their group alive.
        // Deliberately detached descendants remain their creator's responsibility.
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else if (child.pid) {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.once('error', (error) => console.error(`Could not terminate a test process tree (${error.code ?? 'UNKNOWN'}).`));
          killer.once('close', (code) => { if (code !== 0) console.error('Test process tree termination failed.'); });
        } else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') console.error(`Could not terminate a test process (${error.code ?? 'UNKNOWN'}).`);
      }
    }
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    await new Promise((resolve) => {
      const schedule = () => {
        while (!interrupted && children.size < 4 && nextFile < files.length) {
          const child = spawn(process.execPath, ['--test-reporter=spec', '--', files[nextFile++]], {
            env, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32',
          });
          children.add(child);
          child.once('error', (error) => {
            failed = true;
            console.error(`Could not start a test file (${error.code ?? 'UNKNOWN'}).`);
          });
          child.once('close', (code, signal) => {
            children.delete(child);
            if (code !== 0 || signal) failed = true;
            schedule();
          });
        }
        if (!children.size && (interrupted || nextFile === files.length)) resolve();
      };
      schedule();
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    process.exitCode = interrupted ? (interrupted === 'SIGINT' ? 130 : 143) : (failed ? 1 : 0);
  }
}
