import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSolServer } from '../src/server.mjs';
import { runManagedCommand } from '../src/managed-command.mjs';
import { withWorkspaceLock } from '../src/workspace-lock.mjs';
import { SolFault } from '../src/store.mjs';
import { ContextSessions } from '../src/architecture/session.mjs';
import { handleContextHook } from '../src/context-hook.mjs';

const session = '01a0ffa0-eba8-7f32-9ca8-6c105a7a3c59';
const otherSession = '01a0ffa0-ec8e-7742-977c-ee74dd9350cd';
const thirdSession = '01a0ffa0-ed2a-7e36-a20b-2204d54b4ea8';
const task = { id: 'hook-docs', goal: 'Maintain the project documentation.', constraints: ['Keep the stated project behavior accurate.'] };
const goal = task.goal;
const example = JSON.parse(await readFile(new URL('../context.example.json', import.meta.url)));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-context-change-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), 'Documented project behavior.\n');
  await writeFile(join(root, 'NOTES.md'), 'Additional scope with no executable behavior.\n');
  const contextConfig = { ...structuredClone(example), architecture: { path: 'architecture.json' } };
  await writeFile(join(root, 'context.json'), JSON.stringify(contextConfig));
  const rules = { schema_version: 1, rules: [] };
  await writeFile(join(root, 'rules.json'), JSON.stringify(rules));
  const architecture = { schema_version: 1, modules: [{ id: 'docs', uid: '00000001', parent: null,
    name: { zh: '文档', en: 'Documentation' }, description: { zh: '项目文档', en: 'Project documentation' },
    source: [], apis: [], fingerprint: 'pending', revision: '0'.repeat(40), updated_at: '2026-10-04T00:00:00Z' }],
    policy: { schema_version: 1, updated_at: '2026-10-04T00:00:00Z', rules: [] } };
  await writeFile(join(root, 'architecture.json'), JSON.stringify(architecture));
  const service = await createSolServer(root, rules, { contextRulesPath: join(root, 'context.json'),
    rulesPath: join(root, 'rules.json'), generated: [] });
  const { contextEngine: engine, changesEngine: changes, store, validator } = service;
  const sessions = new ContextSessions(engine);
  const query = await engine.architectureQuery({ paths: ['README.md'] });
  const changeArgs = { task: { id: task.id, goal }, requirement_ref: 'README.md: project behavior',
    scope: [{ path: 'README.md', module_uid: '00000001' }], acceptance: ['README describes the current project behavior.'],
    expected_architecture_version: query.version,
    reuse: { decision: 'not_applicable', reason: 'Documentation-only work.', query_handle: query.raw.handle } };

  const hook = (name, id = session, options = {}) => handleContextHook({ hook_event_name: name, cwd: root,
    session_id: id, source: 'resume', prompt: 'Continue this task?' },
  { workspace: root, rules: 'context.json', validationRules: 'rules.json', generated: [], ...options });
  const prompt = async (id = session, options = {}) => hook('UserPromptSubmit', id, options);
  const start = async (id = session, options = {}) => hook('SessionStart', id, options);
  const changeState = async (overrides = {}) => changes.open({ ...changeArgs, ...overrides });
  const prepareBound = async (binding, id = session, role = 'plan', targets = ['README.md'], extra = {}) => {
    const packet = await engine.prepare({ task, role, targets, change: binding, ...extra });
    await sessions.bind(id, packet.raw);
    return packet;
  };
  const archives = async () => (await readdir(store.observationsRoot)).sort();
  return { root, engine, changes, store, validator, sessions, hook, prompt, start, changeArgs, changeState,
    prepareBound, archives };
}

function hookPayload(result) {
  if (!result.hookSpecificOutput?.additionalContext) return result;
  const text = result.hookSpecificOutput.additionalContext;
  assert.ok(Buffer.byteLength(text) <= 4096, 'Hook text must stay within the 4096-byte Context budget.');
  return JSON.parse(text);
}

function reviewOutput(context) {
  const source = (path) => context.sources.find((item) => item.path === path && item.raw)?.raw.handle;
  const declaration = source('architecture.json');
  return { method: 'self_review',
    modules: context.maintenance.affected_uids.map((uid) => {
      const module = context.architecture.tree.find((item) => item.uid === uid);
      const current = module?.source.map((item) => source(item.path)).find(Boolean) ?? declaration;
      return { uid, disposition: module ? 'preserved' : 'removed', contract_refs: [current], evidence_handles: [current],
        rationale: 'Reviewed the captured declaration for this documentation-only change.', unresolved: [] };
    }),
    acceptance: context.acceptance.map((_, index) => ({ index, evidence_handles: [source('README.md') ?? declaration],
      check_ids: context.plan.rules.flatMap((rule) => rule.check_ids),
      rationale: 'The current project documentation states the registered behavior.', unresolved: [] })),
    uncovered: context.maintenance.uncovered.map((item, index) => ({ index,
      evidence_handles: [source(item.path) ?? declaration,
        ...context.before_sources.filter((before) => before.path === item.path && before.raw).map((before) => before.raw.handle)],
      rationale: 'Reviewed the explicitly uncovered documentation relationship.', unresolved: [] })),
    checks_not_applicable: context.checks_not_applicable_paths.map((path) => ({ path, evidence_handles: [source(path)],
      rationale: 'Documentation-only path; it introduces no executable behavior.' })),
    unresolved: [] };
}

async function completeDocumentationChange(f, change) {
  const prepared = await f.changes.review({ change, phase: 'prepare' });
  const context = await f.engine.stored(prepared.raw.handle, 'sol_change_review_context', 'change_review_context');
  const accepted = await f.changes.review({ change: prepared.change, phase: 'submit',
    review_context_handle: prepared.raw.handle, review: reviewOutput(context) });
  return f.changes.complete({ change: accepted.change, review_handle: accepted.review.handle });
}

test('a metadata-only scope and acceptance adjustment is reminded from current change facts without writes', async (t) => {
  const f = await fixture(t);
  const original = await f.changeState();
  const packet = await f.prepareBound(original.change);
  const adjusted = await f.changeState({ change: original.change,
    scope: [...f.changeArgs.scope, { path: 'NOTES.md', module_uid: '00000001' }],
    acceptance: ['README and NOTES match the current project behavior.'] });
  assert.equal(adjusted.change.id, original.change.id);
  assert.notEqual(adjusted.change.version, original.change.version);

  const pointerBefore = await readFile(f.changes.pointer);
  const sessionBefore = await readFile(f.sessions.file(session));
  const archivesBefore = await f.archives();
  const sourceBefore = await Promise.all(['README.md', 'NOTES.md'].map((path) => readFile(join(f.root, path))));
  const reminder = hookPayload(await f.prompt());

  assert.equal(reminder.kind, 'context_reminder');
  assert.equal(reminder.prior_task_id, task.id);
  assert.equal(reminder.change_state.availability, 'bound');
  assert.deepEqual(reminder.change_state.change, adjusted.change);
  assert.equal(reminder.change_state.task_id, task.id);
  assert.equal(reminder.change_state.scope_count, 2);
  assert.equal(reminder.change_state.state, 'dirty');
  assert.notEqual(reminder.change_state.version, packet.change_state.version);
  assert.deepEqual(await readFile(f.changes.pointer), pointerBefore);
  assert.deepEqual(await readFile(f.sessions.file(session)), sessionBefore);
  assert.deepEqual(await f.archives(), archivesBefore);
  assert.deepEqual(await Promise.all(['README.md', 'NOTES.md'].map((path) => readFile(join(f.root, path)))), sourceBefore);
});

test('unbound, current and other-session prompts stay silent and never inherit the workspace change', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.prompt(), {});
  const state = await f.changeState();
  await f.prepareBound(state.change);
  assert.deepEqual(await f.prompt(), {});
  assert.deepEqual(await f.prompt(otherSession), {});
  const entry = hookPayload(await f.start(otherSession));
  assert.equal(entry.kind, 'context_entry');
  assert.equal(entry.bound_task, false);
  assert.equal(entry.change_state, undefined);
  assert.equal(await f.sessions.read(otherSession), null);
});

test('a durable checking/pending write is surfaced as interrupted without refresh or replay', async (t) => {
  const f = await fixture(t);
  const state = await f.changeState();
  await f.prepareBound(state.change);
  const current = await f.changes.read();
  await f.changes.publish({ ...current.record, state: 'checking',
    pending: { kind: 'write', operation_id: randomUUID(), paths: ['README.md'] } }, current.raw);
  const pointerBefore = await readFile(f.changes.pointer);
  const sessionBefore = await readFile(f.sessions.file(session));
  const archivesBefore = await f.archives();
  const sourceBefore = await readFile(join(f.root, 'README.md'));

  const reminder = hookPayload(await f.prompt());

  assert.equal(reminder.change_state.state, 'interrupted');
  assert.equal(reminder.change_state.needs_status_refresh, true);
  assert.equal(reminder.change_state.task_complete, false);
  assert.ok(reminder.change_state.blocking.codes.includes('CHANGE_INTERRUPTED'));
  assert.deepEqual(await readFile(f.changes.pointer), pointerBefore);
  assert.deepEqual(await readFile(f.sessions.file(session)), sessionBefore);
  assert.deepEqual(await f.archives(), archivesBefore);
  assert.deepEqual(await readFile(join(f.root, 'README.md')), sourceBefore);
});

test('completed evidence remains visible when an old implement upstream is stale; bound Hooks require validation rules', async (t) => {
  const f = await fixture(t);
  let state = await f.changeState();
  const plan = await f.engine.prepare({ task, role: 'plan', targets: ['README.md'], change: state.change });
  const artifact = await f.engine.submit({ context_handle: plan.raw.handle, task_id: task.id, role: 'plan', version: plan.version,
    output: { plan: 'Update only the documentation.', constraints: task.constraints, unresolved: [] } });
  const implement = await f.engine.prepare({ task, role: 'implement', targets: ['README.md'], change: state.change,
    upstream_handle: artifact.raw.handle });
  await f.sessions.bind(session, implement.raw);

  const updated = '# Project behavior\n\nThe documentation now describes the maintained behavior.\n';
  const writeResult = await f.changes.run(state.change, ['README.md'], (lease) => runManagedCommand(f.store, f.validator,
    { id: 'update-docs', argv: [process.execPath, '-e', `require('node:fs').writeFileSync('README.md',${JSON.stringify(updated)})`],
      cwd: '.', timeout_ms: 5000 }, { paths: ['README.md'], lease }));
  state = writeResult.change.change;
  const completed = await completeDocumentationChange(f, state);
  assert.equal(completed.task_complete, true, JSON.stringify(completed));

  const pointerBefore = await readFile(f.sessions.file(session));
  const stale = hookPayload(await f.start());
  assert.equal(stale.kind, 'context_restore');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.code, 'CONTEXT_STALE');
  assert.equal(stale.change_state.task_complete, true);
  assert.equal(stale.change_state.completion.validity, 'current');
  assert.equal(stale.change_state.change.id, completed.change.id);
  assert.equal(stale.context.handle, implement.raw.handle);
  assert.match(stale.next, /do not resume implementation/u);
  assert.ok(Buffer.byteLength(JSON.stringify(stale)) <= 4096);
  assert.deepEqual(await readFile(f.sessions.file(session)), pointerBefore);

  const missingRules = hookPayload(await handleContextHook({ hook_event_name: 'SessionStart', source: 'resume', cwd: f.root,
    session_id: session }, { workspace: f.root, rules: 'context.json' }));
  assert.equal(missingRules.kind, 'context_unavailable');
  assert.equal(missingRules.code, 'CHANGE_UNAVAILABLE');
  assert.equal(missingRules.change_state, undefined);
  assert.equal(missingRules.task_complete, undefined);

  const unboundContext = await f.engine.prepare({ task, role: 'plan', targets: ['README.md'] });
  await f.sessions.bind(otherSession, unboundContext.raw);
  const legacyRestore = hookPayload(await f.start(otherSession, { validationRules: undefined }));
  assert.equal(legacyRestore.kind, 'context_restore');
  assert.equal(legacyRestore.status, 'ready');
  assert.equal(legacyRestore.change_state, undefined);
});

test('same-ID goal changes and replacement change IDs cannot rebind an old session', async (t) => {
  const f = await fixture(t);
  let current = await f.changeState();
  const packet = await f.prepareBound(current.change);
  current = await f.changeState({ change: current.change,
    task: { id: task.id, goal: 'Replace the documentation task with a different goal.' } });
  const pointerBefore = await readFile(f.sessions.file(session));
  const goalMismatch = hookPayload(await f.start());
  assert.equal(goalMismatch.kind, 'context_unavailable');
  assert.equal(goalMismatch.code, 'TASK_MISMATCH');
  assert.deepEqual(await readFile(f.sessions.file(session)), pointerBefore);
  assert.equal((await f.sessions.read(session)).handle, packet.raw.handle);

  await f.changes.transition(current.change, 'abandoned', { reason: 'Testing explicit replacement isolation.' });
  const query = await f.engine.architectureQuery({ paths: ['README.md'] });
  const replacement = await f.changeState({ task: { id: 'replacement-task', goal: 'A separate documentation task.' },
    expected_architecture_version: query.version, acceptance: ['The separate documentation task is satisfied.'] });
  const oldIdResult = hookPayload(await f.start());
  assert.equal(oldIdResult.kind, 'context_unavailable');
  assert.equal(oldIdResult.code, 'CHANGE_NOT_CURRENT');
  assert.equal(JSON.stringify(oldIdResult).includes(replacement.change.id), false);
  assert.deepEqual(await readFile(f.sessions.file(session)), pointerBefore);
});

test('standalone Hook accepts explicit and environment validation/generated configuration', async (t) => {
  const f = await fixture(t);
  const state = await f.changeState();
  await f.prepareBound(state.change);
  const entry = fileURLToPath(new URL('../src/context-hook.mjs', import.meta.url));
  const input = JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume', cwd: f.root, session_id: session });
  const invoke = (args, env = {}) => spawnSync(process.execPath, [entry, ...args], { input, encoding: 'utf8', timeout: 15000,
    windowsHide: true, env: { ...process.env, CODEX_SOL_WORKSPACE: '', CODEX_SOL_CONTEXT_RULES: '', CODEX_SOL_RULES: '',
      CODEX_SOL_GENERATED_PATHS: '[]', ...env } });

  const flags = invoke(['--workspace', f.root, '--rules', 'context.json', '--validation-rules', 'rules.json', '--generated', '[]']);
  assert.equal(flags.status, 0, flags.stderr);
  const explicit = hookPayload(JSON.parse(flags.stdout));
  assert.equal(explicit.kind, 'context_restore');
  assert.equal(explicit.change_state.availability, 'bound');

  const environment = invoke([], { CODEX_SOL_WORKSPACE: f.root, CODEX_SOL_CONTEXT_RULES: 'context.json',
    CODEX_SOL_RULES: 'rules.json', CODEX_SOL_GENERATED_PATHS: '[]' });
  assert.equal(environment.status, 0, environment.stderr);
  const fromEnvironment = hookPayload(JSON.parse(environment.stdout));
  assert.equal(fromEnvironment.kind, 'context_restore');
  assert.equal(fromEnvironment.change_state.change.id, state.change.id);
});

test('bound Hook fails closed on generated or rules drift while unbound recovery ignores validation config', async (t) => {
  const f = await fixture(t);
  const state = await f.changeState();
  await f.prepareBound(state.change);
  const marker = join(f.root, '.codex', 'sol', 'hook-config-runner-marker');
  const assertUnavailableWithoutWrites = async (result) => {
    const unavailable = hookPayload(result);
    assert.equal(unavailable.kind, 'context_unavailable');
    assert.equal(unavailable.code, 'CHANGE_UNAVAILABLE');
    assert.equal(unavailable.task_complete, undefined);
    assert.equal(unavailable.change_state, undefined);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  };

  let changePointer = await readFile(f.changes.pointer);
  let sessionPointer = await readFile(f.sessions.file(session));
  let archives = await f.archives();
  await assertUnavailableWithoutWrites(await f.start(session, { generated: ['**/*.tmp'] }));
  assert.deepEqual(await readFile(f.changes.pointer), changePointer);
  assert.deepEqual(await readFile(f.sessions.file(session)), sessionPointer);
  assert.deepEqual(await f.archives(), archives);

  const changedRules = { schema_version: 1, rules: [{ schema_version: 1, id: 'hook-config-only', reuse: 'never',
    globs: ['README.md'], watch_paths: ['README.md'], commands: [{ id: 'safe-marker',
      argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], cwd: '.', timeout_ms: 1000 }] }] };
  await writeFile(join(f.root, 'rules.json'), JSON.stringify(changedRules));
  changePointer = await readFile(f.changes.pointer);
  sessionPointer = await readFile(f.sessions.file(session));
  archives = await f.archives();
  await assertUnavailableWithoutWrites(await f.start(session, { generated: [] }));
  assert.deepEqual(await readFile(f.changes.pointer), changePointer);
  assert.deepEqual(await readFile(f.sessions.file(session)), sessionPointer);
  assert.deepEqual(await f.archives(), archives);

  const unbound = await f.engine.prepare({ task, role: 'plan', targets: ['README.md'] });
  await f.sessions.bind(otherSession, unbound.raw);
  const legacy = hookPayload(await handleContextHook({ hook_event_name: 'SessionStart', source: 'resume', cwd: f.root,
    session_id: otherSession }, { workspace: f.root, rules: 'context.json', validationRules: 'missing-rules.json', generated: 'invalid-json' }));
  assert.equal(legacy.kind, 'context_restore');
  assert.equal(legacy.status, 'ready');
  assert.equal(legacy.change_state, undefined);
  assert.equal(legacy.task_complete, undefined);

  const entry = fileURLToPath(new URL('../src/context-hook.mjs', import.meta.url));
  await f.sessions.bind(thirdSession, unbound.raw);
  const child = spawnSync(process.execPath, [entry, '--workspace', f.root, '--rules', 'context.json',
    '--validation-rules', 'missing-rules.json', '--generated', 'invalid-json'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume', cwd: f.root, session_id: thirdSession }),
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  const cliLegacy = hookPayload(JSON.parse(child.stdout));
  assert.equal(cliLegacy.kind, 'context_restore');
  assert.equal(cliLegacy.status, 'ready');
  assert.equal(cliLegacy.change_state, undefined);
});

test('lock-wait cancellation leaves both pointers and archives intact, and host errors keep their code', async (t) => {
  const f = await fixture(t);
  const state = await f.changeState();
  await f.prepareBound(state.change);
  const changePointer = await readFile(f.changes.pointer);
  const sessionPointer = await readFile(f.sessions.file(session));
  const archivesBefore = await f.archives();
  let announceLock;
  let releaseLock;
  const locked = new Promise((resolve) => { announceLock = resolve; });
  const gate = new Promise((resolve) => { releaseLock = resolve; });
  const owner = withWorkspaceLock(f.store, async () => { announceLock(); await gate; });
  await locked;
  try {
    const controller = new AbortController();
    const pending = f.prompt(session, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const cancelled = hookPayload(await pending);
    assert.equal(cancelled.kind, 'context_unavailable');
    assert.equal(cancelled.code, 'INTERRUPTED');
  } finally {
    releaseLock();
    await owner;
  }
  assert.deepEqual(await readFile(f.changes.pointer), changePointer);
  assert.deepEqual(await readFile(f.sessions.file(session)), sessionPointer);
  assert.deepEqual(await f.archives(), archivesBefore);

  const hostError = new SolFault('HOST_STATE_ERROR', 'host turn ended');
  const controller = new AbortController();
  controller.abort(hostError);
  const failed = hookPayload(await f.prompt(session, { signal: controller.signal }));
  assert.equal(failed.kind, 'context_unavailable');
  assert.equal(failed.code, 'HOST_STATE_ERROR');
  assert.deepEqual(await readFile(f.changes.pointer), changePointer);
  assert.deepEqual(await readFile(f.sessions.file(session)), sessionPointer);
  assert.deepEqual(await f.archives(), archivesBefore);
});
