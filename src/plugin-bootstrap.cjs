'use strict';

// Static stdlib-only program embedded in the legacy MCP manifest at build time.
// The host preserves the project cwd but does not expand plugin path arguments.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function missing(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Bounded project header, shared with the full-schema launcher. No writes,
 * ancestor opt-in without Git, nested-repository crossing, or environment hints. */
function readPluginProjectHeader(cwd) {
  const start = fs.realpathSync.native(path.resolve(cwd));
  if (!fs.lstatSync(start).isDirectory()) throw fault('PLUGIN_CONFIG', 'Plugin cwd must be a project directory.');
  let root = start;
  for (let candidate = start; ; candidate = path.dirname(candidate)) {
    const git = missing(path.join(candidate, '.git'));
    if (git) {
      if (git.isSymbolicLink() || !(git.isFile() || git.isDirectory()))
        throw fault('PLUGIN_CONFIG', 'Git project boundary must be regular metadata.');
      root = candidate; break;
    }
    if (path.dirname(candidate) === candidate) break;
  }
  const directory = path.join(root, '.codex');
  const parent = missing(directory);
  if (!parent) return null;
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw fault('PATH_ERROR', 'Plugin configuration directory must be regular.');
  const file = path.join(directory, 'sol-project.json');
  const info = missing(file);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) throw fault('PATH_ERROR', 'Plugin configuration must be a regular file.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let config;
  try {
    const current = fs.fstatSync(fd);
    if (!current.isFile()) throw fault('PATH_ERROR', 'Plugin configuration must be a regular file.');
    if (current.size > 32 * 1024) throw fault('SOURCE_LIMIT', 'Plugin configuration exceeds its size bound.');
    const bytes = Buffer.alloc(32 * 1024 + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 32 * 1024) throw fault('SOURCE_LIMIT', 'Plugin configuration exceeds its size bound.');
    try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { throw fault('PLUGIN_CONFIG', 'Plugin configuration must be valid UTF-8 JSON.'); }
  } finally { fs.closeSync(fd); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fault('PLUGIN_CONFIG', 'Plugin configuration must be an object.');
  return { root, config };
}

module.exports = { readPluginProjectHeader };

if (process.argv[1] === 'sol-plugin-mcp') {
  (async () => {
    const header = readPluginProjectHeader(process.cwd());
    const launcher = header?.config.plugin_launcher;
    if (typeof launcher !== 'string' || !launcher || launcher.length > 4096 || /[\r\n]/u.test(launcher) || !path.isAbsolute(launcher))
      throw fault('PLUGIN_CONFIG', 'Set plugin_launcher to the installed plugin launcher absolute path.');
    const info = fs.lstatSync(launcher);
    if (info.isSymbolicLink() || !info.isFile() || path.basename(launcher) !== 'plugin-launcher.mjs')
      throw fault('PLUGIN_CONFIG', 'The configured plugin launcher must be a regular plugin-launcher.mjs file.');
    // This is an explicit executable entry in a trusted project, not inferred
    // from caches, another chat, or a mutable global "last project" pointer.
    process.argv = [process.execPath, fs.realpathSync.native(launcher), 'mcp'];
    await import(pathToFileURL(process.argv[1]).href);
  })().catch(() => {
    process.stderr.write('SoL plugin startup failed (PLUGIN_CONFIG). Inspect plugin_launcher in .codex/sol-project.json.\n');
    process.exitCode = 2;
  });
}
