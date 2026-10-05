import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpServer } from './helpers/mcp-client.mjs';

const launcher = fileURLToPath(new URL('../src/plugin-launcher.mjs', import.meta.url));
const session = randomUUID();
const task = { id: 'plugin-docs', goal: 'Update the README to describe the maintained project behavior.' };
const initialReadme = '# Project behavior\n\nThe README describes the project.\n';
const updatedReadme = '# Project behavior\n\nThe README describes the maintained project behavior.\n';
const contextExample = JSON.parse(await readFile(new URL('../context.example.json', import.meta.url)));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-plugin-runtime-'));
  const alternateHome = await mkdtemp(join(tmpdir(), 'sol-plugin-runtime-alt-'));
  const executionPath = process.env.Path ?? process.env.PATH;
  assert.equal(typeof executionPath, 'string');
  assert.ok(executionPath.length > 0, 'fixture requires the current OS PATH to configure a stable plugin execution path');
  const executionPathSha = createHash('sha256').update(executionPath).digest('hex');
  const pathVariable = process.platform === 'win32' ? 'Path' : 'PATH';
  const mcpTransportPath = 'synthetic-mcp-transport-path';
  const hookTransportPath = 'synthetic-hook-transport-path';
  let client;
  t.after(async () => {
    if (client) await client.terminateTree();
    await rm(root, { recursive: true, force: true });
    await rm(alternateHome, { recursive: true, force: true });
  });
  await mkdir(join(root, '.git'));
  await mkdir(join(root, '.codex'));
  await writeFile(join(root, 'README.md'), initialReadme);
  await writeFile(join(root, 'architecture.json'), JSON.stringify({
    schema_version: 1,
    modules: [{ id: 'docs', uid: '00000001', parent: null,
      name: { zh: '文档', en: 'Documentation' },
      description: { zh: '项目文档', en: 'Project documentation' },
      source: [], apis: [], fingerprint: 'pending', revision: '0'.repeat(40), updated_at: '2026-10-04T00:00:00Z' }],
    policy: { schema_version: 1, updated_at: '2026-10-04T00:00:00Z', rules: [] },
  }));
  await writeFile(join(root, 'context.json'), JSON.stringify({ ...structuredClone(contextExample), architecture: { path: 'architecture.json' } }));
  const rules = { schema_version: 1, rules: [{ schema_version: 1, id: 'documentation', reuse: 'watched_inputs',
    globs: ['README.md'], watch_paths: ['README.md'], commands: [{ id: 'environment-check',
      argv: [process.execPath, '-e', `const {createHash}=require('node:crypto'); if (process.env.SOL_RUNTIME_TEST_SECRET) process.exit(7); if (createHash('sha256').update(process.env.PATH ?? '').digest('hex') !== '${executionPathSha}') process.exit(8); process.stdout.write(JSON.stringify({ path: process.env.PATH }));`],
      cwd: '.', timeout_ms: 3000 }] }] };
  await writeFile(join(root, 'rules.json'), JSON.stringify(rules));
  await writeFile(join(root, '.codex', 'sol-project.json'), JSON.stringify({ schema_version: 1,
    validation_rules: 'rules.json', context_rules: 'context.json', generated_paths: [], execution_path: executionPath }));

  client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), serverPath: launcher, serverArgs: ['mcp'],
    env: { [pathVariable]: mcpTransportPath, SOL_RUNTIME_TEST_SECRET: 'synthetic-mcp-secret', PLUGIN_ROOT: 'synthetic-mcp-transport', SOL_PLUGIN_EXECUTION_MODE: '',
      CODEX_SOL_WORKSPACE: join(root, 'wrong-workspace'), CODEX_SOL_RULES: join(root, 'missing-rules.json'),
      CODEX_SOL_CONTEXT_RULES: join(root, 'missing-context.json'), CODEX_SOL_GENERATED_PATHS: '["**/*.wrong"]' } });
  await client.initialize({ timeoutMs: 15000 });

  const hookEnvironment = (overrides = {}) => ({ ...process.env,
    [pathVariable]: hookTransportPath, SOL_RUNTIME_TEST_SECRET: 'synthetic-hook-secret', PLUGIN_DATA: 'synthetic-hook-transport', SOL_PLUGIN_EXECUTION_MODE: '',
    CODEX_SOL_WORKSPACE: join(root, 'wrong-hook-workspace'), CODEX_SOL_RULES: join(root, 'missing-hook-rules.json'),
    CODEX_SOL_CONTEXT_RULES: join(root, 'missing-hook-context.json'), CODEX_SOL_GENERATED_PATHS: '["**/*.wrong-hook"]',
    ...overrides });
  return { root, alternateHome, executionPath, mcpTransportPath, hookTransportPath, client, hookEnvironment };
}

async function call(client, name, args = {}, metadata) {
  const response = await client.request('tools/call', { name, arguments: args, ...(metadata ? { _meta: metadata } : {}) }, { timeoutMs: 20000 });
  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.isError, false, response.result.content?.[0]?.text ?? JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}

async function terminateTree(child, waitForClose) {
  if (child.exitCode !== null || child.signalCode !== null) return waitForClose;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
  return waitForClose;
}

async function runHook(root, event, env, timeoutMs = 12000) {
  const child = spawn(process.execPath, [launcher, 'hook'], { cwd: root, env,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const waitForClose = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let timeout;
  try {
    child.stdin.end(JSON.stringify(event));
    const result = await Promise.race([waitForClose, new Promise((resolve) => { timeout = setTimeout(() => resolve(null), timeoutMs); })]);
    if (!result) {
      await terminateTree(child, waitForClose);
      assert.fail(`Hook CLI exceeded ${timeoutMs} ms and its process tree was terminated.`);
    }
    assert.equal(result.code, 0, `Hook CLI failed (signal=${result.signal}): ${stderr}`);
    assert.ok(Buffer.byteLength(stdout) <= 128 * 1024, 'Hook output must stay within the input/output bound.');
    return JSON.parse(stdout.trim());
  } finally {
    clearTimeout(timeout);
  }
}

function hookContext(result) {
  const text = result.hookSpecificOutput?.additionalContext;
  assert.equal(typeof text, 'string', JSON.stringify(result));
  assert.ok(Buffer.byteLength(text) <= 4096, 'Hook context must stay within the 4096-byte budget.');
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
      rationale: 'The current README states the registered project behavior and the required check passed.', unresolved: [] })),
    uncovered: context.maintenance.uncovered.map((item, index) => ({ index,
      evidence_handles: [source(item.path) ?? declaration,
        ...context.before_sources.filter((before) => before.path === item.path && before.raw).map((before) => before.raw.handle)],
      rationale: 'Reviewed the explicitly uncovered documentation relationship.', unresolved: [] })),
    checks_not_applicable: context.checks_not_applicable_paths.map((path) => ({ path, evidence_handles: [source(path)],
      rationale: 'The documentation-only path introduces no executable behavior.' })),
    unresolved: [] };
}

async function archiveNames(root) {
  return (await readdir(join(root, '.codex', 'sol', 'observations'))).sort();
}

test('configured execution PATH reaches checks while other actual OS condition drift invalidates completion', { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.mcpTransportPath, f.hookTransportPath);
  const query = await call(f.client, 'sol_architecture_query', { paths: ['README.md'] });
  assert.ok(query.raw?.handle);
  const opened = await call(f.client, 'sol_change_open', { task, requirement_ref: 'README.md: project behavior',
    scope: [{ path: 'README.md', module_uid: '00000001' }],
    acceptance: ['The README describes the maintained project behavior.'], expected_architecture_version: query.version,
    reuse: { decision: 'not_applicable', reason: 'This is documentation-only work.', query_handle: query.raw.handle } });
  assert.equal(opened.state, 'open');

  const metadata = { 'x-codex-turn-metadata': { thread_id: session, turn_id: randomUUID() } };
  const preparedContext = await call(f.client, 'sol_context_prepare', { task: { ...task,
    constraints: ['Keep the README accurate and within the registered documentation scope.'] },
    role: 'plan', targets: ['README.md'], change: opened.change }, metadata);
  assert.equal(preparedContext.change_state.change.id, opened.change.id);
  assert.equal(preparedContext.change_state.task_complete, false);

  const applied = await call(f.client, 'sol_apply_changes', { change: opened.change,
    changes: [{ action: 'write', path: 'README.md', content: updatedReadme }] });
  assert.equal(applied.tool_status, 'ok', JSON.stringify(applied));
  assert.deepEqual(applied.changed_paths, ['README.md']);
  assert.equal(applied.validation.status, 'passed', 'The runner exits 7 if the synthetic MCP secret reaches its environment.');
  assert.equal(applied.validation.executed, 1);
  assert.ok(applied.validation.evidence_handle);
  const receiptPath = join(f.root, '.codex', 'sol', 'observations', applied.validation.evidence_handle, 'raw');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.status, 'passed');
  const environmentCheck = receipt.checks.find((check) => check.id === 'documentation/environment-check');
  assert.equal(environmentCheck?.status, 'passed');
  assert.ok(environmentCheck?.output.length);
  const runnerOutput = await readFile(join(f.root, '.codex', 'sol', 'observations', environmentCheck.output[0].handle, 'raw'), 'utf8');
  assert.deepEqual(JSON.parse(runnerOutput), { path: f.executionPath });
  const binding = applied.change.change;

  const review = await call(f.client, 'sol_change_review', { change: binding, phase: 'prepare' });
  assert.equal(review.status, 'ready', JSON.stringify(review));
  const reviewContext = JSON.parse(await readFile(join(f.root, '.codex', 'sol', 'observations', review.raw.handle, 'raw'), 'utf8'));
  const submitted = await call(f.client, 'sol_change_review', { change: review.change, phase: 'submit',
    review_context_handle: review.raw.handle, review: reviewOutput(reviewContext) });
  assert.equal(submitted.review_status, 'ready', JSON.stringify(submitted));
  const completed = await call(f.client, 'sol_change_complete', { change: submitted.change, review_handle: submitted.review.handle });
  assert.equal(completed.task_complete, true, JSON.stringify(completed));

  const event = (hook_event_name, extra = {}) => ({ hook_event_name, cwd: f.root, session_id: session, ...extra });
  const stopBefore = { source: await readFile(join(f.root, 'README.md')),
    pointer: await readFile(join(f.root, '.codex', 'sol', 'architecture', 'active-change.json')),
    receipt: await readFile(receiptPath), archives: await archiveNames(f.root) };
  const stopped = await runHook(f.root, event('Stop', { stop_hook_active: false }), f.hookEnvironment());
  assert.deepEqual(stopped, {});
  assert.deepEqual(await readFile(join(f.root, 'README.md')), stopBefore.source);
  assert.deepEqual(await readFile(join(f.root, '.codex', 'sol', 'architecture', 'active-change.json')), stopBefore.pointer);
  assert.deepEqual(await readFile(receiptPath), stopBefore.receipt);
  assert.deepEqual(await archiveNames(f.root), stopBefore.archives);

  const resumed = hookContext(await runHook(f.root, event('SessionStart', { source: 'resume' }), f.hookEnvironment()));
  assert.equal(resumed.kind, 'context_restore');
  assert.equal(resumed.change_state.task_complete, true, JSON.stringify(resumed));
  assert.equal(resumed.change_state.completion.validity, 'current');
  assert.equal(resumed.change_state.change.id, completed.change.id);

  const driftEnv = process.platform === 'win32' ? { TMP: f.alternateHome } : { HOME: f.alternateHome };
  const driftedStop = await runHook(f.root, event('Stop', { stop_hook_active: false }), f.hookEnvironment(driftEnv));
  assert.ok(driftedStop.decision === 'block' || typeof driftedStop.systemMessage === 'string', JSON.stringify(driftedStop));
  if (driftedStop.decision === 'block') assert.match(driftedStop.reason, /task_complete["']?\s*:\s*false/u);
  const afterDrift = hookContext(await runHook(f.root, event('SessionStart', { source: 'resume' }), f.hookEnvironment(driftEnv)));
  assert.equal(afterDrift.kind, 'context_restore');
  assert.equal(afterDrift.change_state.task_complete, false, JSON.stringify(afterDrift));
  assert.equal(afterDrift.change_state.completion.validity, 'stale');
  assert.equal(afterDrift.change_state.needs_status_refresh, true);
});

test('changing only configured execution_path invalidates completion and the Stop Hook cannot claim success', { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const query = await call(f.client, 'sol_architecture_query', { paths: ['README.md'] });
  const opened = await call(f.client, 'sol_change_open', { task, requirement_ref: 'README.md: project behavior',
    scope: [{ path: 'README.md', module_uid: '00000001' }],
    acceptance: ['The README describes the maintained project behavior.'], expected_architecture_version: query.version,
    reuse: { decision: 'not_applicable', reason: 'This is documentation-only work.', query_handle: query.raw.handle } });
  const metadata = { 'x-codex-turn-metadata': { thread_id: session, turn_id: randomUUID() } };
  const preparedContext = await call(f.client, 'sol_context_prepare', { task: { ...task,
    constraints: ['Keep the README accurate and within the registered documentation scope.'] },
    role: 'plan', targets: ['README.md'], change: opened.change }, metadata);
  assert.equal(preparedContext.change_state.change.id, opened.change.id);
  assert.equal(preparedContext.change_state.task_complete, false);
  const applied = await call(f.client, 'sol_apply_changes', { change: opened.change,
    changes: [{ action: 'write', path: 'README.md', content: updatedReadme }] });
  assert.equal(applied.tool_status, 'ok', JSON.stringify(applied));
  assert.equal(applied.validation.status, 'passed');

  const review = await call(f.client, 'sol_change_review', { change: applied.change.change, phase: 'prepare' });
  assert.equal(review.status, 'ready', JSON.stringify(review));
  const reviewContext = JSON.parse(await readFile(join(f.root, '.codex', 'sol', 'observations', review.raw.handle, 'raw'), 'utf8'));
  const submitted = await call(f.client, 'sol_change_review', { change: review.change, phase: 'submit',
    review_context_handle: review.raw.handle, review: reviewOutput(reviewContext) });
  assert.equal(submitted.review_status, 'ready', JSON.stringify(submitted));
  const completed = await call(f.client, 'sol_change_complete', { change: submitted.change, review_handle: submitted.review.handle });
  assert.equal(completed.task_complete, true, JSON.stringify(completed));

  const projectConfigPath = join(f.root, '.codex', 'sol-project.json');
  const projectConfig = JSON.parse(await readFile(projectConfigPath, 'utf8'));
  const originalConfig = structuredClone(projectConfig);
  projectConfig.execution_path = `${f.executionPath}${process.platform === 'win32' ? ';' : ':'}synthetic-execution-path-drift-${randomUUID()}`;
  await writeFile(projectConfigPath, JSON.stringify(projectConfig));
  const onlyExecutionPathDiffers = structuredClone(projectConfig);
  onlyExecutionPathDiffers.execution_path = originalConfig.execution_path;
  assert.deepEqual(onlyExecutionPathDiffers, originalConfig);

  const event = (hook_event_name, extra = {}) => ({ hook_event_name, cwd: f.root, session_id: session, ...extra });
  const stop = await runHook(f.root, event('Stop', { stop_hook_active: false }), f.hookEnvironment());
  assert.ok(stop.decision === 'block' || typeof stop.systemMessage === 'string', JSON.stringify(stop));
  if (stop.decision === 'block') assert.match(stop.reason, /task_complete["']?\s*:\s*false/u);
  const restored = hookContext(await runHook(f.root, event('SessionStart', { source: 'resume' }), f.hookEnvironment()));
  assert.equal(restored.kind, 'context_restore');
  assert.equal(restored.change_state.task_complete, false, JSON.stringify(restored));
  assert.equal(restored.change_state.completion.validity, 'stale', JSON.stringify(restored));
  assert.equal(restored.change_state.needs_status_refresh, true);
});
