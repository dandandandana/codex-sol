import { isAbsolute } from 'node:path';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { SolFault } from './store.mjs';
import { validateWorkspacePath, workspaceFile } from './workspace.mjs';
import { runManagedCommand } from './managed-command.mjs';

export function patchPaths(patch) {
  if (typeof patch !== 'string' || Buffer.byteLength(patch, 'utf8') > 24000) throw new SolFault('PATCH_ERROR', 'Patch must be a UTF-8 string of at most 24,000 bytes. Split larger changes into separate patches.');
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') throw new SolFault('PATCH_ERROR', 'Patch must have exact Begin Patch and End Patch markers.');
  const paths = new Set();
  let previousWasUpdate = false;
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(line);
    const moved = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (header) { paths.add(header[1]); previousWasUpdate = line.startsWith('*** Update File: '); }
    else if (moved && previousWasUpdate) { paths.add(moved[1]); previousWasUpdate = false; }
    else {
      if (line.startsWith('*** ') && line !== '*** End of File') throw new SolFault('PATCH_ERROR', 'Unexpected patch control line.');
      previousWasUpdate = false;
    }
  }
  if (!paths.size) throw new SolFault('PATCH_ERROR', 'Patch contains no file operations.');
  for (const path of paths) validateWorkspacePath(path);
  return [...paths].sort();
}

export async function applyManagedPatch(store, validator, patch, { executable, generated = [], signal, lease } = {}) {
  const paths = patchPaths(patch);
  if (!executable || !isAbsolute(executable) || !(await stat(executable)).isFile()) throw new SolFault('CONFIG_ERROR', 'Configure CODEX_SOL_PATCH_EXECUTABLE with the installed Codex executable path.');
  if (process.platform === 'linux') await access(executable, constants.X_OK).catch(() => {
    throw new SolFault('CONFIG_ERROR', 'The configured Codex patch executable is not executable by this user.');
  });
  // Validation is also repeated under the lease by fileState in runManagedCommand.
  for (const path of paths) await workspaceFile(store.workspaceRoot, path, { allowMissing: true });
  return runManagedCommand(store, validator, { argv: [executable, '--codex-run-as-apply-patch', patch], cwd: '.', timeout_ms: 30000 }, { tool: 'sol_apply_patch', paths, generated, signal, lease });
}
