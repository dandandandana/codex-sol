// Opt-in real CLI acceptance. Requires an existing Codex executable and login.
// Only synthetic files under ignored slop/ and invocation-local trust are used.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = fileURLToPath(import.meta.url);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const rows = (text) => text.split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const flag = (name) => process.argv[process.argv.indexOf(name) + 1];

if (process.argv.includes('--hook')) {
  await appendFile(flag('--log'), JSON.stringify({ stage: 'entry' }) + '\n');
  process.stdin.setEncoding('utf8');
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const child = spawn(process.execPath, [join(repo, 'src/context-hook.mjs'), '--workspace', flag('--workspace'), '--rules', 'context.json'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  child.stdout.setEncoding('utf8'); let output = ''; child.stdout.on('data', (part) => { output += part; }); child.stdin.end(input);
  const code = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); });
  const event = JSON.parse(input);
  await appendFile(flag('--log'), JSON.stringify({ event: event.hook_event_name, source: event.source, session_id: event.session_id, turn_id: event.turn_id, result: JSON.parse(output), exit_code: code }) + '\n');
  process.stdout.write(output); process.exitCode = code;
} else if (process.argv.includes('--mcp')) {
  // Retain only synthetic tool traffic and thread/turn identities, never prompt metadata.
  const child = spawn(process.execPath, [join(repo, 'src/server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const record = async (direction, line) => {
    const value = JSON.parse(line); const meta = value.params?._meta?.['x-codex-turn-metadata'];
    if (value.params?._meta) delete value.params._meta;
    if (meta) value.host = { thread_id: meta.thread_id, turn_id: meta.turn_id };
    if (value.method === 'tools/call' || value.result?.content) await appendFile(process.env.CODEX_SOL_TEST_LOG, JSON.stringify({ direction, ...value }) + '\n');
  };
  for (const [stream, direction, target] of [[process.stdin, 'request', child.stdin], [child.stdout, 'response', process.stdout]]) {
    (async () => { for await (const line of createInterface({ input: stream })) { await record(direction, line); target.write(line + '\n'); } if (direction === 'request') child.stdin.end(); })().catch((error) => { process.stderr.write(error.message + '\n'); child.kill(); process.exitCode = 1; });
  }
  child.once('error', (error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  child.once('close', (code) => { process.exitCode = code ?? 1; });
} else {
  const executable = process.argv.includes('--codex') ? resolve(flag('--codex')) : process.env.CODEX_SOL_HOST_EXECUTABLE;
  assert.ok(executable, 'Pass --codex with the existing Codex executable path.');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  const quote = (path) => { assert.ok(!/["$`\r\n]/u.test(path), 'Unsupported shell characters in fixture path'); return `"${path.replaceAll('\\', '/')}"`; };
  await mkdir(join(repo, 'slop'), { recursive: true });
  const run = await mkdtemp(join(repo, 'slop/context hook-'));
  const root = join(run, 'workspace'); await mkdir(join(root, '.codex'), { recursive: true });
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  await writeFile(join(root, 'README.md'), 'Synthetic Context fixture. Reuse the existing cancellation capability.\n');
  await writeFile(join(root, 'upload.mjs'), 'export const upload = 1;\n');
  await writeFile(join(root, 'context.json'), await readFile(join(repo, 'context.example.json')));
  await writeFile(join(root, 'rules.json'), JSON.stringify({ schema_version: 1, rules: [] }));
  await writeFile(join(root, '.codex/config.toml'), '[features]\nhooks = true\n');
  const hookLog = join(run, 'hooks.jsonl'); const wireLog = join(run, 'wire.jsonl');
  await writeFile(hookLog, ''); await writeFile(wireLog, '');
  // Bare node works with both PowerShell and cmd; a quoted executable needs shell-specific invocation syntax.
  const command = `node ${quote(here)} --hook --workspace ${quote(root)} --log ${quote(hookLog)}`;
  const group = [{ hooks: [{ type: 'command', command, timeout: 30 }] }];
  const definition = (startup) => ({ hooks: { ...(startup ? { SessionStart: group } : {}), UserPromptSubmit: group } });
  await writeFile(join(root, '.codex/hooks.json'), JSON.stringify(definition(true)));
  // CLI dotted paths do not unquote table keys. Use a TOML inline table for the literal Windows path.
  const trustProject = `projects={${JSON.stringify(root.toLowerCase())}={trust_level="trusted"}}`;

  async function listHooks() {
    const child = spawn(executable, ['app-server', '-c', trustProject, '-c', 'features.hooks=true'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.resume(); let seq = 0; const pending = new Map();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => { const value = JSON.parse(line); const slot = pending.get(value.id); if (slot) { pending.delete(value.id); value.error ? slot.reject(new Error(value.error.message)) : slot.resolve(value.result); } });
    child.once('error', (error) => { for (const slot of pending.values()) slot.reject(error); });
    child.once('close', () => { for (const slot of pending.values()) slot.reject(new Error('Hook preflight exited')); });
    const request = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      await request('initialize', { clientInfo: { name: 'sol_hook_acceptance', version: '1' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      const result = await request('hooks/list', { cwds: [root] });
      const entry = result.data[0]; assert.deepEqual(entry.errors, []); assert.deepEqual(entry.warnings, []); assert.equal(entry.hooks.length, 2);
      for (const hook of entry.hooks) { assert.equal(hook.sourcePath, join(root, '.codex/hooks.json')); assert.equal(hook.command, command); assert.equal(hook.enabled, true); }
      return entry.hooks;
    } finally { clearTimeout(timer); child.stdin.end(); child.kill(); lines.close(); }
  }
  const listed = await listHooks();
  // Hash trust for these two reviewed commands only; no bypass or global config write.
  const trustHooks = `hooks.state={${listed.map((h) => `${JSON.stringify(h.key)}={trusted_hash=${JSON.stringify(h.currentHash)}}`).join(',')}}`;
  const common = ['--ignore-user-config', '--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-c', 'features.hooks=true', '-c', 'model_reasoning_effort="low"', '-c', trustProject, '-c', trustHooks,
    '-c', `mcp_servers.codex_sol.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.codex_sol.args=[${JSON.stringify(here)},"--mcp"]`];
  for (const [key, value] of Object.entries({ CODEX_SOL_WORKSPACE: root, CODEX_SOL_RULES: join(root, 'rules.json'), CODEX_SOL_CONTEXT_RULES: join(root, 'context.json'), CODEX_SOL_TEST_LOG: wireLog })) common.push('-c', `mcp_servers.codex_sol.env.${key}=${JSON.stringify(value)}`);
  async function runTurn(label, resume, prompt) {
    const before = hash(await readFile(join(root, 'upload.mjs')));
    const args = ['exec', '-C', root, '-s', 'workspace-write', ...(resume ? ['resume', resume] : []), ...common, prompt];
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); let stdout = ''; let stderr = '';
    child.stdout.on('data', (part) => { stdout += part; }); child.stderr.on('data', (part) => { stderr += part; });
    const timer = setTimeout(() => { if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill(); }, 120000);
    const code = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); }); clearTimeout(timer);
    await writeFile(join(run, `${label}-events.jsonl`), stdout); await writeFile(join(run, `${label}-stderr.txt`), stderr);
    assert.equal(code, 0, `${label} CLI failed; inspect ignored run diagnostics`);
    assert.equal(hash(await readFile(join(root, 'upload.mjs'))), before);
    const events = rows(stdout); assert.ok(!events.some((e) => e.type === 'turn.failed'));
    const result = { thread_id: events.find((e) => e.type === 'thread.started')?.thread_id, final: events.filter((e) => e.item?.type === 'agent_message').at(-1)?.item.text };
    console.log(JSON.stringify({ phase: label, ...result })); return result;
  }
  const readonly = '这是隔离验收。只读，不写文件，不用 Shell、Skill、子 agent，不提交产物，不声称实现完成。';
  const first = await runTurn('startup', null, `${readonly}请为任务 {"id":"host-hook-test","goal":"检查上传复用能力","constraints":["复用既有取消能力"]} 用 plan 职责准备 upload.mjs 的 Context，拿到结果后直接结束。`);
  assert.ok(first.thread_id);
  await writeFile(join(root, 'upload.mjs'), 'export const upload = 2;\n');
  // Isolate UserPromptSubmit: SessionStart would otherwise refresh the binding before this event.
  await writeFile(join(root, '.codex/hooks.json'), JSON.stringify(definition(false)));
  const stale = await runTurn('stale-prompt', first.thread_id, `${readonly}继续此前任务，先说明本轮实际收到的上下文状态，再按需要准备当前材料。`);
  await writeFile(join(root, 'upload.mjs'), 'export const upload = 3;\n');
  await writeFile(join(root, '.codex/hooks.json'), JSON.stringify(definition(true)));
  const restored = await runTurn('resume', first.thread_id, `${readonly}根据本轮实际收到的恢复内容说明任务、职责、状态和 Context 引用；本轮无需调用工具。`);
  const hooks = rows(await readFile(hookLog, 'utf8')).filter((r) => r.event);
  assert.equal(hooks.length, 5); assert.ok(hooks.every((h) => h.exit_code === 0 && h.session_id === first.thread_id));
  const payload = (h) => h.result.hookSpecificOutput ? JSON.parse(h.result.hookSpecificOutput.additionalContext) : null;
  assert.equal(payload(hooks[0]).kind, 'context_entry'); assert.deepEqual(hooks[1].result, {});
  assert.equal(hooks[2].event, 'UserPromptSubmit'); assert.equal(payload(hooks[2]).freshness, 'stale'); assert.equal(payload(hooks[2]).kind, 'context_reminder');
  assert.equal(hooks[3].source, 'resume'); assert.equal(payload(hooks[3]).kind, 'context_restore'); assert.equal(payload(hooks[3]).status, 'ready'); assert.deepEqual(hooks[4].result, {});
  assert.match(stale.final, /context_reminder|stale|过期/u); assert.ok(restored.final.includes(payload(hooks[3]).context.handle), 'Model did not report the injected recovery reference');
  const evidence = { schema_version: 1, date: new Date().toISOString(), host: version, status: 'cli_hooks_passed', configuration: { project_trust: 'literal path inline table', hook_trust: 'reviewed hashes in invocation-local hooks.state', bypass: false, global_config_changed: false, fixture_path_contains_spaces: true }, root_causes: ['Quoted executable was not invoked by PowerShell; bare node command works.', 'Quoted CLI dotted path preserved quotes in project key; literal TOML projects table works.'], turns: { first, stale, restored }, hooks, wire: rows(await readFile(wireLog, 'utf8')), source_unchanged_during_model_turns: true, limits: ['No interactive trust UI acceptance', 'No Desktop Context acceptance', 'No actual compact acceptance', 'No M-002 change-state gates'] };
  const output = join(run, 'evidence.json'); await writeFile(output, JSON.stringify(evidence, null, 2) + '\n'); console.log(`Evidence: ${output}`);
}
