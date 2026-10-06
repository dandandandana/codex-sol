import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { pipeline } from 'node:stream/promises';

// Node 20.8 supports the programmatic concurrency option, before the CLI flag.
// Selection belongs to ci-check; this process runs only the explicit file list.
const files = process.argv.slice(2);
if (!files.length) {
  console.error('Test runner requires an explicit test file list.');
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  let interrupted = null;
  const stop = (signal) => {
    interrupted ??= signal;
    controller.abort();
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    const tests = run({ files, concurrency: 4, signal: controller.signal });
    tests.on('test:fail', (result) => { if (!result.todo) process.exitCode = 1; });
    await pipeline(tests, new spec(), process.stdout);
  } catch (error) {
    controller.abort();
    console.error(`Test runner failed (${error.code ?? 'UNKNOWN'}): ${error.message ?? 'Unknown runner error'}`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  }
}
