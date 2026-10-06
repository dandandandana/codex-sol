import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createObservationStore } from '../../src/store.mjs';
import { withWorkspaceLock } from '../../src/workspace-lock.mjs';

const [root, mode, argument] = process.argv.slice(2);
const store = await createObservationStore(root);
try {
  if (mode === 'counter') {
    process.stdout.write('ready\n');
    while (await readFile(join(root, 'go'), 'utf8').catch(() => '') !== 'go') await delay(5);
    for (let i = 0; i < Number(argument); i++) {
      await withWorkspaceLock(store, async () => {
        const marker = await open(join(root, 'critical-section'), 'wx');
        try {
          const value = Number(await readFile(join(root, 'counter'), 'utf8'));
          await delay(3);
          await writeFile(join(root, 'counter'), String(value + 1));
        } finally {
          await marker.close();
          await unlink(join(root, 'critical-section'));
        }
      });
    }
  } else {
    await withWorkspaceLock(store, async (lease) => {
      if (mode === 'starting') await lease.setRunner({ state: 'starting', pid: null });
      if (mode === 'running') await lease.setRunner({ state: 'running', pid: Number(argument) });
      process.stdout.write('locked\n');
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  }
} catch (error) {
  process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
}
