import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { assertContract } from './schema.mjs';
import { validateRulesConfiguration } from './validation.mjs';
import { readWorkspaceBytes, workspaceFile } from './workspace.mjs';
import { SolFault, interruptionFault } from './store.mjs';
import { createSolServer } from './server.mjs';
import { handleContextHook } from './context-hook.mjs';
import { readPluginProjectHeader } from './plugin-bootstrap.cjs';
import { readContextConfiguration } from './architecture/context.mjs';

const check = (signal) => { if (signal?.aborted) throw interruptionFault(signal, 'Plugin configuration read was interrupted.'); };
async function atConfigurationStage(stage, action) {
  try { return await action(); }
  catch (error) { error.configurationStage ??= stage; throw error; }
}

/** The same bounded command environment in both independent adapters. This
 * matches the OS variables forwarded to local MCP on the accepted host; project
 * checks do not inherit Hook-only secrets, plugin transport fields or prompt IDs.
 * Runtime/provenance still hash the entire actual child environment unchanged. */
export function pluginExecutionEnvironment(environment = process.env, platform = process.platform, executionPath) {
  const names = platform === 'win32' ? ['APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SHELL', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP',
    'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'] : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'USER'];
  const entries = new Map(Object.entries(environment).map(([key, value]) => [platform === 'win32' ? key.toUpperCase() : key, value]));
  const result = Object.fromEntries(names.filter((name) => entries.has(name)).map((name) => [name, entries.get(name)]));
  if (executionPath !== undefined) result.PATH = executionPath;
  return result;
}

/** Resolve only the nearest Git project; never cross a nested repository barrier.
 * Without Git, opt-in belongs to the exact cwd. No env fallback or global writes.
 * Cancellation belongs to the caller. Configuration reads are bounded and safe. */
export async function resolvePluginProject(cwd, { signal } = {}) {
  check(signal);
  let header;
  try { header = await atConfigurationStage('project', () => readPluginProjectHeader(cwd)); }
  catch (error) {
    if (['PLUGIN_CONFIG', 'SOURCE_LIMIT', 'PATH_ERROR'].includes(error.code)) {
      const failure = new SolFault(error.code, error.message); failure.configurationStage = 'project'; throw failure;
    }
    throw error;
  }
  if (!header) return null;
  const root = header.root;
  let config;
  try {
    config = assertContract('PluginProjectConfig', header.config);
  } catch (error) {
    check(signal);
    if (error instanceof SolFault) throw error;
    throw new SolFault('PLUGIN_CONFIG', 'Invalid .codex/sol-project.json; use the documented project configuration contract.');
  }
  if (config.plugin_launcher) await atConfigurationStage('plugin_launcher', async () => {
    const info = await lstat(config.plugin_launcher);
    if (!isAbsolute(config.plugin_launcher) || info.isSymbolicLink() || !info.isFile())
      throw new SolFault('PLUGIN_CONFIG', 'plugin_launcher must be an actual absolute regular file.');
    const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(await realpath(config.plugin_launcher)) !== normalize(await realpath(fileURLToPath(import.meta.url))))
      throw new SolFault('PLUGIN_CONFIG', 'MCP and Hooks must use the same explicitly configured plugin launcher.');
  });
  const rulesPath = await atConfigurationStage('validation_rules', () => workspaceFile(root, config.validation_rules));
  const contextRulesPath = config.context_rules ? await atConfigurationStage('context_rules', () => workspaceFile(root, config.context_rules)) : undefined;
  for (const field of ['patch_executable', 'host_executable']) if (config[field]) await atConfigurationStage(field, async () => {
    if (!isAbsolute(config[field])) throw new SolFault('PLUGIN_CONFIG', 'Configured executables must be actual absolute file paths.');
    if (process.platform === 'linux') config[field] = await realpath(config[field]);
    if (!(await lstat(config[field])).isFile())
      throw new SolFault('PLUGIN_CONFIG', 'Configured executables must be actual absolute file paths.');
    if (process.platform === 'linux') await access(config[field], constants.X_OK).catch(() => {
      throw new SolFault('PLUGIN_CONFIG', 'Configured executables must be executable by this user.');
    });
  });
  const rules = await atConfigurationStage('validation_rules', async () => validateRulesConfiguration(JSON.parse(new TextDecoder('utf-8', { fatal: true })
    .decode(await readWorkspaceBytes(root, config.validation_rules, 256 * 1024, { signal })))));
  check(signal);
  return { workspace: root, rules, rulesPath, contextRulesPath, generated: config.generated_paths ?? [],
    patchExecutable: config.patch_executable, hostExecutable: config.host_executable, executionPath: config.execution_path };
}

/** Read-only project diagnosis. No store, transport, task, command or host start. */
export async function checkPluginConfiguration(cwd, { signal } = {}) {
  let stage = 'project';
  try {
    const project = await resolvePluginProject(cwd, { signal });
    if (!project) return { schema_version: 1, kind: 'configuration_check', status: 'not_enabled', tool_count: 0,
      diagnostics: [{ code: 'PLUGIN_NOT_ENABLED', stage, message: 'Configure this project using .codex/sol-project.json.' }] };
    let context = null;
    if (project.contextRulesPath) {
      stage = 'context_rules';
      context = await readContextConfiguration(project.workspace, relative(project.workspace, project.contextRulesPath).replaceAll('\\', '/'), { signal });
      if (context.architecture) {
        stage = 'architecture';
        await workspaceFile(project.workspace, context.architecture.path);
      }
    }
    check(signal);
    return { schema_version: 1, kind: 'configuration_check', status: 'valid',
      tool_count: context?.architecture ? 13 : context ? 6 : 4,
      validation_rule_count: project.rules.rules.length, responsibility_count: context?.roles.size ?? 0,
      generated_pattern_count: project.generated.length,
      capabilities: { context: !!context, architecture: !!context?.architecture,
        patch_executable: !!project.patchExecutable, host_cancellation_configured: !!project.hostExecutable },
      runtime: { node: process.version, platform: process.platform },
      coverage: { project_and_rules: 'validated', responsibility_contract: context ? 'validated' : 'not_configured',
        architecture_declaration: context?.architecture ? 'path_only' : 'not_configured', host_compatibility: 'not_checked' },
      diagnostics: [], next: 'Configuration checks passed. Query architecture diagnostics separately; host compatibility and task completion require their own evidence.' };
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code ?? '') ? error.code : 'CONFIG_ERROR';
    return { schema_version: 1, kind: 'configuration_check', status: 'invalid', tool_count: null,
      diagnostics: [{ code, stage: error.configurationStage ?? stage,
        message: 'Check the indicated project configuration or executable; see PLUGIN.md. Configuration could not be verified.' }] };
  }
}

/** Plugin and manual adapters share the existing core; opt-in is project local. */
export async function handlePluginHook(event, { signal } = {}) {
  const project = await resolvePluginProject(event.cwd, { signal });
  if (!project?.contextRulesPath) return {};
  return handleContextHook(event, { workspace: project.workspace, rules: project.contextRulesPath,
    validationRules: project.rulesPath, generated: project.generated, signal });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let event;
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 3 || !['mcp', 'hook', 'check-config'].includes(mode)) throw new SolFault('PLUGIN_CONFIG', 'Use plugin-launcher.mjs mcp, hook or check-config.');
    if (mode === 'check-config') {
      const report = await checkPluginConfiguration(process.cwd());
      process.stdout.write(JSON.stringify(report) + '\n');
      if (report.status !== 'valid') process.exitCode = 2;
    } else {
    if (mode === 'hook') {
      let input = ''; process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 128 * 1024) throw new SolFault('PLUGIN_CONFIG', 'Hook input exceeds its bound.');
      }
      event = JSON.parse(input);
    }
    if (process.env.SOL_PLUGIN_EXECUTION_MODE !== 'runtime') {
      const project = await resolvePluginProject(mode === 'hook' ? event.cwd : process.cwd());
      // Re-exec before core/runner work: Node itself and every validation child
      // see the same environment, rather than merely ignoring fingerprint fields.
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], { cwd: process.cwd(),
        env: { ...pluginExecutionEnvironment(process.env, process.platform, project?.executionPath), SOL_PLUGIN_EXECUTION_MODE: 'runtime' },
        stdio: [mode === 'hook' ? 'pipe' : 'inherit', 'inherit', 'inherit'], windowsHide: true });
      if (event) child.stdin.end(JSON.stringify(event));
      const code = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); });
      process.exitCode = code ?? 1;
    } else if (mode === 'mcp') {
      const project = await resolvePluginProject(process.cwd());
      if (!project) throw new SolFault('PLUGIN_CONFIG', 'Enable this project with .codex/sol-project.json; see sol-project.example.json.');
      const { server } = await createSolServer(project.workspace, project.rules, project);
      serveStdio(() => server, { onerror: () => process.stderr.write('SoL plugin MCP transport failed.\n') });
    } else {
      process.stdout.write(JSON.stringify(await handlePluginHook(event)) + '\n');
    }
    }
  } catch (error) {
    const code = error instanceof SolFault ? error.code : 'PLUGIN_CONFIG';
    if (event?.hook_event_name === 'PreToolUse') process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${code}: Plugin project configuration could not be verified; inspect .codex/sol-project.json before writing.` } }) + '\n');
    else if (event) process.stdout.write(JSON.stringify({ systemMessage: `SoL plugin configuration is unavailable (${code}); inspect .codex/sol-project.json. Task completion has not been verified.` }) + '\n');
    else { process.stderr.write(`SoL plugin startup failed (${code}). Inspect .codex/sol-project.json and the launcher mode.\n`); process.exitCode = 2; }
  }
}
