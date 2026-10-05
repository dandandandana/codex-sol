// Opt-in real host fixture. Synthetic project, invocation-local trust, existing login.
// App-server execution is core acceptance, not a claim of Desktop GUI acceptance.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppServer } from './app-server-client.mjs';
import { startMcpServer } from '../../tests/helpers/mcp-client.mjs';
import { pluginExecutionEnvironment } from '../../src/plugin-launcher.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url)), here = fileURLToPath(import.meta.url);
const launcher = join(repo, 'src/plugin-launcher.mjs');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rows = (text) => text.split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const flag = (name) => { const i = process.argv.indexOf(name); assert.ok(i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), 'Missing ' + name); return process.argv[i + 1]; };
const environment = () => ({ sha256: sha(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)))),
  keys: Object.keys(process.env).sort(),
  execution_entries: Object.entries(pluginExecutionEnvironment()).map(([key, value]) => [key, sha(value)]),
}); // Names/hashes only, never values; detailed adapter diagnostics stay ignored.

if (process.argv.includes('--hook')) {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; assert.ok(Buffer.byteLength(input) <= 128 * 1024); }
  const event = JSON.parse(input);
  const child = spawn(process.execPath, [launcher, 'hook'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output += chunk; }); child.stdin.end(input);
  const code = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); });
  const result = JSON.parse(output);
  await appendFile(flag('--log'), JSON.stringify({ event: event.hook_event_name, source: event.source,
    session_id: event.session_id, turn_id: event.turn_id, stop_hook_active: event.stop_hook_active, tool_name: event.tool_name,
    result, exit_code: code, environment: environment() }) + '\n');
  process.stdout.write(output); process.exitCode = code;
} else if (process.argv.includes('--mcp')) {
  const log = process.env.SOL_HOST_FIXTURE_LOG;
  await appendFile(log, JSON.stringify({ stage: 'mcp_entry', environment: environment() }) + '\n');
  const child = spawn(process.execPath, [launcher, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const record = async (direction, line) => {
    const value = JSON.parse(line), meta = value.params?._meta?.['x-codex-turn-metadata'];
    if (value.params?._meta) delete value.params._meta;
    if (meta) value.host = { thread_id: meta.thread_id, turn_id: meta.turn_id };
    if (value.method === 'tools/call' || value.result?.content)
      await appendFile(log, JSON.stringify({ direction, ...value }) + '\n');
  };
  for (const [stream, direction, target] of [[process.stdin, 'request', child.stdin], [child.stdout, 'response', process.stdout]]) {
    (async () => { for await (const line of createInterface({ input: stream })) { await record(direction, line); target.write(line + '\n'); } if (direction === 'request') child.stdin.end(); })()
      .catch(() => { child.kill(); process.exitCode = 1; });
  }
  child.once('error', () => { process.exitCode = 1; }); child.once('close', (code) => { process.exitCode = code ?? 1; });
} else {
  const executable = resolve(flag('--codex'));
  const gates = process.argv.includes('--gates');
  const model = process.argv.includes('--model') ? flag('--model') : 'gpt-6-luna';
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  await mkdir(join(repo, 'slop/host-m003'), { recursive: true });
  const run = await mkdtemp(join(repo, 'slop/host-m003/host-'));
  const root = join(run, 'workspace'); await mkdir(join(root, '.codex'), { recursive: true });
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  const hookLog = join(run, 'hooks.jsonl'), wireLog = join(run, 'wire.jsonl');
  await writeFile(hookLog, ''); await writeFile(wireLog, '');
  await writeFile(join(root, 'README.md'), 'Synthetic host fixture documentation.\n');
  await writeFile(join(root, 'rules.json'), JSON.stringify({ schema_version: 1, rules: gates ? [{ schema_version: 1,
    id: 'documentation', reuse: 'watched_inputs', globs: ['README.md'], watch_paths: ['README.md'], commands: [{ id: 'marker',
      argv: [process.execPath, '-e', 'if(require("node:fs").readFileSync("README.md","utf8")!=="Synthetic gate acceptance completed.\\n")process.exit(7);process.stdout.write("marker-check-passed\\n")'],
      cwd: '.', timeout_ms: 3000 }] }] : [] }));
  const context = JSON.parse(await readFile(join(repo, 'context.example.json'), 'utf8'));
  if (gates) context.roles = [{ id: 'maintain', goal: 'Maintain and close the synthetic documentation change.',
    allowed_operations: ['read', 'maintain_documentation', 'review', 'complete'], sources: [{ path: 'README.md', required: true }],
    require_targets: true, output_schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] }, consumers: [] }];
  context.architecture = { path: 'architecture.json' };
  await writeFile(join(root, 'context.json'), JSON.stringify(context));
  await writeFile(join(root, 'architecture.json'), JSON.stringify({ schema_version: 1, modules: [{ id: 'docs', uid: '00000001', parent: null,
    name: { zh: '文档', en: 'Documentation' }, description: { zh: '合成宿主验收', en: 'Synthetic host fixture' },
    source: [], apis: [], fingerprint: 'pending', revision: '0'.repeat(40), updated_at: new Date().toISOString() }],
    policy: { schema_version: 1, updated_at: new Date().toISOString(), rules: [] } }));
  await writeFile(join(root, '.codex/sol-project.json'), JSON.stringify({ schema_version: 1, validation_rules: 'rules.json',
    context_rules: 'context.json', execution_path: process.env.PATH ?? process.env.Path }));
  const quote = (path) => { assert.ok(!/["$`\r\n]/u.test(path)); return '"' + path.replaceAll('\\', '/') + '"'; };
  const command = `node ${quote(here)} --hook --log ${quote(hookLog)}`;
  const definitions = (startup = true, stop = false) => ({ hooks: {
    ...(startup ? { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 30 }] }] } : {}),
    UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 30 }] }],
    PreToolUse: [{ matcher: '^(apply_patch|Edit|Write|mcp__.+__sol_apply_(patch|changes))$', hooks: [{ type: 'command', command, timeout: 30 }] }],
    ...(stop ? { Stop: [{ hooks: [{ type: 'command', command, timeout: 30 }] }] } : {}),
  } });
  const hooksPath = join(root, '.codex/hooks.json');
  await writeFile(hooksPath, JSON.stringify(definitions(true, gates)));
  await writeFile(join(root, '.codex/config.toml'), '[features]\nhooks = true\n');
  const trust = `projects={${JSON.stringify(root.toLowerCase())}={trust_level="trusted"}}`;
  const base = ['app-server', '-c', trust, '-c', 'features.hooks=true', '-c', 'features.plugins=false', '-c', 'notify=[]',
    '-c', 'model_reasoning_effort="low"', '-c', `mcp_servers={codex_sol={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(here)},"--mcp"],env={SOL_HOST_FIXTURE_LOG=${JSON.stringify(wireLog)}}}}`];
  let host, client, id; const evidence = { schema_version: 1, date: new Date().toISOString(), host: version, model,
    host_surface: 'private stdio app-server using the installed host core', status: 'running',
    mode: gates ? 'gates' : 'lifecycle',
    configuration: { hook_trust_bypass: false, global_config_changed: false, standalone_seed_then_real_model_prepare: true }, turns: [] };
  const save = async () => writeFile(join(run, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  const init = async (args) => {
    host = startAppServer({ executable, cwd: root, args });
    await host.request('initialize', { clientInfo: { name: 'sol_m003_host_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    host.notify('initialized');
  };
  const send = async (text, phase, { allowWrite = false } = {}) => {
    const before = sha(await readFile(join(root, 'README.md'))), after = host.notifications.length;
    const reply = await host.request('turn/start', { threadId: id, input: [{ type: 'text', text }] });
    const note = await host.waitFor((n) => n.method === 'turn/completed' && n.params.turn.id === reply.turn.id, { after, timeoutMs: 150000 });
    const items = host.notifications.slice(after).filter((n) => n.method === 'item/completed').map((n) => n.params.item);
    const result = { phase, turn_id: reply.turn.id, status: note.params.turn.status, error: note.params.turn.error,
      messages: items.filter((item) => item.type === 'agentMessage').map((item) => item.text),
      tools: items.filter((item) => item.type === 'mcpToolCall').map((item) => ({ server: item.server, tool: item.tool, status: item.status })) };
    evidence.turns.push(result); await save();
    assert.equal(note.params.turn.status, 'completed', JSON.stringify(note.params.turn.error));
    if (!allowWrite) assert.equal(sha(await readFile(join(root, 'README.md'))), before, 'Read-only model acceptance must not change source.');
    console.log(JSON.stringify({ phase, status: result.status, messages: result.messages, tools: result.tools }));
    return result;
  };
  try {
    await init(base);
    const listed = (await host.request('hooks/list', { cwds: [root] })).data[0]; assert.deepEqual(listed.errors, []);
    const selected = listed.hooks.filter((h) => h.command === command); assert.equal(selected.length, gates ? 4 : 3);
    const hooksTrust = `hooks.state={${selected.map((h) => `${JSON.stringify(h.key)}={trusted_hash=${JSON.stringify(h.currentHash)}}`).join(',')}}`;
    await host.close(); await init([...base, '-c', hooksTrust]);
    const available = (await host.request('model/list', {})).data; assert.ok(available.some((m) => m.model === model), 'Requested model must be offered by the host.');
    client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), serverPath: launcher, serverArgs: ['mcp'] }); await client.initialize();
    const call = async (name, args) => {
      const reply = await client.request('tools/call', { name, arguments: args });
      assert.equal(reply.result.isError, false, reply.result.content?.[0]?.text);
      return JSON.parse(reply.result.content[0].text);
    };
    const query = await call('sol_architecture_query', { paths: ['README.md'] });
    const task = { id: 'host-documentation', goal: gates ? 'Exercise one bound synthetic documentation write and its real closeout.' : 'Verify real host lifecycle without changing project source.',
      constraints: [gates ? 'Only the synthetic README.md is writable.' : 'Read-only host acceptance.'] };
    const opened = await call('sol_change_open', { task: { id: task.id, goal: task.goal }, requirement_ref: 'README.md: synthetic acceptance',
      scope: [{ path: 'README.md', module_uid: '00000001' }], acceptance: [gates ? 'The exact synthetic README marker is present and its required check passes.' : 'Lifecycle restores exact current references.'],
      expected_architecture_version: query.version, reuse: { decision: 'not_applicable', reason: 'Documentation fixture.', query_handle: query.raw.handle } });
    evidence.change = opened.change;
    const started = await host.request('thread/start', { cwd: root, model, sandbox: 'danger-full-access', approvalPolicy: 'never' }); id = started.thread.id;
    evidence.session_id = id;
    const args = { task, role: gates ? 'maintain' : 'plan', targets: ['README.md'], change: opened.change };
    if (gates) {
      const patch = '*** Begin Patch\n*** Update File: README.md\n@@\n-Synthetic host fixture documentation.\n+Synthetic gate acceptance completed.\n*** End Patch';
      await send('Synthetic gate acceptance only. First call codex_sol sol_context_prepare with ' + JSON.stringify(args)
        + '. Then attempt the native apply_patch tool once with ' + JSON.stringify(patch) + '; its Hook should deny routing. Do not use a Shell fallback.'
        + ' Next attempt sol_apply_changes once with ' + JSON.stringify({ change: opened.change, changes: [{ action: 'write', path: 'OUTSIDE.md', content: 'This must not be created.' }] }) + '; its Hook should deny scope.'
        + ' Then call sol_apply_changes with ' + JSON.stringify({ change: opened.change, changes: [{ action: 'write', path: 'README.md', content: 'Synthetic gate acceptance completed.\n' }] }) + '. Read its actual validation and new change binding.'
        + ' End your initial answer by reporting partial progress only; do not call review or complete before that initial answer. A separate explicit reviewer will submit the structured review. If a Stop continuation is supplied later, call sol_change_review prepare once, then report its actual current reference and unfinished status; do not submit the separate reviewer output or complete on their behalf. Do not modify any other file or call external services.',
      'write-and-stop', { allowWrite: true });
      const observed = rows(await readFile(hookLog, 'utf8'));
      evidence.native_routing_observed = observed.some((r) => r.event === 'PreToolUse' && ['apply_patch', 'Edit', 'Write'].includes(r.tool_name)
        && r.result.hookSpecificOutput?.permissionDecision === 'deny');
      assert.ok(observed.some((r) => r.event === 'PreToolUse' && r.result.hookSpecificOutput?.permissionDecisionReason?.includes('CHANGE_OUTSIDE_SCOPE')), 'MCP scope denial must be observed from the real host.');
      assert.ok(observed.some((r) => r.event === 'PreToolUse' && r.tool_name?.includes('sol_apply_changes') && JSON.stringify(r.result) === '{}'), 'Managed write pass must be observed from the real host.');
      await assert.rejects(readFile(join(root, 'OUTSIDE.md')), { code: 'ENOENT' });
      assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'Synthetic gate acceptance completed.\n');
      const stops = observed.filter((r) => r.event === 'Stop'); assert.equal(stops.filter((r) => r.result.decision === 'block').length, 1);
      assert.ok(stops.some((r) => r.stop_hook_active === true && JSON.stringify(r.result) === '{}'), 'Stop must not continue its own continuation.');
      const current = await call('sol_change_status', {}); assert.equal(current.task_complete, false, JSON.stringify(current));
      evidence.current = current;
      evidence.status = 'write_and_bounded_stop_core_passed';
      evidence.hooks = rows(await readFile(hookLog, 'utf8')).map(({ environment, ...row }) => row);
      evidence.wire = rows(await readFile(wireLog, 'utf8')).filter((r) => r.direction);
      evidence.limits = ['App-server core, not Desktop GUI or interactive TUI.', 'Native routing coverage is reported only if the model actually calls it; MCP scope/write and bounded Stop are required.', 'Invocation-local reviewed hashes, no interactive trust UI.', 'The standalone seed opened the change; actual model prepare and writes used genuine host metadata.', 'Separate explicit reviewer closeout is a second fixture phase; this write stage is still unfinished.'];
      await save(); console.log(JSON.stringify({ phase: 'passed', evidence: join(run, 'evidence.json') }));
    } else {
    await send('Synthetic acceptance only. Call codex_sol sol_context_prepare exactly once with ' + JSON.stringify(args)
      + '. Do not call any other tool or change any source. Then report CONTEXT_HANDLE=<raw.handle> CHANGE_ID=<change_state.change.id> STATE=<change_state.state>.', 'prepare');
    const wire = rows(await readFile(wireLog, 'utf8'));
    assert.ok(wire.some((r) => r.direction === 'request' && r.params?.name === 'sol_context_prepare' && r.host?.thread_id === id), 'Prepare must have genuine host metadata.');
    const firstHooks = rows(await readFile(hookLog, 'utf8')); assert.ok(firstHooks.some((r) => r.event === 'SessionStart' && r.source === 'startup'));
    // This persistent host is already started: a later prompt does not rerun
    // SessionStart. Keep fixture configuration unchanged while observing edits.
    await writeFile(join(root, 'README.md'), 'Synthetic host fixture externally edited documentation.\n');
    const pointer = await readFile(join(root, '.codex/sol/architecture/active-change.json'));
    const archives = (await readdir(join(root, '.codex/sol/observations'))).sort();
    await send('Do not call tools. Report the injected context_reminder freshness, current change ID/state and needs_status_refresh exactly. This is the same synthetic task.', 'stale');
    assert.deepEqual(await readFile(join(root, '.codex/sol/architecture/active-change.json')), pointer);
    assert.deepEqual((await readdir(join(root, '.codex/sol/observations'))).sort(), archives);
    const reminders = rows(await readFile(hookLog, 'utf8')).filter((r) => r.event === 'UserPromptSubmit' && r.result.hookSpecificOutput);
    const reminder = reminders.map((r) => JSON.parse(r.result.hookSpecificOutput.additionalContext)).find((p) => p.kind === 'context_reminder');
    assert.equal(reminder.change_state.needs_status_refresh, true); evidence.reminder = reminder;
    await call('sol_change_status', {}); // Explicit status publishes observed facts; the Hook never does.
    await host.close(); await init([...base, '-c', hooksTrust]);
    await host.request('thread/resume', { threadId: id, cwd: root, model, sandbox: 'danger-full-access', approvalPolicy: 'never' });
    await send('Do not call tools. From the injected context_restore report CONTEXT_HANDLE=<context.handle> CHANGE_ID=<change_state.change.id> STATE=<change_state.state> COMPLETE=<change_state.task_complete>.', 'resume');
    const resumed = rows(await readFile(hookLog, 'utf8')).find((r) => r.event === 'SessionStart' && r.source === 'resume'); assert.ok(resumed);
    evidence.resume = JSON.parse(resumed.result.hookSpecificOutput.additionalContext); assert.equal(evidence.resume.kind, 'context_restore');
    const after = host.notifications.length; await host.request('thread/compact/start', { threadId: id });
    const compacted = await host.waitFor((n) => n.method === 'item/completed' && n.params.item?.type === 'contextCompaction', { after, timeoutMs: 150000 });
    evidence.compaction_item = { id: compacted.params.item.id, type: compacted.params.item.type };
    // Item completion precedes the host settling its active Compact turn.
    const compactTurn = await host.waitFor((n) => n.method === 'turn/completed', { after, timeoutMs: 150000 });
    assert.equal(compactTurn.params.turn.status, 'completed', JSON.stringify(compactTurn.params.turn.error));
    evidence.compaction_turn = { id: compactTurn.params.turn.id, status: compactTurn.params.turn.status };
    await send('After actual compaction, do not call any tools. From the new injected context_restore report CONTEXT_HANDLE=<context.handle> CHANGE_ID=<change_state.change.id> STATE=<change_state.state> COMPLETE=<change_state.task_complete>. Do not use the old summary as the reference.', 'compact');
    const compact = rows(await readFile(hookLog, 'utf8')).find((r) => r.event === 'SessionStart' && r.source === 'compact'); assert.ok(compact, 'Actual compact SessionStart must run.');
    evidence.compact = JSON.parse(compact.result.hookSpecificOutput.additionalContext); assert.equal(evidence.compact.kind, 'context_restore');
    assert.ok(evidence.turns.find((t) => t.phase === 'resume').messages.join('\n').includes(evidence.resume.context.handle), 'Resume model must report the exact new handle.');
    assert.ok(evidence.turns.find((t) => t.phase === 'compact').messages.join('\n').includes(evidence.compact.context.handle), 'Post-compact model must report the exact new handle.');
    evidence.status = 'lifecycle_core_passed'; evidence.hooks = rows(await readFile(hookLog, 'utf8')).map(({ environment, ...row }) => row);
    evidence.wire = rows(await readFile(wireLog, 'utf8')).filter((r) => r.direction);
    evidence.source_unchanged_during_model_turns = true;
    evidence.limits = ['App-server core is not a Desktop GUI or interactive TUI test.', 'Lifecycle fixture omits Stop to isolate restoration; gate host acceptance is separate.', 'Seed change was created by standalone actual MCP; task binding was prepared by the real host/model.'];
    await save(); console.log(JSON.stringify({ phase: 'passed', evidence: join(run, 'evidence.json') }));
    }
  } catch (error) {
    evidence.status = 'failed'; evidence.failure = { code: error.code ?? 'ASSERTION', message: error.message };
    await save(); console.log(JSON.stringify({ phase: 'failed', evidence: join(run, 'evidence.json'), failure: evidence.failure })); process.exitCode = 1;
  } finally { try { await client?.close(); } finally { await host?.close(); } }
}
