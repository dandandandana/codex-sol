// Opt-in packaging/load acceptance in a new isolated CODEX_HOME. No login copied,
// no model request, and no modification of the user's installed plugin settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagePlugin } from '../../scripts/package-plugin.mjs';
import { startAppServer } from './app-server-client.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const i = process.argv.indexOf('--codex'); assert.ok(i >= 0 && process.argv[i + 1], 'Pass --codex with the installed executable.');
const executable = resolve(process.argv[i + 1]);
await mkdir(join(repo, 'slop/host-m003'), { recursive: true });
const run = await mkdtemp(join(repo, 'slop/host-m003/plugin-'));
const packed = await packagePlugin({ out: join(run, 'package') });
const root = join(run, 'workspace'), home = join(run, 'home');
await mkdir(join(root, '.codex'), { recursive: true }); await mkdir(home);
execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
await writeFile(join(root, 'README.md'), 'Synthetic plugin loading acceptance.\n');
await writeFile(join(root, 'rules.json'), JSON.stringify({ schema_version: 1, rules: [] }));
const context = JSON.parse(await readFile(join(repo, 'context.example.json'), 'utf8')); context.architecture = { path: 'architecture.json' };
await writeFile(join(root, 'context.json'), JSON.stringify(context));
await writeFile(join(root, 'architecture.json'), JSON.stringify({ schema_version: 1, modules: [{ id: 'docs', uid: '00000001', parent: null,
  name: { zh: '文档', en: 'Documentation' }, description: { zh: '插件装载验收', en: 'Plugin load acceptance' }, source: [], apis: [],
  fingerprint: 'pending', revision: '0'.repeat(40), updated_at: new Date().toISOString() }],
  policy: { schema_version: 1, updated_at: new Date().toISOString(), rules: [] } }));
await writeFile(join(root, '.codex/sol-project.json'), JSON.stringify({ schema_version: 1, validation_rules: 'rules.json', context_rules: 'context.json' }));
const originalHome = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
const marketplace = join(packed.out, '.agents/plugins/marketplace.json');
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
const evidence = { schema_version: 1, date: new Date().toISOString(), host: version, status: 'running',
  model_requests: 0, isolated_codex_home: true, credentials_copied: false, global_config_changed: false,
  plugin_inventory_file_count: packed.fileCount, package_format: 'codex', hook_trust_bypass: false };
let host;
const init = async (extra = []) => {
  host = startAppServer({ executable, cwd: root, args: ['app-server', '-c', 'features.plugins=true', '-c', 'features.hooks=true', '-c', 'notify=[]',
    '-c', `projects={${JSON.stringify(root.toLowerCase())}={trust_level="trusted"}}`, ...extra] });
  await host.request('initialize', { clientInfo: { name: 'sol_plugin_load', version: '1' }, capabilities: { experimentalApi: true } }); host.notify('initialized');
};
try {
  await init();
  const before = (await host.request('plugin/read', { pluginName: 'codex-sol', marketplacePath: marketplace })).plugin;
  assert.equal(before.summary.interface.displayName, 'Codex SoL'); assert.deepEqual(before.mcpServers, ['codex_sol']);
  const installed = await host.request('plugin/install', { pluginName: 'codex-sol', marketplacePath: marketplace });
  assert.deepEqual(installed.appsNeedingAuth, []);
  await host.close(); await init(['-c', 'plugins."codex-sol@sol-local".enabled=true']);
  const detail = (await host.request('plugin/read', { pluginName: 'codex-sol', marketplacePath: marketplace })).plugin;
  evidence.plugin = { id: detail.summary.id, installed: detail.summary.installed, enabled: detail.summary.enabled,
    display_name: detail.summary.interface.displayName, mcp_servers: detail.mcpServers, hooks: detail.hooks };
  const listed = (await host.request('hooks/list', { cwds: [root] })).data[0]; assert.deepEqual(listed.errors, []);
  const selected = listed.hooks.filter((h) => h.command?.includes('plugin-launcher.mjs'));
  evidence.discovered_hooks = selected.map((h) => ({ event: h.eventName, command: h.command, enabled: h.enabled,
    current_hash: h.currentHash, trusted_hash: h.trustedHash }));
  assert.equal(selected.length, 4, 'All four plugin Hooks must be actually loaded.');
  // Legacy MCP preserves project cwd but has no plugin-root interpolation.
  // Opt in to the exact installed entry already exposed by the reviewed Hook.
  const installedLauncher = /^node "([^"\r\n]+)" hook$/u.exec(selected[0].command)?.[1];
  assert.ok(installedLauncher?.endsWith('/src/plugin-launcher.mjs'));
  await writeFile(join(root, '.codex/sol-project.json'), JSON.stringify({ schema_version: 1,
    validation_rules: 'rules.json', context_rules: 'context.json', plugin_launcher: installedLauncher }));
  evidence.explicit_project_launcher = true;
  const trust = `hooks.state={${selected.map((h) => `${JSON.stringify(h.key)}={trusted_hash=${JSON.stringify(h.currentHash)}}`).join(',')}}`;
  await host.close(); await init(['-c', 'plugins."codex-sol@sol-local".enabled=true', '-c', trust]);
  const thread = await host.request('thread/start', { cwd: root, sandbox: 'danger-full-access', approvalPolicy: 'never', ephemeral: true });
  const params = { threadId: thread.thread.id, detail: 'toolsAndAuthOnly' };
  const deadline = Date.now() + 30000;
  let server;
  do {
    const status = await host.request('mcpServerStatus/list', params, { timeoutMs: 60000 });
    server = status.data.find((s) => s.pluginId === 'codex-sol@sol-local' || s.name.includes('codex_sol'));
    if (server?.runtimeStatus !== 'starting') break;
    await new Promise((res) => setTimeout(res, 250));
  } while (Date.now() < deadline);
  assert.ok(server, 'The plugin MCP connection must be discovered.');
  evidence.mcp = { name: server.name, plugin_id: server.pluginId, runtime_status: server.runtimeStatus,
    tool_names: Object.keys(server.tools).sort(), tools_error: server.toolsError };
  assert.equal(Object.keys(server.tools).length, 13, 'Architecture opt-in should provide all thirteen existing tools.');
  assert.equal(server.toolsError, null); assert.equal(server.runtimeStatus, 'connected');
  evidence.status = 'plugin_load_passed';
  evidence.limits = ['Private app-server load in isolated CODEX_HOME, not Desktop GUI installation.', 'No model or interactive trust UI used.', 'Invocation-local reviewed hash trust tests discovery/load without altering normal user settings.'];
  console.log(JSON.stringify({ status: evidence.status, hook_count: selected.length, tool_count: Object.keys(server.tools).length, evidence: join(run, 'evidence.json') }));
} catch (error) {
  evidence.status = 'failed'; evidence.failure = { code: error.code ?? 'ASSERTION', message: error.message };
  console.log(JSON.stringify({ status: 'failed', failure: evidence.failure, evidence: join(run, 'evidence.json') })); process.exitCode = 1;
} finally {
  try { await host?.close(); } finally {
    if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
    await writeFile(join(run, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
}
