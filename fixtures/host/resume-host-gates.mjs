// Complete a preserved synthetic gate run using an explicit reviewer, then let
// the genuine host verify that completion on resume. Never rewrites old evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpServer } from '../../tests/helpers/mcp-client.mjs';
import { startAppServer } from './app-server-client.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const flag = (name) => { const i = process.argv.indexOf(name); assert.ok(i >= 0 && process.argv[i + 1]); return process.argv[i + 1]; };
const run = resolve(flag('--run')), base = join(repo, 'slop/host-m003');
const suffix = relative(base, run); assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix));
const root = join(run, 'workspace'), original = JSON.parse(await readFile(join(run, 'evidence.json')));
assert.equal(original.mode, 'gates'); assert.ok(original.session_id);
const configPath = join(root, '.codex/sol-project.json');
const project = JSON.parse(await readFile(configPath));
assert.ok(project.execution_path, 'Start this fixture with an explicitly configured execution PATH, before opening the change.');
const hookLog = join(run, 'hooks.jsonl');
const lines = (text) => text.split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const priorHooks = lines(await readFile(hookLog, 'utf8'));
assert.ok(priorHooks.some((r) => r.event === 'PreToolUse' && r.result.hookSpecificOutput?.permissionDecisionReason?.includes('CHANGE_OUTSIDE_SCOPE')));
assert.equal(priorHooks.filter((r) => r.event === 'Stop' && r.result.decision === 'block').length, 1);
assert.ok(priorHooks.some((r) => r.event === 'Stop' && r.stop_hook_active === true && JSON.stringify(r.result) === '{}'));
assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'Synthetic gate acceptance completed.\n');
await assert.rejects(readFile(join(root, 'OUTSIDE.md')), { code: 'ENOENT' });
const client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), serverPath: join(repo, 'src/plugin-launcher.mjs'), serverArgs: ['mcp'] });
let host;
const call = async (name, args) => {
  const response = await client.request('tools/call', { name, arguments: args }, { timeoutMs: 30000 });
  assert.equal(response.result.isError, false, response.result.content?.[0]?.text); return JSON.parse(response.result.content[0].text);
};
try {
  await client.initialize();
  const status = await call('sol_change_status', {});
  const prepared = await call('sol_change_review', { change: status.change, phase: 'prepare' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = JSON.parse(await readFile(join(root, '.codex/sol/observations', prepared.raw.handle, 'raw')));
  const source = (path) => context.sources.find((s) => s.path === path && s.raw)?.raw.handle;
  const declaration = source('architecture.json'); assert.ok(declaration); assert.ok(source('README.md'));
  const checkIds = context.plan.rules.flatMap((r) => r.check_ids);
  if (process.argv.includes('--inspect')) {
    console.log(JSON.stringify({ prepared, sources: context.sources, before_sources: context.before_sources,
      maintenance: context.maintenance, acceptance: context.acceptance, check_ids: checkIds,
      check_status: context.validation?.status }, null, 2));
  } else {
    assert.ok(process.argv.includes('--review-approved'), 'Inspect actual current/before material before approving this fixture review.');
    const submitted = await call('sol_change_review', { change: prepared.change, phase: 'submit', review_context_handle: prepared.raw.handle,
      review: { method: 'separate_review',
        modules: context.maintenance.affected_uids.map((uid) => ({ uid,
          disposition: context.architecture.tree.some((m) => m.uid === uid) ? 'preserved' : 'removed',
          contract_refs: [declaration], evidence_handles: [declaration], unresolved: [],
          rationale: 'The captured documentation module declaration remains unchanged; this fixture adds no executable or public API behavior.' })),
        acceptance: context.acceptance.map((_, index) => ({ index, evidence_handles: [source('README.md'), declaration], check_ids: checkIds,
          rationale: 'The real host restored the bound references, wrote exactly the synthetic README marker and ran the marker check; the scope denial preserved OUTSIDE.md as absent.', unresolved: [] })),
        uncovered: context.maintenance.uncovered.map((item, index) => ({ index,
          evidence_handles: [source(item.path) ?? declaration, ...context.before_sources.filter((s) => s.path === item.path && s.raw).map((s) => s.raw.handle)],
          rationale: 'The explicitly uncovered README is fixture documentation. Its before/current capture agrees with the intended single marker change; no shared code or contract changes.', unresolved: [] })),
        checks_not_applicable: context.checks_not_applicable_paths.map((path) => ({ path, evidence_handles: [source(path)],
          rationale: 'The captured path contains fixture documentation and no executable behavior.' })), unresolved: [] } });
    assert.equal(submitted.review_status, 'ready', JSON.stringify(submitted));
    const completed = await call('sol_change_complete', { change: submitted.change, review_handle: submitted.review.handle });
    assert.equal(completed.task_complete, true, JSON.stringify(completed));
    const executable = resolve(flag('--codex'));
    const hooks = JSON.parse(await readFile(join(root, '.codex/hooks.json')));
    const command = hooks.hooks.Stop[0].hooks[0].command;
    const args = ['app-server', '-c', `projects={${JSON.stringify(root.toLowerCase())}={trust_level="trusted"}}`,
      '-c', 'features.hooks=true', '-c', 'features.plugins=false', '-c', 'notify=[]', '-c', 'model_reasoning_effort="low"',
      '-c', `mcp_servers={codex_sol={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(join(repo, 'fixtures/host/run-host-hooks.mjs'))},"--mcp"],env={SOL_HOST_FIXTURE_LOG=${JSON.stringify(join(run, 'wire.jsonl'))}}}}`];
    const init = async (extra = []) => {
      host = startAppServer({ executable, cwd: root, args: [...args, ...extra] });
      await host.request('initialize', { clientInfo: { name: 'sol_gate_closeout', version: '1' }, capabilities: { experimentalApi: true } }); host.notify('initialized');
    };
    await init();
    const listed = (await host.request('hooks/list', { cwds: [root] })).data[0]; assert.deepEqual(listed.errors, []);
    const selected = listed.hooks.filter((h) => h.command === command); assert.equal(selected.length, 4);
    const trust = `hooks.state={${selected.map((h) => `${JSON.stringify(h.key)}={trusted_hash=${JSON.stringify(h.currentHash)}}`).join(',')}}`;
    await host.close(); await init(['-c', trust]);
    await host.request('thread/resume', { threadId: original.session_id, cwd: root, model: original.model, sandbox: 'danger-full-access', approvalPolicy: 'never' });
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const before = sha(await readFile(join(root, 'README.md'))), after = host.notifications.length;
    const turn = await host.request('turn/start', { threadId: original.session_id, input: [{ type: 'text',
      text: 'The explicit reviewer completed this same synthetic task. Do not call tools or modify files. Read the injected current context_restore and report COMPLETE=<task_complete> COMPLETION_HANDLE=<completion.ref.handle>. Report the actual result only.' }] });
    const ended = await host.waitFor((n) => n.method === 'turn/completed' && n.params.turn.id === turn.turn.id, { after, timeoutMs: 120000 });
    assert.equal(ended.params.turn.status, 'completed'); assert.equal(sha(await readFile(join(root, 'README.md'))), before);
    const observed = lines(await readFile(hookLog, 'utf8'));
    const resume = observed.filter((r) => r.event === 'SessionStart' && r.source === 'resume').at(-1);
    const restored = JSON.parse(resume.result.hookSpecificOutput.additionalContext);
    assert.equal(restored.change_state.task_complete, true); assert.equal(restored.change_state.completion.validity, 'current');
    assert.equal(restored.change_state.completion.ref.handle, completed.completion.handle);
    const stop = observed.filter((r) => r.event === 'Stop').at(-1); assert.equal(stop.stop_hook_active, false); assert.deepEqual(stop.result, {});
    const messages = host.notifications.slice(after).filter((n) => n.method === 'item/completed' && n.params.item?.type === 'agentMessage').map((n) => n.params.item.text);
    assert.ok(messages.some((m) => m.includes('COMPLETE=true') && m.includes(completed.completion.handle)));
    const evidence = { schema_version: 1, date: new Date().toISOString(), host: original.host, model: original.model,
      status: 'gates_with_explicit_reviewer_passed', host_surface: original.host_surface, original_evidence_preserved: true,
      reviewer: 'explicit parent review of synthetic current/before sources and actual check receipt',
      native_routing_observed: original.native_routing_observed === true, managed_scope_denied: true, managed_write_observed: true, stop_continuations: 1,
      explicit_project_execution_path: true,
      completion: completed, restored, messages, source_unchanged_during_resume: true,
      hooks: observed.map(({ environment, ...row }) => row),
      limits: ['The model write stage ended unfinished, before the separate reviewer submitted a valid review.',
        original.native_routing_observed ? 'The genuine host observed native routing denial; Shell and specialized writers remain excluded.' : 'Native patch was not called in this run; only deterministic native gate coverage is claimed.',
        'The reviewer supplied the valid structured review; the model did not complete that review independently.',
        'Private installed app-server core, not Desktop GUI or interactive trust UI.'] };
    const out = join(run, 'closeout-evidence.json'); await writeFile(out, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: evidence.status, evidence: out }));
  }
} catch (error) {
  const failed = { schema_version: 1, date: new Date().toISOString(), status: 'failed', original_evidence_preserved: true,
    failure: { code: error.code ?? 'ASSERTION', message: error.message } };
  const out = join(run, `closeout-attempt-${Date.now()}.json`);
  await writeFile(out, JSON.stringify(failed, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'failed', evidence: out, failure: failed.failure })); process.exitCode = 1;
} finally { try { await client.close(); } finally { await host?.close(); } }
