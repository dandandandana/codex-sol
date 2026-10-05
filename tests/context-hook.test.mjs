import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createObservationStore } from '../src/store.mjs';
import { ContextEngine } from '../src/architecture/context.mjs';
import { ContextSessions } from '../src/architecture/session.mjs';
import { handleContextHook } from '../src/context-hook.mjs';
import { startMcpServer } from './helpers/mcp-client.mjs';

const id = '01a0ffa0-eba8-7f32-9ca8-6c105a7a3c59';
const other = '01a0ffa0-ec8e-7742-977c-ee74dd9350cd';
const task = { id: 'retry', goal: 'Reuse cancellation.', constraints: ['Never retry cancellation.'] };
const example = await readFile(new URL('../context.example.json', import.meta.url));
async function fixture(t, beforeCleanup = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'sol-hook-'));
  t.after(async () => { await beforeCleanup(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'README.md'), 'RAW_SOURCE_NOT_FOR_HOOK');
  await writeFile(join(root, 'upload.mjs'), 'export const upload = 1;');
  await writeFile(join(root, 'context.json'), example);
  await writeFile(join(root, 'rules.json'), JSON.stringify({ schema_version: 1, rules: [] }));
  const store = await createObservationStore(root);
  const engine = await new ContextEngine(store, 'context.json').initialize();
  const sessions = new ContextSessions(engine);
  const hook = async (source = 'resume', session = id, options = {}) => {
    const result = await handleContextHook({ hook_event_name: 'SessionStart', cwd: root, session_id: session, source }, { workspace: root, rules: 'context.json', ...options });
    return result.hookSpecificOutput ? JSON.parse(result.hookSpecificOutput.additionalContext) : result;
  };
  const prompt = async (session = id, text = 'Continue.', options = {}) => handleContextHook({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: session, turn_id: other, prompt: text }, { workspace: root, rules: 'context.json', ...options });
  return { root, store, engine, sessions, hook, prompt };
}
const prepare = (engine, extra = {}) => engine.prepare({ task, role: 'plan', targets: ['upload.mjs'], ...extra });
const submit = (engine, packet, unresolved = []) => engine.submit({ context_handle: packet.raw.handle, task_id: task.id, role: 'plan', version: packet.version, output: { plan: 'Reuse AbortSignal.', constraints: task.constraints, unresolved, notes: 'PRIVATE_EXPLORATION' } });

test('host metadata is optional, but present identities must be valid', () => {
  assert.equal(ContextSessions.fromMetadata(undefined), null);
  assert.equal(ContextSessions.fromMetadata({ 'x-codex-turn-metadata': { thread_id: id.toUpperCase(), turn_id: other } }), id);
  assert.throws(() => ContextSessions.fromMetadata({ 'x-codex-turn-metadata': { thread_id: id } }), { code: 'SESSION_BINDING_INVALID' });
});

test('opt-in entry hints do not invent another session task', async (t) => {
  const { engine, sessions, hook } = await fixture(t);
  assert.deepEqual(await hook('startup', id, { rules: '' }), {});
  assert.deepEqual(await hook('unknown'), {});
  const packet = await prepare(engine);
  await sessions.bind(id, packet.raw);
  const entry = await hook('startup', other);
  assert.equal(entry.kind, 'context_entry');
  assert.equal(entry.bound_task, false);
  assert.deepEqual(entry.roles, ['plan', 'implement']);
  assert.equal((await hook('resume', '../escape')).code, 'SESSION_BINDING_INVALID');
  assert.equal((await hook('startup', id, { workspace: tmpdir() })).kind, 'context_unavailable');
});

test('resume and compact recover current responsibility references without source prose', async (t) => {
  const { root, engine, sessions, hook } = await fixture(t);
  const packet = await prepare(engine);
  await sessions.bind(id, packet.raw);
  const resume = await hook();
  assert.equal(resume.kind, 'context_restore');
  assert.deepEqual(resume.task, task);
  assert.equal(resume.version, packet.version);
  assert.equal(resume.status, 'ready');
  assert.equal(JSON.stringify(resume).includes('RAW_SOURCE_NOT_FOR_HOOK'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(resume)) <= 4096);
  await writeFile(join(root, 'upload.mjs'), 'export const upload = 2;');
  const compact = await hook('compact');
  assert.equal(compact.kind, 'context_restore');
  assert.notEqual(compact.version, packet.version);
  assert.equal((await sessions.read(id)).handle, compact.context.handle);
  await rm(join(root, 'upload.mjs'));
  assert.equal((await hook()).status, 'blocked');
});

test('consumer recovery preserves blockers, rejects stale upstream and excludes private notes', async (t) => {
  const { root, engine, sessions, hook } = await fixture(t);
  const packet = await prepare(engine);
  const artifact = await submit(engine, packet, ['Retry policy undecided.']);
  const consumer = await prepare(engine, { role: 'implement', upstream_handle: artifact.raw.handle });
  await sessions.bind(id, consumer.raw);
  const restored = await hook('compact');
  assert.equal(restored.role, 'implement');
  assert.equal(restored.status, 'blocked');
  assert.equal(JSON.stringify(restored).includes('PRIVATE_EXPLORATION'), false);
  assert.equal(JSON.stringify(restored).includes('Retry policy undecided.'), true);
  await writeFile(join(root, 'README.md'), 'Changed upstream requirements.');
  assert.equal((await hook()).code, 'CONTEXT_STALE');
});

test('tampered or missing bound archives are unavailable, never treated as unbound', async (t) => {
  const { store, engine, sessions, hook } = await fixture(t);
  const packet = await prepare(engine);
  await assert.rejects(sessions.bind(id, { ...packet.raw, sha256: '0'.repeat(64) }), { code: 'SESSION_BINDING_INVALID' });
  await sessions.bind(id, packet.raw);
  await writeFile(sessions.file(id), '{broken');
  assert.equal((await hook()).kind, 'context_unavailable');
  await sessions.bind(id, packet.raw);
  await rm(join(store.observationsRoot, packet.raw.handle), { recursive: true });
  assert.equal((await hook()).kind, 'context_unavailable');
});

test('recovery cannot overwrite a newer task binding published during prepare', async (t) => {
  const { engine, sessions } = await fixture(t);
  const first = await prepare(engine);
  const newer = await prepare(engine, { task: { ...task, id: 'new-task' } });
  await sessions.bind(id, first.raw);
  const original = engine.prepare.bind(engine);
  engine.prepare = async (...args) => { const result = await original(...args); await sessions.bind(id, newer.raw); return result; };
  await assert.rejects(sessions.recover(id), { code: 'SESSION_CHANGED' });
  assert.equal((await sessions.read(id)).handle, newer.raw.handle);
});

test('real stdio prepare binds only the supplied host session', { timeout: 15000 }, async (t) => {
  let client;
  const { root, sessions } = await fixture(t, async () => { await client?.close(); });
  client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), env: { CODEX_SOL_CONTEXT_RULES: join(root, 'context.json'), CODEX_SOL_HOST_EXECUTABLE: '' } });
  await client.initialize();
  const response = await client.request('tools/call', { name: 'sol_context_prepare', arguments: { task, role: 'plan', targets: ['upload.mjs'] }, _meta: { 'x-codex-turn-metadata': { thread_id: id, turn_id: other } } });
  assert.equal(response.result.isError, false, response.result.content[0].text);
  const packet = JSON.parse(response.result.content[0].text);
  assert.equal((await sessions.read(id)).handle, packet.raw.handle);
  assert.equal(await sessions.read(other), null);
});

test('standalone Hook validates arguments and JSON, with environment opt-out', () => {
  const entry = new URL('../src/context-hook.mjs', import.meta.url);
  const invoke = (args, input, env = {}) => spawnSync(process.execPath, [fileURLToPath(entry), ...args], { input, encoding: 'utf8', env: { ...process.env, CODEX_SOL_CONTEXT_RULES: '', ...env }, windowsHide: true });
  assert.equal(invoke(['--workspace'], '{}').status, 1);
  assert.equal(invoke([], 'not JSON').status, 1);
  assert.equal(invoke([], JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' })).stdout.trim(), '{}');
});

test('prompt checks are silent for unbound or unchanged ready inputs, without new archives', async (t) => {
  const { store, engine, sessions, prompt } = await fixture(t);
  assert.deepEqual(await prompt(), {});
  assert.deepEqual(await prompt(id, 'Implement something', { rules: '' }), {});
  const packet = await prepare(engine);
  await sessions.bind(id, packet.raw);
  const before = await readdir(store.observationsRoot);
  const binding = await readFile(sessions.file(id));
  assert.deepEqual(await prompt(id, 'What does this project do?'), {});
  assert.deepEqual(await prompt(other, 'Continue.'), {});
  assert.deepEqual(await readdir(store.observationsRoot), before);
  assert.deepEqual(await readFile(sessions.file(id)), binding);
});

test('prompt exposes stale references as prior task data, never rebinds or logs the new prompt', async (t) => {
  const { root, store, engine, sessions, prompt } = await fixture(t);
  const packet = await prepare(engine);
  await sessions.bind(id, packet.raw);
  await writeFile(join(root, 'upload.mjs'), 'export const upload = 3;');
  const before = await readdir(store.observationsRoot);
  const binding = await readFile(sessions.file(id));
  const result = await prompt(id, 'PROMPT_SECRET_DO_NOT_PERSIST: change the task completely.');
  assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const reminder = JSON.parse(result.hookSpecificOutput.additionalContext);
  assert.equal(reminder.kind, 'context_reminder');
  assert.equal(reminder.freshness, 'stale');
  assert.equal(reminder.prior_task_id, task.id);
  assert.equal(reminder.prepared_version, packet.version);
  assert.equal(reminder.reason, 'CONTEXT_STALE');
  assert.match(reminder.next, /not automatically to the new prompt/);
  assert.equal(JSON.stringify(result).includes('PROMPT_SECRET_DO_NOT_PERSIST'), false);
  assert.equal(JSON.stringify(result).includes('RAW_SOURCE_NOT_FOR_HOOK'), false);
  assert.equal(result.decision, undefined);
  assert.ok(Buffer.byteLength(result.hookSpecificOutput.additionalContext) <= 4096);
  assert.deepEqual(await readdir(store.observationsRoot), before);
  assert.deepEqual(await readFile(sessions.file(id)), binding);
  const fresh = await prepare(engine, { task: { ...task, id: 'new-task' } });
  await sessions.bind(id, fresh.raw);
  assert.deepEqual(await prompt(), {});
});

test('prompt detects upstream and config changes, optional-source appearance and target deletion', async (t) => {
  const { root, engine, sessions, prompt } = await fixture(t);
  const packet = await prepare(engine);
  const artifact = await submit(engine, packet);
  const consumer = await prepare(engine, { role: 'implement', upstream_handle: artifact.raw.handle });
  await sessions.bind(id, consumer.raw);
  await writeFile(join(root, 'README.md'), 'Changed producer source.');
  assert.equal(JSON.parse((await prompt()).hookSpecificOutput.additionalContext).reason, 'CONTEXT_STALE');
  const config = JSON.parse(example);
  config.roles[0].sources.push({ path: 'optional.md', required: false });
  await writeFile(join(root, 'context.json'), JSON.stringify(config));
  const current = await prepare(engine);
  await sessions.bind(id, current.raw);
  assert.deepEqual(await prompt(), {});
  await writeFile(join(root, 'optional.md'), 'New optional input.');
  assert.equal(JSON.parse((await prompt()).hookSpecificOutput.additionalContext).reason, 'CONTEXT_STALE');
  await sessions.bind(id, (await prepare(engine)).raw);
  await rm(join(root, 'upload.mjs'));
  assert.equal(JSON.parse((await prompt()).hookSpecificOutput.additionalContext).reason, 'CONTEXT_STALE');
  await sessions.bind(id, (await prepare(engine)).raw);
  config.roles[0].goal += ' Updated';
  await writeFile(join(root, 'context.json'), JSON.stringify(config));
  assert.equal(JSON.parse((await prompt()).hookSpecificOutput.additionalContext).reason, 'CONTEXT_STALE');
});

test('prompt preserves blockers by reference and reports corrupt evidence without blocking the user', async (t) => {
  const { store, engine, sessions, prompt } = await fixture(t);
  const packet = await prepare(engine);
  const artifact = await submit(engine, packet, ['MODEL_BLOCKER_NOT_FOR_DEVELOPER_PROMPT']);
  const consumer = await prepare(engine, { role: 'implement', upstream_handle: artifact.raw.handle });
  await sessions.bind(id, consumer.raw);
  const result = await prompt();
  const reminder = JSON.parse(result.hookSpecificOutput.additionalContext);
  assert.equal(reminder.reason, 'CONTEXT_BLOCKED');
  assert.equal(reminder.freshness, 'current');
  assert.equal(reminder.context.handle, consumer.raw.handle);
  assert.equal(JSON.stringify(result).includes('MODEL_BLOCKER_NOT_FOR_DEVELOPER_PROMPT'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_EXPLORATION'), false);
  await rm(join(store.observationsRoot, consumer.sources[0].raw.handle), { recursive: true });
  const broken = await prompt();
  assert.equal(JSON.parse(broken.hookSpecificOutput.additionalContext).kind, 'context_unavailable');
  assert.equal(broken.decision, undefined);
  await writeFile(sessions.file(id), '{broken');
  assert.equal(JSON.parse((await prompt()).hookSpecificOutput.additionalContext).kind, 'context_unavailable');
});
