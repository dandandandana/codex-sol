import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObservationStore } from '../src/store.mjs';
import { ContextEngine } from '../src/architecture/context.mjs';
import { startMcpServer } from './helpers/mcp-client.mjs';
import { withWorkspaceLock } from '../src/workspace-lock.mjs';

const example = JSON.parse(await readFile(new URL('../context.example.json', import.meta.url), 'utf8'));
const task = { id: 'upload-retry', goal: 'Reuse upload cancellation for bounded retries.', constraints: ['Keep cancellation effective.'] };
const output = { plan: 'Reuse the existing cancellation signal.', constraints: ['Do not retry after cancellation.'], unresolved: [], notes: 'PRIVATE_EXPLORATION_NOT_FOR_IMPLEMENTATION' };

async function fixture(t, config = structuredClone(example), beforeCleanup = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-sol-context-'));
  t.after(async () => { await beforeCleanup(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'README.md'), 'Project: existing upload cancellation.\n');
  await writeFile(join(root, 'upload.mjs'), 'export function upload(signal) { return signal.aborted; }\n');
  await writeFile(join(root, 'other.mjs'), 'export const other = 1;\n');
  await writeFile(join(root, 'context.json'), JSON.stringify(config));
  await writeFile(join(root, 'rules.json'), JSON.stringify({ schema_version: 1, rules: [] }));
  const store = await createObservationStore(root);
  const engine = await new ContextEngine(store, 'context.json').initialize();
  return { root, store, engine, config };
}

function submit(packet, body = output, evidence = []) {
  return { context_handle: packet.raw.handle, task_id: packet.task.id, role: packet.role.id, version: packet.version, output: body, evidence_handles: evidence };
}
async function fault(promise, code) { await assert.rejects(promise, (error) => error.code === code); }

test('real stdio Context workflow, bounded recall, field projection and restart recovery', { timeout: 20000 }, async (t) => {
  let client;
  const { root } = await fixture(t, undefined, async () => { await client?.close(); });
  const start = async () => {
    client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), env: { CODEX_SOL_CONTEXT_RULES: join(root, 'context.json'), CODEX_SOL_HOST_EXECUTABLE: '' } });
    const initialized = await client.initialize();
    assert.match(initialized.result.instructions, /sol_context_prepare/);
    assert.match(initialized.result.instructions, /single-line/);
    return client;
  };
  const call = async (name, args) => {
    const response = await client.request('tools/call', { name, arguments: args });
    assert.ok(response.result, JSON.stringify(response));
    assert.equal(response.result.isError, false, response.result.content[0].text);
    const text = response.result.content[0].text;
    if (name.startsWith('sol_context_')) assert.ok(Buffer.byteLength(text) <= 4096);
    return JSON.parse(text);
  };
  await start();
  const tools = (await client.request('tools/list')).result.tools;
  assert.equal(tools.length, 6);
  assert.equal(tools.find((tool) => tool.name === 'sol_context_submit').annotations.destructiveHint, false);
  assert.equal(tools.find((tool) => tool.name === 'sol_recall').annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'sol_recall').annotations.destructiveHint, false);
  assert.equal(tools.find((tool) => tool.name === 'sol_read_file').annotations.destructiveHint, false);
  const packet = await call('sol_context_prepare', { task, role: 'plan', targets: ['upload.mjs'] });
  assert.equal(packet.status, 'ready');
  const rangeFailure = await client.request('tools/call', { name: 'sol_recall', arguments: { handle: packet.raw.handle, selector: { kind: 'lines', start: 1, end: 50 } } });
  assert.equal(rangeFailure.result.isError, true);
  const rangeError = JSON.parse(rangeFailure.result.content[0].text);
  assert.equal(rangeError.code, 'INVALID_RANGE');
  assert.match(rangeError.message, /Available lines: 1\.\.1/);
  const contextPage = await call('sol_recall', { handle: packet.raw.handle, selector: { kind: 'lines', start: 1, end: 1 } });
  assert.equal(JSON.parse(contextPage.chunks[0].text).kind, 'context_record');
  assert.equal(packet.delivery, 'full');
  assert.equal(packet.capabilities.architecture_index, 'unavailable');
  assert.deepEqual(packet.sources.map((source) => source.path), ['README.md', 'upload.mjs']);
  const artifact = await call('sol_context_submit', submit(packet, output, [packet.sources[1].raw.handle]));
  assert.equal(artifact.accepted, true);
  assert.equal(artifact.task_complete, false);
  assert.equal(artifact.evidence_count, 1);
  const invalid = await client.request('tools/call', { name: 'sol_context_submit', arguments: submit(packet, {}) });
  assert.equal(invalid.result.isError, true);
  assert.equal(JSON.parse(invalid.result.content[0].text).error.code, 'OUTPUT_INVALID');
  assert.ok(Buffer.byteLength(invalid.result.content[0].text) <= 4096);
  await client.close();
  await start();
  const consumer = await call('sol_context_prepare', { task, role: 'implement', targets: ['upload.mjs'], upstream_handle: artifact.raw.handle });
  assert.equal(consumer.status, 'ready');
  assert.equal(consumer.upstream.fields.plan, output.plan);
  assert.equal(consumer.upstream.fields.notes, undefined);
  assert.equal(JSON.stringify(consumer).includes(output.notes), false);
  assert.equal(consumer.sources.some((s) => s.path === 'README.md'), false);
  const recalled = await call('sol_recall', { handle: consumer.upstream.raw.handle, selector: { kind: 'bytes', start: 0, end: consumer.upstream.raw.bytes } });
  assert.equal(JSON.stringify(recalled).includes(output.notes), false);
  assert.equal(await readFile(join(root, 'upload.mjs'), 'utf8'), 'export function upload(signal) { return signal.aborted; }\n');
  assert.deepEqual(client.protocolErrors, []);
});

test('default MCP remains four tools with no Context instructions', { timeout: 10000 }, async (t) => {
  let client;
  const { root } = await fixture(t, undefined, async () => { await client?.close(); });
  client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), env: { CODEX_SOL_CONTEXT_RULES: '', CODEX_SOL_HOST_EXECUTABLE: '' } });
  const initialized = await client.initialize();
  assert.equal(initialized.result.instructions, undefined);
  assert.equal((await client.request('tools/list')).result.tools.length, 4);
});

test('source, task, version, schema and reference failures never accept an artifact', async (t) => {
  const { root, store, engine } = await fixture(t);
  const packet = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] });
  await fault(engine.submit({ ...submit(packet), task_id: 'other-task' }), 'TASK_MISMATCH');
  await fault(engine.submit({ ...submit(packet), role: 'implement' }), 'TASK_MISMATCH');
  await fault(engine.submit({ ...submit(packet), version: '0'.repeat(64) }), 'CONTEXT_STALE');
  await fault(engine.submit(submit(packet, { plan: 'Missing required fields.' })), 'OUTPUT_INVALID');
  await fault(engine.submit(submit(packet, { ...output, validation: 'passed' })), 'OUTPUT_INVALID');
  await fault(engine.submit(submit(packet, output, ['missing_handle_12345'])), 'NOT_FOUND');
  const artifact = await engine.submit(submit(packet));
  await fault(engine.prepare({ task: { ...task, goal: 'A changed goal.' }, role: 'implement', targets: ['upload.mjs'], upstream_handle: artifact.raw.handle }), 'TASK_MISMATCH');
  await fault(engine.prepare({ task, role: 'plan', targets: ['upload.mjs'], upstream_handle: artifact.raw.handle }), 'CONSUMER_MISMATCH');
  await fault(engine.submit({ ...submit(packet), context_handle: packet.sources[0].raw.handle }), 'REFERENCE_INVALID');
  await writeFile(join(root, 'upload.mjs'), 'export const changed = true;\n');
  await fault(engine.submit(submit(packet)), 'CONTEXT_STALE');
  await fault(engine.prepare({ task, role: 'implement', targets: ['upload.mjs'], upstream_handle: artifact.raw.handle }), 'CONTEXT_STALE');
  const current = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] });
  assert.notEqual(current.version, packet.version);
  await rm(join(store.observationsRoot, current.sources[0].raw.handle), { recursive: true });
  await fault(engine.submit(submit(current)), 'NOT_FOUND');
});

test('missing prerequisites and producer blockers remain visible and block implementation', async (t) => {
  const { root, engine } = await fixture(t);
  const missing = await engine.prepare({ task, role: 'plan', targets: ['missing.mjs'] });
  assert.equal(missing.status, 'blocked');
  assert.ok(missing.diagnostics.some((d) => d.code === 'SOURCE_MISSING' && d.blocking));
  await fault(engine.submit(submit(missing)), 'CONTEXT_BLOCKED');
  const missingUpstream = await engine.prepare({ task, role: 'implement', targets: ['upload.mjs'] });
  assert.equal(missingUpstream.status, 'blocked');
  assert.ok(missingUpstream.diagnostics.some((d) => d.code === 'UPSTREAM_MISSING'));
  const noTargets = await engine.prepare({ task, role: 'plan' });
  assert.ok(noTargets.diagnostics.some((d) => d.code === 'TARGETS_MISSING'));
  const packet = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] });
  const artifact = await engine.submit(submit(packet, { ...output, unresolved: ['Need cancellation behavior evidence.'] }));
  assert.equal(artifact.accepted, true);
  assert.equal(artifact.blocked, true);
  assert.equal(artifact.task_complete, false);
  const consumer = await engine.prepare({ task, role: 'implement', targets: ['upload.mjs'], upstream_handle: artifact.raw.handle });
  assert.equal(consumer.status, 'blocked');
  assert.deepEqual(consumer.upstream.blockers, ['Need cancellation behavior evidence.']);
  assert.equal(await readFile(join(root, 'upload.mjs'), 'utf8'), 'export function upload(signal) { return signal.aborted; }\n');
});

test('UTF-8 budgets retain constraints and diagnostics, with complete original source recall', async (t) => {
  const { root, store, engine } = await fixture(t);
  const original = '必需材料与约束。'.repeat(4000);
  await writeFile(join(root, 'README.md'), original);
  const packet = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs', 'other.mjs'] });
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 4096);
  assert.deepEqual(packet.task.constraints, task.constraints);
  const full = JSON.parse((await store.readVerified(packet.raw.handle)).buffer.toString());
  const source = full.sources.find((s) => s.path === 'README.md');
  assert.ok(source.omitted_bytes > 0);
  assert.equal((await store.readVerified(source.raw.handle)).buffer.toString(), original);
  const repeated = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs', 'other.mjs'] });
  assert.equal(repeated.version, packet.version);
  assert.equal(repeated.delivery, 'full');
  const another = await engine.prepare({ task: { ...task, id: 'other' }, role: 'plan', targets: ['other.mjs'] });
  assert.equal(another.sources.some((s) => s.path === 'upload.mjs'), false);
  await fault(engine.prepare({ task: { id: 'large', goal: '约'.repeat(768), constraints: Array(8).fill('束'.repeat(256)) }, role: 'plan', targets: ['upload.mjs'] }), 'CONTEXT_BUDGET');
});

test('config changes, optional-source appearance, path escape, encoding and cancellation', async (t) => {
  const config = structuredClone(example);
  config.roles[0].sources.push({ path: 'optional.md', required: false });
  const { root, engine } = await fixture(t, config);
  const packet = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] });
  assert.equal(packet.status, 'ready');
  assert.ok(packet.diagnostics.some((d) => d.source === 'optional.md' && !d.blocking));
  await writeFile(join(root, 'optional.md'), 'New information.');
  await fault(engine.submit(submit(packet)), 'CONTEXT_STALE');
  const current = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] });
  config.roles[0].goal = 'Updated responsibility.';
  await writeFile(join(root, 'context.json'), JSON.stringify(config));
  await fault(engine.submit(submit(current)), 'CONTEXT_STALE');
  await fault(engine.prepare({ task, role: 'plan', targets: ['../outside'] }), 'PATH_ERROR');
  await fault(engine.prepare({ task, role: 'plan', targets: ['.codex/sol/observations/anything'] }), 'PATH_ERROR');
  await writeFile(join(root, 'binary'), Buffer.from([0xff]));
  await fault(engine.prepare({ task, role: 'plan', targets: ['binary'] }), 'UNSUPPORTED_ENCODING');
  await writeFile(join(root, 'large'), Buffer.alloc(1024 * 1024 + 1));
  await fault(engine.prepare({ task, role: 'plan', targets: ['large'] }), 'SOURCE_LIMIT');
  const controller = new AbortController(); controller.abort();
  await fault(engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] }, { signal: controller.signal }), 'INTERRUPTED');
  const after = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] });
  assert.equal(after.status, 'ready');
});

test('invalid mappings and linked sources are rejected; failed archive publication leaves no accepted result', async (t) => {
  const { root, store, engine, config } = await fixture(t);
  const packet = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] });
  config.roles[0].consumers[0].fields.notes = 'notes';
  await writeFile(join(root, 'context.json'), JSON.stringify(config));
  await fault(engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] }), 'CONFIG_ERROR');
  await writeFile(join(root, 'context.json'), JSON.stringify(example));
  await mkdir(join(root, 'linked-target'));
  await symlink(join(root, 'linked-target'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await fault(engine.prepare({ task, role: 'plan', targets: ['linked/file.mjs'] }), 'PATH_ERROR');
  const foreignRoot = await mkdtemp(join(tmpdir(), 'codex-sol-foreign-'));
  t.after(() => rm(foreignRoot, { recursive: true, force: true }));
  const foreign = await createObservationStore(foreignRoot);
  const otherEngine = new ContextEngine(foreign, 'context.json');
  await fault(otherEngine.stored(packet.raw.handle, 'sol_context_prepare', 'context_record'), 'NOT_FOUND');
  await writeFile(join(foreignRoot, 'context.json'), JSON.stringify(example));
  await fault(new ContextEngine(store, join(foreignRoot, 'context.json')).initialize(), 'CONFIG_ERROR');
  const original = store.beginCapture.bind(store);
  store.beginCapture = (meta) => {
    if (meta.tool === 'sol_context_submit') throw new Error('Injected storage failure.');
    return original(meta);
  };
  await assert.rejects(engine.submit(submit(packet)), /Injected storage failure/);
  store.beginCapture = original;
  assert.equal((await engine.submit(submit(packet))).task_complete, false);
});

test('large schemas and handoffs remain retrievable without dropping blockers or task constraints', async (t) => {
  const config = structuredClone(example);
  config.roles[0].output_schema.properties.notes.description = 'Detailed guidance '.repeat(500);
  const { store, engine } = await fixture(t, config);
  const packet = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] });
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 4096);
  assert.equal(packet.output_schema, undefined);
  assert.ok(packet.omitted.includes('output_schema: recall raw'));
  const full = JSON.parse((await store.readVerified(packet.raw.handle)).buffer.toString());
  assert.equal(full.output_schema.properties.notes.description, config.roles[0].output_schema.properties.notes.description);
  const largeOutput = { ...output, plan: '实现约束'.repeat(800) };
  const artifact = await engine.submit(submit(packet, largeOutput));
  const consumer = await engine.prepare({ task, role: 'implement', targets: ['upload.mjs'], upstream_handle: artifact.raw.handle });
  assert.ok(Buffer.byteLength(JSON.stringify(consumer)) <= 4096);
  assert.equal(consumer.upstream.fields, undefined);
  assert.deepEqual(consumer.upstream.blockers, []);
  assert.deepEqual(consumer.task.constraints, task.constraints);
  const projection = JSON.parse((await store.readVerified(consumer.upstream.raw.handle)).buffer.toString());
  assert.equal(projection.fields.plan, largeOutput.plan);
  assert.equal(projection.fields.notes, undefined);
});

test('incomplete evidence is retained as incomplete, and corrupt archives cannot be consumed', async (t) => {
  const { store, engine } = await fixture(t);
  const writer = await store.beginCapture({ schema_version: 1, workspace_id: store.workspaceId, call_id: 'partial-evidence', tool: 'validation', captured_at: new Date().toISOString(), media_type: 'text/plain', encoding: 'utf-8', source_form: 'stream_bytes', channel: 'stderr' });
  await writer.write(Buffer.from('Check interrupted before completion.'));
  const partial = await writer.commit({ complete: false });
  const packet = await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] });
  const artifact = await engine.submit(submit(packet, output, [partial.handle]));
  assert.equal(artifact.task_complete, false);
  const consumer = await engine.prepare({ task, role: 'implement', targets: ['upload.mjs'], upstream_handle: artifact.raw.handle });
  assert.equal(consumer.upstream.evidence[0].complete, false);
  await writeFile(join(store.observationsRoot, partial.handle, 'raw'), 'Tampered partial evidence.');
  await fault(engine.prepare({ task, role: 'implement', targets: ['upload.mjs'], upstream_handle: artifact.raw.handle }), 'CORRUPT');
});

test('cancelled lock wait publishes nothing, releases resources and allows a later preparation', async (t) => {
  const { store, engine } = await fixture(t);
  const { readdir } = await import('node:fs/promises');
  const before = await readdir(store.observationsRoot);
  await withWorkspaceLock(store, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try { await fault(engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] }, { signal: controller.signal }), 'INTERRUPTED'); }
    finally { clearTimeout(timer); }
  });
  assert.deepEqual(await readdir(store.observationsRoot), before);
  assert.equal((await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] })).status, 'ready');
});

test('a source changed during real archive publication invalidates preparation', async (t) => {
  const { root, store, engine } = await fixture(t);
  const original = store.beginCapture.bind(store);
  let changed = false;
  store.beginCapture = async (meta) => {
    const writer = await original(meta);
    if (meta.tool === 'sol_context_source' && !changed) {
      const commit = writer.commit.bind(writer);
      writer.commit = async (options) => {
        const ref = await commit(options);
        changed = true;
        await writeFile(join(root, 'README.md'), 'Concurrent external edit.');
        return ref;
      };
    }
    return writer;
  };
  await fault(engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] }), 'CONTEXT_STALE');
  store.beginCapture = original;
  assert.equal((await engine.prepare({ task, role: 'plan', targets: ['upload.mjs'] })).status, 'ready');
});
