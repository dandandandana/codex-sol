import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSolServer } from '../src/server.mjs';
import { ContextSessions } from '../src/architecture/session.mjs';
import { handleContextHook } from '../src/context-hook.mjs';
import { SolFault } from '../src/store.mjs';
import { ValidationEngine } from '../src/validation.mjs';

const session = '01a0ffa0-eba8-7f32-9ca8-6c105a7a3c59';
const otherSession = '01a0ffa0-ec8e-7742-977c-ee74dd9350cd';
const thirdSession = '01a0ffa0-ed2a-7e36-a20b-2204d54b4ea8';
const task = { id: 'change-hook-task', goal: 'Maintain the project documentation.', constraints: ['Keep behavior accurate.'] };
const example = JSON.parse(await readFile(new URL('../context.example.json', import.meta.url)));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-change-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), 'Documented behavior.\n');
  await writeFile(join(root, 'NOTES.md'), 'Out of scope documentation.\n');
  await writeFile(join(root, 'context.json'), JSON.stringify({ ...structuredClone(example), architecture: { path: 'architecture.json' } }));
  const rules = { schema_version: 1, rules: [] };
  await writeFile(join(root, 'rules.json'), JSON.stringify(rules));
  const architecture = { schema_version: 1, modules: [{ id: 'docs', uid: '00000001', parent: null,
    name: { zh: '文档', en: 'Documentation' }, description: { zh: '项目文档', en: 'Project documentation' },
    source: [], apis: [], fingerprint: 'pending', revision: '0'.repeat(40), updated_at: '2026-10-04T00:00:00Z' }],
    policy: { schema_version: 1, updated_at: '2026-10-04T00:00:00Z', rules: [] } };
  await writeFile(join(root, 'architecture.json'), JSON.stringify(architecture));
  const service = await createSolServer(root, rules, { contextRulesPath: join(root, 'context.json'),
    rulesPath: join(root, 'rules.json'), generated: [] });
  const { contextEngine: engine, changesEngine: changes, store } = service;
  const sessions = new ContextSessions(engine);
  const query = await engine.architectureQuery({ paths: ['README.md'] });
  const changeArgs = { task: { id: task.id, goal: task.goal }, requirement_ref: 'README.md: behavior',
    scope: [{ path: 'README.md', module_uid: '00000001' }], acceptance: ['README documents current behavior.'],
    expected_architecture_version: query.version,
    reuse: { decision: 'not_applicable', reason: 'Documentation-only work.', query_handle: query.raw.handle } };
  const send = (event, id = session, options = {}) => handleContextHook({ ...event, cwd: root, session_id: id },
    { workspace: root, rules: 'context.json', validationRules: 'rules.json', generated: [], ...options });
  const openChange = (overrides = {}) => changes.open({ ...changeArgs, ...overrides });
  const bindContext = async (binding, id = session, overrides = {}) => {
    const packet = await engine.prepare({ task, role: 'plan', targets: ['README.md'], change: binding, ...overrides });
    await sessions.bind(id, packet.raw);
    return packet;
  };
  const snapshot = async (id = session) => ({
    archives: (await readdir(store.observationsRoot)).sort(),
    changePointer: await readFile(changes.pointer),
    sessionPointer: await readFile(sessions.file(id)),
    readme: await readFile(join(root, 'README.md')),
    notes: await readFile(join(root, 'NOTES.md')),
  });
  return { root, engine, changes, store, sessions, send, openChange, bindContext, snapshot };
}

async function assertUnchanged(f, before, id = session) {
  assert.deepEqual(await f.snapshot(id), before);
}

function permissionCode(result, code) {
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(result));
  assert.match(result.hookSpecificOutput.permissionDecisionReason, new RegExp(`^${code}:`));
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /sol_apply_(?:patch|changes)|sol_change_status|sol_context_prepare/u);
}

function countsWhileWatching(action) {
  const calls = { onChange: 0, revalidate: 0 };
  const onChange = ValidationEngine.prototype.onChange;
  const revalidate = ValidationEngine.prototype.revalidate;
  ValidationEngine.prototype.onChange = function (...args) { calls.onChange += 1; return onChange.apply(this, args); };
  ValidationEngine.prototype.revalidate = function (...args) { calls.revalidate += 1; return revalidate.apply(this, args); };
  return Promise.resolve().then(action).then((value) => ({ value, calls })).finally(() => {
    ValidationEngine.prototype.onChange = onChange;
    ValidationEngine.prototype.revalidate = revalidate;
  });
}

async function completeDocumentationChange(f, binding) {
  const prepared = await f.changes.review({ change: binding, phase: 'prepare' });
  const context = await f.engine.stored(prepared.raw.handle, 'sol_change_review_context', 'change_review_context');
  const source = (path) => context.sources.find((item) => item.path === path && item.raw)?.raw.handle;
  const declaration = source('architecture.json');
  const review = { method: 'self_review',
    modules: context.maintenance.affected_uids.map((uid) => {
      const module = context.architecture.tree.find((item) => item.uid === uid);
      const handle = module?.source.map((item) => source(item.path)).find(Boolean) ?? declaration;
      return { uid, disposition: module ? 'preserved' : 'removed', contract_refs: [handle], evidence_handles: [handle],
        rationale: 'Reviewed the captured declaration for this documentation-only change.', unresolved: [] };
    }),
    acceptance: context.acceptance.map((_, index) => ({ index, evidence_handles: [source('README.md') ?? declaration],
      check_ids: context.plan.rules.flatMap((rule) => rule.check_ids),
      rationale: 'The current project documentation states the registered behavior.', unresolved: [] })),
    uncovered: context.maintenance.uncovered.map((item, index) => ({ index, evidence_handles: [source(item.path) ?? declaration,
      ...context.before_sources.filter((before) => before.path === item.path && before.raw).map((before) => before.raw.handle)],
    rationale: 'Reviewed the explicitly uncovered documentation relationship.', unresolved: [] })),
    checks_not_applicable: context.checks_not_applicable_paths.map((path) => ({ path, evidence_handles: [source(path)],
      rationale: 'Documentation-only path; it introduces no executable behavior.' })), unresolved: [] };
  const submitted = await f.changes.review({ change: prepared.change, phase: 'submit', review_context_handle: prepared.raw.handle, review });
  return f.changes.complete({ change: submitted.change, review_handle: submitted.review.handle });
}

const changesInput = (change, path = 'README.md') => ({ change,
  changes: [{ action: 'write', path, content: 'Proposed content; Hook must not write it.\n' }] });
const updatePatch = (from = 'README.md', to) => [
  '*** Begin Patch', `*** Update File: ${from}`, ...(to ? [`*** Move to: ${to}`] : []),
  '@@', '-Documented behavior.', '+Proposed content; Hook must not apply this patch.', '*** End Patch',
].join('\n');
const preTool = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input });

test('PreToolUse gates only architecture writes and keeps native edits routed through MCP', async (t) => {
  const f = await fixture(t);
  const opened = await f.openChange();
  await f.bindContext(opened.change);
  const before = await f.snapshot();

  for (const tool_name of ['Read', 'Bash', 'Shell', 'mcp__codex__sol_read_file', 'mcp__codex__sol_recall']) {
    assert.deepEqual(await f.send({ hook_event_name: 'PreToolUse', tool_name, tool_input: {} }), {});
  }
  for (const tool_name of ['apply_patch', 'Edit', 'Write']) {
    const denied = await f.send({ hook_event_name: 'PreToolUse', tool_name, tool_input: {} });
    permissionCode(denied, 'MANAGED_WRITE_REQUIRED');
  }
  assert.deepEqual(await handleContextHook({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: f.root,
    session_id: session }, { workspace: f.root }), {});

  const pureConfig = { ...structuredClone(example) };
  delete pureConfig.architecture;
  await writeFile(join(f.root, 'pure-context.json'), JSON.stringify(pureConfig));
  assert.deepEqual(await f.send({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: {} }, session,
    { rules: 'pure-context.json', validationRules: 'missing-rules.json', generated: 'invalid-json' }), {});
  await assertUnchanged(f, before);
});

test('managed preflight requires the session binding, exact current version, and every in-scope target', async (t) => {
  const f = await fixture(t);
  const opened = await f.openChange();
  const context = await f.bindContext(opened.change);
  const initial = await f.snapshot();
  const validChanges = await f.send(preTool('mcp__codex__sol_apply_changes', changesInput(opened.change)));
  const validPatch = await f.send(preTool('mcp__codex__sol_apply_patch', { change: opened.change, patch: updatePatch() }));
  assert.deepEqual(validChanges, {});
  assert.deepEqual(validPatch, {});
  assert.notEqual(context.change_state.version, undefined);

  const otherPath = await f.send(preTool('mcp__codex__sol_apply_changes', changesInput(opened.change, 'NOTES.md')));
  permissionCode(otherPath, 'CHANGE_OUTSIDE_SCOPE');
  const moved = await f.send(preTool('mcp__codex__sol_apply_patch', { change: opened.change, patch: updatePatch('README.md', 'NOTES.md') }));
  permissionCode(moved, 'CHANGE_OUTSIDE_SCOPE');
  const unbound = await f.send(preTool('mcp__codex__sol_apply_changes', changesInput(opened.change)), otherSession);
  permissionCode(unbound, 'CHANGE_CONTEXT_REQUIRED');
  const wrongId = await f.send(preTool('mcp__codex__sol_apply_changes', changesInput({ ...opened.change,
    id: '01a0ffa0-fdc0-7c67-a593-1fcde89fa9a3' })));
  permissionCode(wrongId, 'CHANGE_NOT_CURRENT');
  await assertUnchanged(f, initial);

  const adjusted = await f.openChange({ change: opened.change, acceptance: ['README describes the maintained behavior.'] });
  const afterAdjustment = await f.snapshot();
  const oldVersion = await f.send(preTool('mcp__codex__sol_apply_changes', changesInput(opened.change)));
  permissionCode(oldVersion, 'CHANGE_VERSION');
  assert.deepEqual(await f.send(preTool('mcp__codex__sol_apply_changes', changesInput(adjusted.change))), {});
  assert.deepEqual(await f.send(preTool('mcp__codex__sol_apply_patch', { change: adjusted.change, patch: updatePatch() })), {});
  await assertUnchanged(f, afterAdjustment);

  await writeFile(join(f.root, 'README.md'), 'External edit; needs status refresh.\n');
  const afterExternal = await f.snapshot();
  const staleFacts = await f.send(preTool('mcp__codex__sol_apply_changes', changesInput(adjusted.change)));
  permissionCode(staleFacts, 'CHANGE_STATUS_REFRESH');
  await assertUnchanged(f, afterExternal);
});

test('managed preflight rejects a same-ID change whose task goal no longer matches the session', async (t) => {
  const f = await fixture(t);
  const opened = await f.openChange();
  await f.bindContext(opened.change);
  const changedGoal = await f.openChange({ change: opened.change,
    task: { id: task.id, goal: 'A different documentation goal.' } });
  const before = await f.snapshot();
  const denied = await f.send(preTool('mcp__codex__sol_apply_patch', { change: changedGoal.change, patch: updatePatch() }));
  permissionCode(denied, 'TASK_MISMATCH');
  await assertUnchanged(f, before);
});

test('Stop permits one actionable continuation and lets blocked or interrupted work remain unfinished', async (t) => {
  const f = await fixture(t);
  const opened = await f.openChange();
  await f.bindContext(opened.change);
  const before = await f.snapshot();
  const first = await countsWhileWatching(() => f.send({ hook_event_name: 'Stop', stop_hook_active: false }));
  assert.equal(first.value.decision, 'block');
  const closeout = JSON.parse(first.value.reason);
  assert.equal(closeout.kind, 'change_closeout');
  assert.equal(closeout.task_complete, false);
  assert.equal(closeout.change.id, opened.change.id);
  assert.equal(first.calls.onChange, 0);
  assert.equal(first.calls.revalidate, 0);
  await assertUnchanged(f, before);
  assert.deepEqual(await f.send({ hook_event_name: 'Stop', stop_hook_active: true }), {});
  for (const stop_hook_active of [undefined, 'false']) {
    const event = { hook_event_name: 'Stop', ...(stop_hook_active === undefined ? {} : { stop_hook_active }) };
    const result = await f.send(event);
    assert.equal(result.decision, undefined);
    assert.match(result.systemMessage, /STOP_FLAG_UNAVAILABLE/u);
  }
  assert.deepEqual(await f.send({ hook_event_name: 'Stop', stop_hook_active: false }, otherSession), {});
  await assertUnchanged(f, before);

  const producer = await f.engine.prepare({ task, role: 'plan', targets: ['README.md'], change: opened.change });
  const artifact = await f.engine.submit({ context_handle: producer.raw.handle, task_id: task.id, role: 'plan', version: producer.version,
    output: { plan: 'The requirements need user input.', constraints: task.constraints, unresolved: ['Wait for the user to clarify the intended wording.'] } });
  const consumer = await f.engine.prepare({ task, role: 'implement', targets: ['README.md'], change: opened.change,
    upstream_handle: artifact.raw.handle });
  assert.equal(consumer.status, 'blocked');
  await f.sessions.bind(thirdSession, consumer.raw);
  const blockedBefore = await f.snapshot(thirdSession);
  const waiting = await f.send({ hook_event_name: 'Stop', stop_hook_active: false }, thirdSession);
  assert.equal(waiting.decision, undefined);
  assert.match(waiting.systemMessage, /remains unfinished/u);
  await assertUnchanged(f, blockedBefore, thirdSession);

  const current = await f.changes.read();
  await f.changes.publish({ ...current.record, state: 'checking',
    pending: { kind: 'write', operation_id: randomUUID(), paths: ['README.md'] } }, current.raw);
  const interruptedBefore = await f.snapshot();
  const interrupted = await f.send({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(interrupted.decision, undefined);
  assert.match(interrupted.systemMessage, /remains unfinished \(interrupted\)/u);
  assert.match(interrupted.systemMessage, /no operation will be replayed/u);
  await assertUnchanged(f, interruptedBefore);
});

test('Stop allows current completion and reports configuration or cancellation errors without blocking', async (t) => {
  const f = await fixture(t);
  const opened = await f.openChange();
  await f.bindContext(opened.change);
  const completed = await completeDocumentationChange(f, opened.change);
  assert.equal(completed.task_complete, true, JSON.stringify(completed));
  const before = await f.snapshot();
  assert.deepEqual(await f.send({ hook_event_name: 'Stop', stop_hook_active: false }), {});
  await assertUnchanged(f, before);

  const configMismatch = await f.send({ hook_event_name: 'Stop', stop_hook_active: false }, session,
    { generated: ['**/*.tmp'] });
  assert.equal(configMismatch.decision, undefined);
  assert.match(configMismatch.systemMessage, /CHANGE_UNAVAILABLE/u);
  await assertUnchanged(f, before);

  const controller = new AbortController();
  controller.abort(new SolFault('HOST_STATE_ERROR', 'host turn ended'));
  const cancelled = await f.send({ hook_event_name: 'Stop', stop_hook_active: false }, session, { signal: controller.signal });
  assert.equal(cancelled.decision, undefined);
  assert.match(cancelled.systemMessage, /HOST_STATE_ERROR/u);
  await assertUnchanged(f, before);
});

test('PreToolUse configuration mismatch fails closed without running checks or changing state', async (t) => {
  const f = await fixture(t);
  const opened = await f.openChange();
  await f.bindContext(opened.change);
  const marker = join(f.root, '.codex', 'sol', 'pretool-config-runner-marker');
  const rules = { schema_version: 1, rules: [{ schema_version: 1, id: 'hook-config-only', reuse: 'never',
    globs: ['README.md'], watch_paths: ['README.md'], commands: [{ id: 'safe-marker',
      argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], cwd: '.', timeout_ms: 1000 }] }] };
  await writeFile(join(f.root, 'rules.json'), JSON.stringify(rules));
  const before = await f.snapshot();
  const result = await f.send(preTool('mcp__codex__sol_apply_changes', changesInput(opened.change)));
  permissionCode(result, 'CHANGE_UNAVAILABLE');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await assertUnchanged(f, before);
});
