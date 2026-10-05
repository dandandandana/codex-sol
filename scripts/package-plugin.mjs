import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PACKAGE_INVENTORY = 'package-inventory.json';
const MARKETPLACE_PATH = '.agents/plugins/marketplace.json';
const COMMON_REQUIRED_FILES = [
  '.codex-plugin/plugin.json', 'hooks/hooks.json', 'runtime.schema.json', 'package.json', 'package-lock.json',
];
const PORTABLE_FILES = ['plugin.json', 'mcp.json'];
const PLUGIN_GUIDE = 'PLUGIN.md';
const OPTIONAL_EXAMPLES = ['context.example.json', 'rules.example.json', 'sol-project.example.json'];
const TREE_INPUTS = ['src', 'vendor/normify', 'node_modules'];
const PACKAGE_DESCRIPTION = 'Local responsibility context and explicit change workflows for Codex projects.';

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function physicalTarget(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error('Output path may not traverse a symbolic link.');
      const actual = await realpath(cursor);
      return resolve(actual, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error('Could not resolve an existing parent for the output directory.');
      suffix.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

function assertOutputSafe(out, repoRoot) {
  if (isWithin(out, repoRoot)) throw new Error('Output cannot be the repository or one of its ancestors.');
  for (const input of ['src', 'vendor', 'node_modules']) {
    if (isWithin(join(repoRoot, input), out)) throw new Error(`Output cannot be inside the repository ${input} input tree.`);
  }
}

async function copyChecked(source, destination, relativePath, { omitNodeBin = false } = {}) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link in package input: ${relativePath}`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const children = (await readdir(source)).sort((a, b) => a.localeCompare(b));
    for (const child of children) {
      if (omitNodeBin && relativePath === 'node_modules' && child === '.bin') continue;
      await copyChecked(join(source, child), join(destination, child), `${relativePath}/${child}`, { omitNodeBin });
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Refusing non-regular package input: ${relativePath}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

async function collectInventoryFiles(root, current = '', result = []) {
  const directory = current ? join(root, current) : root;
  for (const child of (await readdir(directory)).sort((a, b) => a.localeCompare(b))) {
    const relativePath = current ? `${current}/${child}` : child;
    if (relativePath === PACKAGE_INVENTORY) continue;
    const full = join(root, ...relativePath.split('/'));
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error(`Package output unexpectedly contains a symbolic link: ${relativePath}`);
    if (info.isDirectory()) await collectInventoryFiles(root, relativePath, result);
    else if (info.isFile()) {
      const bytes = await readFile(full);
      result.push({ path: relativePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error(`Package output contains a non-regular file: ${relativePath}`);
  }
  return result;
}

/**
 * Copy the audited production allowlist into a new portable plugin directory.
 * The destination must not exist; failures leave any partial output for review.
 * No package manager, host setting, project data, or publishing action is used.
 */
export async function packagePlugin({ out, format = 'codex' } = {}) {
  if (typeof out !== 'string' || !out.trim()) throw new TypeError('out must name a new output directory.');
  if (format !== 'codex' && format !== 'portable') throw new TypeError('format must be codex or portable.');
  const repoRoot = await realpath(REPO_ROOT);
  const target = await physicalTarget(resolve(out));
  assertOutputSafe(target, repoRoot);
  try { await lstat(target); throw new Error('Output directory already exists; choose a new path.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  await mkdir(dirname(target), { recursive: true });
  await mkdir(target, { recursive: false });
  const pluginRoot = join(target, 'codex-sol');
  await mkdir(pluginRoot, { recursive: false });

  const bootstrapSource = await readFile(join(repoRoot, 'src/plugin-bootstrap.cjs'), 'utf8');
  const requiredFiles = format === 'portable' ? [...COMMON_REQUIRED_FILES, ...PORTABLE_FILES] : COMMON_REQUIRED_FILES;
  for (const relativePath of requiredFiles) {
    await copyChecked(join(repoRoot, relativePath), join(pluginRoot, relativePath), relativePath);
  }
  await writeFile(join(pluginRoot, '.mcp.json'), `${JSON.stringify({ mcpServers: { codex_sol: {
    command: 'node', args: ['--input-type=commonjs', '-e', bootstrapSource, 'sol-plugin-mcp'],
  } } }, null, 2)}\n`, { flag: 'wx' });
  await copyChecked(join(repoRoot, PLUGIN_GUIDE), join(pluginRoot, 'README.md'), 'README.md');
  for (const relativePath of OPTIONAL_EXAMPLES) {
    try { await lstat(join(repoRoot, relativePath)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await copyChecked(join(repoRoot, relativePath), join(pluginRoot, relativePath), relativePath);
  }
  for (const relativePath of TREE_INPUTS) {
    await copyChecked(join(repoRoot, relativePath), join(pluginRoot, relativePath), relativePath,
      { omitNodeBin: relativePath === 'node_modules' });
  }

  await mkdir(dirname(join(target, MARKETPLACE_PATH)), { recursive: true });
  await writeFile(join(target, MARKETPLACE_PATH), `${JSON.stringify({
    name: 'sol-local',
    interface: { displayName: 'SoL Local' },
    plugins: [{ name: 'codex-sol', source: { source: 'local', path: './codex-sol' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  }, null, 2)}\n`, { flag: 'wx' });

  const packageMetadata = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
  const files = await collectInventoryFiles(target);
  const mcpHint = format === 'codex' ? { command: 'node', args: ['--input-type=commonjs', '-e',
    '<contents of codex-sol/src/plugin-bootstrap.cjs>', 'sol-plugin-mcp'], source: 'codex-sol/src/plugin-bootstrap.cjs' }
    : { ...JSON.parse(await readFile(join(pluginRoot, 'mcp.json'), 'utf8')).mcpServers.codex_sol, source: 'codex-sol/mcp.json' };
  const inventory = { schema_version: 1, name: 'codex-sol', format, version: packageMetadata.version,
    description: PACKAGE_DESCRIPTION,
    commands: { mcp: mcpHint,
      hook: 'node "${PLUGIN_ROOT}/src/plugin-launcher.mjs" hook' },
    files };
  await writeFile(join(target, PACKAGE_INVENTORY), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return { out: target, pluginRoot, format, fileCount: files.length, inventory: join(target, PACKAGE_INVENTORY) };
}

function outputArgument(argv) {
  if ((argv.length !== 2 && argv.length !== 4) || argv[0] !== '--out' || !argv[1] || argv[1].startsWith('--') ||
    (argv.length === 4 && (argv[2] !== '--format' || !['codex', 'portable'].includes(argv[3]))))
    throw new Error('Usage: node scripts/package-plugin.mjs --out <new-directory> [--format codex|portable]');
  return { out: argv[1], format: argv.length === 4 ? argv[3] : 'codex' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await packagePlugin(outputArgument(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ status: 'packaged', format: result.format, fileCount: result.fileCount, inventory: PACKAGE_INVENTORY })}\n`);
  } catch (error) {
    process.stderr.write(`Plugin packaging failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
