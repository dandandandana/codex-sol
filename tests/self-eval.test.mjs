import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrate, compareReports, gradeRun, prepareRun } from '../benchmarks/self-eval/runner.mjs';

const EVAL_ROOT = fileURLToPath(new URL('../benchmarks/self-eval/', import.meta.url));
const TEMP_PREFIX = 'sol-self-eval-tests-';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  t.after(async () => {
    const absolute = resolve(root);
    assert.equal(dirname(absolute).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(absolute).startsWith(TEMP_PREFIX));
    await rm(absolute, { recursive: true, force: true });
  });
  return root;
}

async function installReference(run, ids) {
  for (const id of ids) {
    await cp(join(EVAL_ROOT, 'reference', id), join(run.out, id, 'workspace'), { recursive: true });
  }
}

async function referenceReport(root, name, caseId) {
  const prepared = await prepareRun({ out: join(root, `${name}-run`), ...(caseId ? { caseId } : {}) });
  await installReference(prepared, prepared.case_ids);
  return gradeRun({ run: prepared.out, out: join(root, `${name}-report`), label: name });
}

async function readReport(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function saveReport(root, name, value) {
  const path = join(root, `${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return path;
}

test('reference corpus passes all task, behavior, compliance, and reuse checks', async (t) => {
  const root = await fixture(t);
  const graded = await referenceReport(root, 'reference');

  assert.deepEqual(graded.report.case_ids, ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08']);
  assert.deepEqual(graded.report.metrics.task_success, { numerator: 8, denominator: 8, rate: 1 });
  assert.deepEqual(graded.report.metrics.behavior_pass, { numerator: 34, denominator: 34, rate: 1 });
  assert.deepEqual(graded.report.metrics.code_compliance, { numerator: 88, denominator: 88, rate: 1, unverified: 0 });
  assert.deepEqual(graded.report.metrics.effective_reuse, { numerator: 12, denominator: 12, rate: 1, unverified: 0 });
  assert.ok(graded.report.results.every((result) => result.success));
  for (const result of graded.report.results) {
    assert.ok(result.reuse.every((opportunity) => opportunity.status === 'verified'));
    assert.deepEqual(
      JSON.parse(await readFile(join(graded.out, result.id, 'result.json'), 'utf8')),
      result,
    );
  }
});

test('a task with no reuse opportunities reports an inapplicable rate', async (t) => {
  const root = await fixture(t);
  const graded = await referenceReport(root, 't06', 'T06');

  assert.deepEqual(graded.report.metrics.effective_reuse, { numerator: 0, denominator: 0, rate: null, unverified: 0 });
  assert.deepEqual(graded.report.metrics.observed_reuse, { numerator: 0, denominator: 0, rate: null });
  assert.deepEqual(graded.report.results[0].reuse, []);
});

test('a missing workspace keeps every denominator and writes a per-case result', async (t) => {
  const root = await fixture(t);
  const run = await prepareRun({ out: join(root, 'missing-run'), caseId: 'T01' });
  await rm(join(run.out, 'T01', 'workspace'), { recursive: true });

  const graded = await gradeRun({ run: run.out, out: join(root, 'missing-report') });
  const result = graded.report.results[0];
  const saved = JSON.parse(await readFile(join(graded.out, 'T01', 'result.json'), 'utf8'));

  assert.equal(result.behavior.reason, 'WORKSPACE_MISSING');
  assert.equal(result.success, false);
  assert.deepEqual(graded.report.metrics.task_success, { numerator: 0, denominator: 1, rate: 0 });
  assert.equal(graded.report.metrics.behavior_pass.denominator, 4);
  assert.equal(graded.report.metrics.code_compliance.denominator, 11);
  assert.equal(graded.report.metrics.effective_reuse.denominator, 2);
  assert.ok(result.behavior.checks.every((check) => check.status === 'unverified'));
  assert.ok(result.compliance.every((check) => check.status === 'unverified'));
  assert.ok(result.reuse.every((opportunity) => opportunity.status === 'unverified'));
  assert.deepEqual(saved, result);
});

test('a correct implementation that imports no shared components earns no reuse credit', async (t) => {
  const root = await fixture(t);
  const run = await prepareRun({ out: join(root, 'independent-run'), caseId: 'T01' });
  const workspace = join(run.out, 'T01', 'workspace');
  const implementation = `export function summarizeByCategory(rows) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const groups = new Map();
  for (const value of rows) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('record must be an object');
    if (typeof value.name !== 'string' || typeof value.category !== 'string') throw new TypeError('record text fields must be strings');
    if (typeof value.amount !== 'number' || !Number.isFinite(value.amount)) throw new TypeError('record amount must be finite');
    const name = value.name.trim();
    if (name.length === 0) throw new TypeError('record name must not be empty');
    const category = value.category.trim() || 'unknown';
    const group = groups.get(category) || { category, count: 0, total: 0 };
    group.count += 1;
    group.total += value.amount;
    groups.set(category, group);
  }
  return [...groups.values()].sort((a, b) => a.category.localeCompare(b.category));
}
`;
  await writeFile(join(workspace, 'src', 'features.mjs'), implementation);
  const registryPath = join(workspace, 'components.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.modules.push({ id: 'features', path: 'src/features.mjs', exports: ['summarizeByCategory'] });
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n');

  const graded = await gradeRun({ run: run.out, out: join(root, 'independent-report') });
  const result = graded.report.results[0];

  assert.equal(result.behavior.status, 'passed');
  assert.ok(result.behavior.checks.every((check) => check.status === 'passed'));
  assert.equal(result.success, true);
  assert.deepEqual(result.reuse.map(({ observed_calls, status }) => ({ observed_calls, status })), [
    { observed_calls: 0, status: 'not_reused' },
    { observed_calls: 0, status: 'not_reused' },
  ]);
});

test('a changed protected component blocks behavioral execution', async (t) => {
  const root = await fixture(t);
  const run = await prepareRun({ out: join(root, 'protected-run'), caseId: 'T01' });
  await installReference(run, ['T01']);
  const protectedPath = join(run.out, 'T01', 'workspace', 'src', 'records.mjs');
  await writeFile(protectedPath, (await readFile(protectedPath, 'utf8')) + '\n// changed protected baseline\n');

  const graded = await gradeRun({ run: run.out, out: join(root, 'protected-report') });
  const result = graded.report.results[0];

  assert.equal(result.success, false);
  assert.equal(result.behavior.status, 'unverified');
  assert.equal(result.behavior.reason, 'PREFLIGHT_REJECTED');
  assert.equal(result.compliance.find((check) => check.id === 'protected_files').status, 'failed');
  assert.equal(result.execution, undefined);
  assert.ok(result.reuse.every((opportunity) => opportunity.status === 'unverified'));
});

test('a verifier that does not finish times out and leaves reuse unverified', async (t) => {
  const root = await fixture(t);
  const run = await prepareRun({ out: join(root, 'timeout-run'), caseId: 'T01' });
  const workspace = join(run.out, 'T01', 'workspace');
  await writeFile(join(workspace, 'src', 'features.mjs'), 'export function summarizeByCategory() { while (true) {} }\n');
  const registryPath = join(workspace, 'components.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.modules.push({ id: 'features', path: 'src/features.mjs', exports: ['summarizeByCategory'] });
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n');

  const graded = await gradeRun({ run: run.out, out: join(root, 'timeout-report'), timeoutMs: 100 });
  const result = graded.report.results[0];

  assert.equal(result.success, false);
  assert.equal(result.behavior.status, 'unverified');
  assert.equal(result.behavior.reason, 'TIMEOUT');
  assert.equal(result.execution.error_code, 'ETIMEDOUT');
  assert.ok(result.reuse.length > 0);
  assert.ok(result.reuse.every((opportunity) => opportunity.observed_calls === null && opportunity.status === 'unverified'));
});

test('comparison accepts matching reports and rejects mismatched or altered evidence', async (t) => {
  const root = await fixture(t);
  const reference = await referenceReport(root, 'compare-reference');
  const blankRun = await prepareRun({ out: join(root, 'blank-run') });
  const blank = await gradeRun({ run: blankRun.out, out: join(root, 'blank-report'), label: 'blank' });

  const compared = await compareReports({
    a: join(reference.out, 'report.json'),
    b: join(blank.out, 'report.json'),
    out: join(root, 'valid-comparison'),
  });
  assert.equal(compared.comparison.metrics.task_success.a.rate, 1);
  assert.equal(compared.comparison.metrics.task_success.b.rate, 0);
  assert.equal(compared.comparison.metrics.task_success.delta_percentage_points, -100);
  assert.equal(compared.comparison.metrics.effective_reuse.delta_percentage_points, -100);
  assert.equal(
    JSON.parse(await readFile(join(compared.out, 'comparison.json'), 'utf8')).kind,
    'self_eval_comparison',
  );

  const t06 = await referenceReport(root, 'compare-t06', 'T06');
  const firstPath = join(reference.out, 'report.json');
  const secondPath = join(blank.out, 'report.json');
  await assert.rejects(compareReports({ a: firstPath, b: join(t06.out, 'report.json'), out: join(root, 'different-cases') }));

  const runtimeVariant = await readReport(firstPath);
  runtimeVariant.runtime.node = `${runtimeVariant.runtime.node}-different`;
  const runtimePath = await saveReport(root, 'different-runtime', runtimeVariant);
  await assert.rejects(compareReports({ a: firstPath, b: runtimePath, out: join(root, 'different-runtime-output') }));

  const bundleVariant = await readReport(firstPath);
  bundleVariant.bundle_sha256 = 'a'.repeat(64);
  const bundlePath = await saveReport(root, 'different-bundle', bundleVariant);
  await assert.rejects(compareReports({ a: firstPath, b: bundlePath, out: join(root, 'different-bundle-output') }));

  const metricVariant = await readReport(firstPath);
  metricVariant.metrics.task_success.numerator -= 1;
  metricVariant.metrics.task_success.rate = metricVariant.metrics.task_success.numerator / metricVariant.metrics.task_success.denominator;
  const metricPath = await saveReport(root, 'altered-metrics', metricVariant);
  await assert.rejects(compareReports({ a: firstPath, b: metricPath, out: join(root, 'altered-metrics-output') }));

  assert.equal((await readReport(secondPath)).case_ids.length, 8);
});

test('source and input directories cannot be used as outputs, and existing outputs stay intact', async (t) => {
  const root = await fixture(t);
  const sourceOutput = join(EVAL_ROOT, 'base', 'must-not-be-created');
  await assert.rejects(prepareRun({ out: sourceOutput }));

  const run = await prepareRun({ out: join(root, 'protected-input-run'), caseId: 'T06' });
  await assert.rejects(gradeRun({ run: run.out, out: run.out }));
  assert.ok(await readFile(join(run.out, 'run.json'), 'utf8'));

  const existing = join(root, 'existing-output');
  await mkdir(existing);
  const sentinel = join(existing, 'keep.txt');
  await writeFile(sentinel, 'preserve existing output');
  await assert.rejects(gradeRun({ run: run.out, out: existing }));
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve existing output');
});

test('a linked workspace entry is rejected without including outside file content', async (t) => {
  const root = await fixture(t);
  const run = await prepareRun({ out: join(root, 'linked-run'), caseId: 'T01' });
  const outside = join(root, 'outside-party');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'outside-content-must-not-be-read');
  const linkedPath = join(run.out, 'T01', 'workspace', 'src', 'outside');
  try {
    await symlink(outside, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`directory links are unavailable here (${error.code})`);
      return;
    }
    throw error;
  }

  const graded = await gradeRun({ run: run.out, out: join(root, 'linked-report') });
  const result = graded.report.results[0];
  const serialized = await readFile(join(graded.out, 'report.json'), 'utf8');

  assert.equal(result.success, false);
  assert.equal(result.behavior.status, 'unverified');
  assert.equal(result.behavior.reason, 'PREFLIGHT_REJECTED');
  assert.ok(result.compliance.some((check) => check.findings.some((finding) => finding.code === 'LINKED_INPUT')));
  assert.ok(result.source_snapshot.every(({ path }) => !path.startsWith('src/outside/')));
  assert.equal(result.execution, undefined);
  assert.equal(serialized.includes('outside-content-must-not-be-read'), false);
});

test('calibration records a passing grader check and a separate unsolved baseline', async (t) => {
  const root = await fixture(t);
  const result = await calibrate({ out: join(root, 'calibration') });

  assert.equal(result.status, 'passed');
  assert.equal(result.kind, 'grader_calibration');
  assert.equal(result.not_a_model_eval, true);
  assert.equal(result.positive.task_success.rate, 1);
  assert.equal(result.positive.behavior_pass.rate, 1);
  assert.equal(result.positive.code_compliance.rate, 1);
  assert.equal(result.positive.effective_reuse.rate, 1);
  assert.equal(result.unsolved.task_success.rate, 0);
  assert.equal(result.unsolved.effective_reuse.rate, 0);
  assert.deepEqual(result.mutants.map((mutant) => mutant.name), [
    'unused-import',
    'copied-component',
    'protected-source',
    'outside-scope',
    'timeout',
  ]);
  assert.ok(result.mutants.every((mutant) => mutant.status === 'passed'));
  assert.equal(await readFile(join(result.out, 'calibration.json'), 'utf8').then((value) => JSON.parse(value).status), 'passed');
});

test('unregistered default and star exports fail component registry compliance', async (t) => {
  const root = await fixture(t);
  const additions = [
    ['default-export', 'export default 1;'],
    ['star-export', "export * from './report.mjs';"],
  ];

  for (const [name, declaration] of additions) {
    const run = await prepareRun({ out: join(root, `${name}-run`), caseId: 'T01' });
    await installReference(run, ['T01']);
    const entryPath = join(run.out, 'T01', 'workspace', 'src', 'features.mjs');
    const source = await readFile(entryPath, 'utf8');
    await writeFile(entryPath, `${source}\n${declaration}\n`);

    const graded = await gradeRun({ run: run.out, out: join(root, `${name}-report`) });
    const result = graded.report.results[0];

    assert.equal(result.behavior.status, 'passed', name);
    assert.equal(result.compliance.find((check) => check.id === 'component_registry').status, 'failed', name);
    assert.equal(result.success, false, name);
    assert.ok(result.reuse.every((opportunity) => opportunity.status !== 'verified'), name);
    assert.equal(graded.report.metrics.effective_reuse.numerator, 0, name);
  }
});
