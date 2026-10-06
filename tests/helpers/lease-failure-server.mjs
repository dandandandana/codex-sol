// Real STDIO core with one narrow filesystem-fault injection for lease cleanup.
import fs from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createSolServer } from '../../src/server.mjs';

const workspace = await realpath(process.env.CODEX_SOL_WORKSPACE);
const owner = join(workspace, '.codex', 'sol', 'managed-modification.owner.json');
const unlink = fs.promises.unlink;
let injected = false;
fs.promises.unlink = async (path) => {
  if (String(path) === owner && !injected) {
    injected = true;
    throw Object.assign(new Error('Injected owner unlink failure.'), { code: 'EIO' });
  }
  return unlink(path);
};
syncBuiltinESMExports();
const rules = JSON.parse(await readFile(process.env.CODEX_SOL_RULES, 'utf8'));
const { server } = await createSolServer(workspace, rules);
serveStdio(() => server);
