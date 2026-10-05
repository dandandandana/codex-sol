// Opt-in real Windows Codex TUI fixture. All project files and evidence stay in
// slop/host-m003/tui-<id>; no global Codex config or credential is copied.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppServer } from './app-server-client.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(import.meta.url);
const launcher = join(repo, 'src', 'plugin-launcher.mjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const rows = (text) => text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
const flag = (name, args = process.argv) => {
  const index = args.indexOf(name);
  assert.ok(index >= 0 && args[index + 1] && !args[index + 1].startsWith('--'), `Missing ${name}.`);
  return args[index + 1];
};
const quoteToml = (value) => JSON.stringify(value.replaceAll('\\', '/'));

async function childJson(command, args, input, timeoutMs = 25_000) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
  let stdout = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { stdout += chunk; });
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  child.stdin.end(input);
  let timeout;
  const result = await Promise.race([closed, new Promise((resolveTimeout) => { timeout = setTimeout(() => resolveTimeout(null), timeoutMs); })]);
  clearTimeout(timeout);
  if (!result) {
    if (process.platform === 'win32') {
      await new Promise((resolveKill) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.once('error', resolveKill); killer.once('close', resolveKill);
      });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
    await closed;
    throw new Error('Hook wrapper timed out; its owned process tree was terminated.');
  }
  assert.equal(result.code, 0, `Hook launcher exited with code ${result.code} (${result.signal ?? 'no signal'}).`);
  return JSON.parse(stdout.trim());
}

async function hookMode(args) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    assert.ok(Buffer.byteLength(input) <= 128 * 1024, 'Hook event exceeded its input bound.');
  }
  const event = JSON.parse(input);
  const result = await childJson(process.execPath, [flag('--launcher', args), 'hook'], input);
  const safeEvent = Object.fromEntries(['hook_event_name', 'source', 'session_id', 'turn_id', 'stop_hook_active', 'tool_name']
    .filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
  await appendFile(flag('--log', args), JSON.stringify({ event: safeEvent, result }) + '\n');
  process.stdout.write(JSON.stringify(result) + '\n');
}

function configArgs(root, hooksTrust) {
  const projectTrust = `projects={${JSON.stringify(root.toLowerCase())}={trust_level="trusted"}}`;
  const mcp = `mcp_servers={codex_sol={command=${quoteToml(process.execPath)},args=[${quoteToml(launcher)},"mcp"]}}`;
  return ['--no-daemon', '--no-alt-screen', '-C', root, '--sandbox', 'read-only', '--ask-for-approval', 'never',
    '--model', 'gpt-6-luna', '-c', projectTrust, '-c', hooksTrust, '-c', 'features.hooks=true',
    '-c', 'features.plugins=false', '-c', 'notify=[]', '-c', 'model_reasoning_effort="low"', '-c', mcp];
}

async function setup(args) {
  const executable = resolve(flag('--codex', args));
  const pathEntry = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1];
  assert.ok(pathEntry, 'The host PATH is required by the pinned execution environment.');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  const id = randomUUID();
  const run = join(repo, 'slop', 'host-m003', `tui-${id}`);
  const root = join(run, 'workspace');
  await mkdir(join(root, '.codex'), { recursive: true });
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  const hookLog = join(run, 'hooks.jsonl');
  const evidenceFile = join(run, 'evidence.json');
  await writeFile(hookLog, '');
  const readme = 'Synthetic TUI context acceptance.\n';
  await writeFile(join(root, 'README.md'), readme);
  await writeFile(join(root, 'rules.json'), JSON.stringify({ schema_version: 1, rules: [] }));
  const context = JSON.parse(await readFile(join(repo, 'context.example.json'), 'utf8'));
  context.architecture = { path: 'architecture.json' };
  await writeFile(join(root, 'context.json'), JSON.stringify(context));
  await writeFile(join(root, 'architecture.json'), JSON.stringify({ schema_version: 1,
    modules: [{ id: 'docs', uid: '00000001', parent: null, name: { zh: '文档', en: 'Documentation' },
      description: { zh: 'TUI 合成只读验收', en: 'Synthetic read-only TUI acceptance' }, source: [], apis: [],
      fingerprint: 'pending', revision: '0'.repeat(40), updated_at: new Date().toISOString() }],
    policy: { schema_version: 1, updated_at: new Date().toISOString(), rules: [] } }));
  await writeFile(join(root, '.codex', 'sol-project.json'), JSON.stringify({ schema_version: 1,
    validation_rules: 'rules.json', context_rules: 'context.json', generated_paths: [], execution_path: pathEntry }));

  const shellQuote = (value) => '"' + value.replaceAll('\\', '/') + '"';
  const launcherCommand = `node ${shellQuote(here)} --hook --launcher ${shellQuote(launcher)} --log ${shellQuote(hookLog)}`;
  const definitions = { hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: launcherCommand, timeout: 30 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: launcherCommand, timeout: 30 }] }],
    PreToolUse: [{ matcher: '^(apply_patch|Edit|Write|mcp__.+__sol_apply_(patch|changes))$', hooks: [{ type: 'command', command: launcherCommand, timeout: 30 }] }],
    Stop: [{ hooks: [{ type: 'command', command: launcherCommand, timeout: 30 }] }],
  } };
  await writeFile(join(root, '.codex', 'hooks.json'), JSON.stringify(definitions));
  await writeFile(join(root, '.codex', 'config.toml'), '[features]\nhooks = true\n');

  const projectTrust = `projects={${JSON.stringify(root.toLowerCase())}={trust_level="trusted"}}`;
  const mcp = `mcp_servers={codex_sol={command=${quoteToml(process.execPath)},args=[${quoteToml(launcher)},"mcp"]}}`;
  const app = startAppServer({ executable, cwd: root, args: ['app-server', '-c', projectTrust,
    '-c', 'features.hooks=true', '-c', 'features.plugins=false', '-c', 'notify=[]', '-c', 'model_reasoning_effort="low"', '-c', mcp] });
  let definitionsList;
  try {
    await app.request('initialize', { clientInfo: { name: 'sol_tui_hooks_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    app.notify('initialized');
    definitionsList = (await app.request('hooks/list', { cwds: [root] })).data[0];
  } finally { await app.close(); }
  assert.deepEqual(definitionsList.errors, []);
  const selected = definitionsList.hooks.filter((hook) => hook.command === launcherCommand);
  assert.equal(selected.length, 4, `The real host must list four TUI Hooks. ${JSON.stringify({ expected: launcherCommand,
    hooks: definitionsList.hooks.map(({ key, command, currentHash }) => ({ key, command, currentHash })) })}`);
  const hooksTrust = `hooks.state={${selected.map((hook) => `${JSON.stringify(hook.key)}={trusted_hash=${JSON.stringify(hook.currentHash)}}`).join(',')}}`;
  const cli = configArgs(root, hooksTrust);
  assert.equal(cli.includes('--dangerously-bypass-hook-trust'), false);
  const setupRecord = { schema_version: 1, date: new Date().toISOString(), host: version, model: 'gpt-6-luna',
    host_surface: 'interactive Windows TUI in a private PTY', status: 'prepared',
    workspace: 'workspace', source_sha256: hash(readme), hook_count: selected.length,
    hook_keys: selected.map((hook) => ({ key: hook.key, currentHash: hook.currentHash })),
    invocation_only: { hooks_trust: true, hook_trust_mode_bypass: false, plugins: false, hooks: true,
      mcp_command: process.execPath, mcp_args: [launcher, 'mcp'], sandbox: 'read-only', approval_policy: 'never', model_reasoning_effort: 'low' },
    run_id: id, cli_args: cli, turns: [], hooks: [] };
  await writeFile(evidenceFile, JSON.stringify(setupRecord, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ phase: 'prepared', run, workspace: root, cli_args: cli,
    hooks: setupRecord.hook_keys }) + '\n');
}

async function inspectRun(run, phase, exitCode, hostVersion) {
  const evidencePath = join(run, 'evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const hookLog = rows(await readFile(join(run, 'hooks.jsonl'), 'utf8'));
  const startup = hookLog.find((row) => row.event.hook_event_name === 'SessionStart' && row.event.source === 'startup');
  const sessionId = startup?.event.session_id ?? hookLog.find((row) => row.event.session_id)?.event.session_id;
  const runRoot = join(run, 'workspace');
  const readmeBytes = await readFile(join(runRoot, 'README.md'));
  assert.equal(hash(readmeBytes), evidence.source_sha256, 'The read-only TUI turns must not change project source.');
  if (sessionId) {
    const pointerFile = join(runRoot, '.codex', 'sol', 'context-sessions', `${hash(sessionId.toLowerCase())}.json`);
    try {
      const pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
      const stored = JSON.parse(await readFile(join(runRoot, '.codex', 'sol', 'observations', pointer.context.handle, 'raw'), 'utf8'));
      evidence.session = { id: sessionId, bound_context_handle: pointer.context.handle,
        task_id: stored.task?.id, role: stored.role?.id, kind: stored.kind };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      evidence.session = { id: sessionId, bound_context_missing: true };
    }
  }
  for (const turn of evidence.turns) turn.host_version ??= evidence.host;
  if (phase === 'initial') {
    evidence.initial_host_version = hostVersion;
    evidence.status = exitCode === 0 ? 'initial_tui_exited' : 'initial_tui_failed';
  } else {
    evidence.resume_attempts ??= evidence.turns.filter((turn) => turn.phase === 'resume')
      .map(({ host_version, exit_code }) => ({ host_version, exit_code }));
    evidence.resume_attempts.push({ host_version: hostVersion, exit_code: exitCode });
    evidence.status = 'initial_tui_exited_resume_outcomes_recorded';
  }
  evidence.turns.push({ phase, host_version: hostVersion, exit_code: exitCode });
  evidence.hooks = hookLog.map(({ event, result }) => ({ event, result }));
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
}

async function launch(args, phase) {
  const run = resolve(flag('--run', args));
  const evidence = JSON.parse(await readFile(join(run, 'evidence.json'), 'utf8'));
  const executable = resolve(flag('--codex', args));
  const hostVersion = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  const options = [...evidence.cli_args];
  let commandArgs;
  if (phase === 'resume') {
    const existing = rows(await readFile(join(run, 'hooks.jsonl'), 'utf8'));
    const start = existing.find((row) => row.event.hook_event_name === 'SessionStart' && row.event.source === 'startup');
    assert.ok(start?.event.session_id, 'The first TUI must have produced a real host session ID before resume.');
    commandArgs = ['resume', start.event.session_id, ...options];
  } else commandArgs = options;
  process.stderr.write(JSON.stringify({ phase, workspace: join(run, 'workspace'), session_id: phase === 'resume' ? commandArgs[1] : null }) + '\n');
  const child = spawn(executable, commandArgs, { cwd: join(run, 'workspace'), stdio: 'inherit', windowsHide: false, shell: false });
  const exit = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => resolveExit({ code: code ?? 1, signal }));
  });
  await inspectRun(run, phase, exit.code, hostVersion);
  process.exitCode = exit.code;
}

if (process.argv.includes('--hook')) await hookMode(process.argv);
else if (process.argv.includes('--setup')) await setup(process.argv);
else if (process.argv.includes('--launch')) await launch(process.argv, 'initial');
else if (process.argv.includes('--resume')) await launch(process.argv, 'resume');
else throw new Error('Use --setup --codex <exe>, --launch --codex <exe> --run <dir>, or --resume --codex <exe> --run <dir>.');
