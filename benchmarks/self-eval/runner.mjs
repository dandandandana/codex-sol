import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, lstat, realpath, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusSchema, runSchema } from './schema.mjs';
import { snapshot, inspectCandidate, coverageCounts, complianceIds } from './rubric.mjs';
import { behaviorCheckIds } from './verify.mjs';
import { pluginExecutionEnvironment } from '../../src/plugin-launcher.mjs';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const REPO = resolve(HERE, '../..');
const BASE = join(HERE, 'base');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''));
const writeJSON = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const within = (a, b) => { const p = relative(a, b); return p === '' || (!p.startsWith('..' + sep) && p !== '..' && !isAbsolute(p)); };
function fail(message) { throw new Error(message); }

async function freshDirectory(value, forbidden = []) {
  assert.equal(typeof value, 'string');
  const target = resolve(value);
  let parent = dirname(target), suffix = [target.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))];
  while (true) {
    try { const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) fail('Output parent must be a physical directory'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const next = dirname(parent); if (next === parent) throw error; suffix.unshift(parent.slice(next.length + (next.endsWith(sep) ? 0 : 1))); parent = next; }
  }
  const physical = resolve(await realpath(parent), ...suffix);
  if (within(physical, REPO) || [HERE, join(REPO, 'src'), join(REPO, 'tests'), join(REPO, 'node_modules'), ...forbidden].some(path => within(path, physical))) fail('Output overlaps source or input directories');
  try { await lstat(physical); fail('Output already exists; choose a new directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(physical), { recursive: true }); await mkdir(physical);
  return physical;
}
async function physicalInput(value) { const full = resolve(value), info = await lstat(full); if (!info.isDirectory() || info.isSymbolicLink()) fail('Input must be a physical directory'); return realpath(full); }
async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const name of (await readdir(source)).sort()) {
    const input = join(source, name), output = join(destination, name), info = await lstat(input);
    if (info.isSymbolicLink()) fail('Linked corpus file is not supported');
    if (info.isDirectory()) await copyTree(input, output); else if (info.isFile()) await copyFile(input, output); else fail('Non-regular corpus file');
  }
}
async function corpus() {
  const tasks = corpusSchema.parse(await readJSON(join(HERE, 'tasks.json')));
  const baseline = await snapshot(BASE), inputs = [...baseline.files.values()].map(f => ({ path: 'base/' + f.path, sha256: f.sha256 }));
  for (const name of ['tasks.json', 'schema.mjs', 'rubric.mjs', 'verify.mjs', 'runner.mjs', 'cli.mjs']) inputs.push({ path: name, sha256: sha(await readFile(join(HERE, name))) });
  inputs.sort((a,b) => a.path.localeCompare(b.path));
  return { ...tasks, baseline, inputs, bundle_sha256: sha(JSON.stringify(inputs)) };
}

export async function prepareRun({ out, caseId } = {}) {
  const data = await corpus();
  const cases = caseId ? data.cases.filter(c => c.id === caseId) : data.cases;
  if (!cases.length) fail('Unknown case ID');
  const directory = await freshDirectory(out);
  for (const task of cases) {
    const caseRoot = join(directory, task.id); await copyTree(BASE, join(caseRoot, 'workspace'));
    await writeFile(join(caseRoot, 'TASK.md'), `# ${task.id} ${task.title}\n\n${task.prompt}\n\n允许修改：${task.allowed_paths.join('、')}。其他基线文件不得修改。\n\n同步 components.json：模块 ${task.api.module_id}，路径 ${task.api.path}，导出 ${task.api.exports.join('、')}${task.api.options ? '，options ' + task.api.options.join('、') : ''}。保留其他模块。\n\n先阅读 workspace/AGENTS.md 和已有组件；不要读取评测器或 reference。\n`);
  }
  const metadata = { schema_version: 1, benchmark_id: data.benchmark_id, bundle_sha256: data.bundle_sha256, case_ids: cases.map(c => c.id), created_at: new Date().toISOString() };
  await writeJSON(join(directory, 'run.json'), metadata);
  return { out: directory, ...metadata };
}
function fraction(numerator, denominator) { return { numerator, denominator, rate: denominator ? numerator / denominator : null }; }
export function aggregateResults(results) {
  const behavior = results.flatMap(r => r.behavior.checks), compliance = results.flatMap(r => r.compliance), reuse = results.flatMap(r => r.reuse);
  return {
    task_success: fraction(results.filter(r => r.success).length, results.length),
    behavior_pass: fraction(behavior.filter(c => c.status === 'passed').length, behavior.length),
    code_compliance: { ...fraction(compliance.filter(c => c.status === 'passed').length, compliance.length), unverified: compliance.filter(c => c.status === 'unverified').length },
    effective_reuse: { ...fraction(reuse.filter(r => r.status === 'verified').length, reuse.length), unverified: reuse.filter(r => r.status === 'unverified').length },
    observed_reuse: fraction(reuse.filter(r => r.observed_calls >= r.min_calls).length, reuse.length),
  };
}
const percentage = metric => metric.rate === null ? 'N/A' : (metric.rate * 100).toFixed(1) + '%';
const text = value => String(value).replaceAll('|', '\\|').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('`', "'").replaceAll('\n',' ');
function reportMarkdown(report) {
  const names = { task_success: '任务成功率', behavior_pass: '行为检查通过率', code_compliance: '代码规则合规率', effective_reuse: '有效组件复用率', observed_reuse: '原始执行复用率（诊断）' };
  return `# 自评结果：${text(report.label)}\n\n本报告是固定合成任务的评分；模型身份来自标签声明，不是身份验证。\n\n| 指标 | 通过 / 适用 | 比率 |\n| --- | --- | --- |\n` + Object.entries(report.metrics).map(([key,m]) => `| ${names[key]} | ${m.numerator} / ${m.denominator} | ${percentage(m)} |`).join('\n') +
    '\n\n| 任务 | 完成 | 行为 | 合规 | 有效复用 |\n| --- | --- | --- | --- | --- |\n' + report.results.map(r => `| ${r.id} ${text(r.title)} | ${r.success ? '通过' : '未通过'} | ${r.behavior.checks.filter(c=>c.status==='passed').length}/${r.behavior.checks.length} | ${r.compliance.filter(c=>c.status==='passed').length}/${r.compliance.length} | ${r.reuse.filter(c=>c.status==='verified').length}/${r.reuse.length || 'N/A'} |`).join('\n') +
    '\n\n没有模型使用量日志，token、费用与模型任务耗时均为未测量。grade_duration_ms 只表示评分耗时。\n\n诊断、源文件哈希、规则和覆盖证据见 report.json。V8 覆盖证明函数执行，不能证明语义最优；此工具不是恶意代码沙箱。\n';
}
function unknownCase(task, code) {
  return { id: task.id, title: task.title, success: false,
    behavior: { status: 'unverified', checks: behaviorCheckIds(task.id).map(id => ({ id, status: 'unverified' })), reason: code },
    compliance: complianceIds.map(id => ({ id, status: 'unverified', findings: [{ code }] })),
    reuse: task.reuse.map(o => ({ ...o, observed_calls: null, status: 'unverified' })), source_snapshot: [], coverage: [] };
}
async function gradeCase(task, run, out, data, timeoutMs) {
  const started = Date.now(), result = unknownCase(task, 'NO_EVIDENCE');
  let root = join(run, task.id, 'workspace');
  const caseOut = join(out, task.id); await mkdir(caseOut); const coverage = join(caseOut, 'coverage'); await mkdir(coverage);
  let inspection;
  try {
    const caseRoot = await physicalInput(join(run, task.id));
    if (!within(run, caseRoot)) fail('Case directory leaves the prepared run');
    root = await physicalInput(join(caseRoot, 'workspace'));
    if (!within(caseRoot, root)) fail('Workspace leaves its case directory');
    inspection = await inspectCandidate(root, BASE, data.baseline, task);
  } catch (error) {
    const unavailable = unknownCase(task, error.code === 'ENOENT' ? 'WORKSPACE_MISSING' : 'INPUT_UNAVAILABLE');
    unavailable.grade_duration_ms = Date.now() - started;
    await writeJSON(join(caseOut, 'result.json'), unavailable);
    return unavailable;
  }
  result.compliance = inspection.checks;
  result.source_snapshot = [...inspection.current.files.values()];
  result.behavior.reason = inspection.blocked ? 'PREFLIGHT_REJECTED' : null;
  if (!inspection.blocked) {
    const child = spawnSync(process.execPath, [join(HERE, 'verify.mjs'), task.id, root, task.entry, task.export_name], {
      cwd: root, env: { ...pluginExecutionEnvironment(process.env), NODE_V8_COVERAGE: coverage },
      encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
    });
    await writeFile(join(caseOut, 'stdout.txt'), child.stdout ?? ''); await writeFile(join(caseOut, 'stderr.txt'), child.stderr ?? '');
    result.execution = { exit_code: child.status, signal: child.signal, error_code: child.error?.code ?? null };
    try {
      if (child.error || child.status !== 0) fail('Verifier did not finish');
      const lines = (child.stdout ?? '').split(/\r?\n/u).filter(Boolean);
      if (lines.length !== 1 || !lines[0].startsWith('SOL_EVAL_RESULT=')) fail('Unexpected verifier output');
      const observed = JSON.parse(lines[0].slice('SOL_EVAL_RESULT='.length));
      assert.equal(observed.case_id, task.id); assert.deepEqual(observed.checks.map(c => c.id), behaviorCheckIds(task.id));
      assert.ok(observed.checks.every(c => ['passed','failed'].includes(c.status)));
      result.behavior = { status: observed.checks.every(c => c.status === 'passed') ? 'passed' : 'failed', checks: observed.checks };
      const covered = await coverageCounts(coverage, root, task.reuse); result.coverage = covered.files;
      result.reuse = task.reuse.map(o => ({ ...o, observed_calls: covered.counts.get(o.id + ':' + o.export_name), status: 'not_reused' }));
    } catch {
      result.behavior = { status: 'unverified', checks: behaviorCheckIds(task.id).map(id => ({ id, status: 'unverified' })),
        reason: child.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'INCOMPLETE_VERIFIER_OR_COVERAGE' };
      result.reuse = task.reuse.map(o => ({ ...o, observed_calls: null, status: 'unverified' }));
    }
  }
  try {
    const after = await snapshot(root); assert.deepEqual([...after.files.values()], result.source_snapshot); assert.deepEqual(after.problems, inspection.current.problems);
  } catch { const c = result.compliance.find(c=>c.id==='source_stability'); c.status='failed'; c.findings.push({code:'INPUT_CHANGED_DURING_GRADE'}); }
  result.success = result.behavior.status === 'passed' && result.compliance.every(c=>c.status==='passed');
  for (const r of result.reuse) if (r.observed_calls !== null) r.status = result.success && r.observed_calls >= r.min_calls ? 'verified' : r.observed_calls >= r.min_calls ? 'invalid_task' : 'not_reused';
  result.grade_duration_ms = Date.now() - started;
  await writeJSON(join(caseOut, 'result.json'), result);
  return result;
}

export async function gradeRun({ run, out, label = '未标注', timeoutMs = 5000 } = {}) {
  if (typeof label !== 'string' || !label.trim() || label.length > 200 || /[\r\n\0]/u.test(label)) fail('Label must be a nonempty single line');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) fail('timeoutMs must be an integer from 100 to 30000');
  const started = Date.now(), data = await corpus(), input = await physicalInput(run), metadata = runSchema.parse(await readJSON(join(input, 'run.json')));
  if (metadata.bundle_sha256 !== data.bundle_sha256) fail('Benchmark baseline or grader changed; prepare a new run');
  const directory = await freshDirectory(out, [input]), results = [];
  for (const id of metadata.case_ids) results.push(await gradeCase(data.cases.find(c=>c.id===id), input, directory, data, timeoutMs));
  const report = { schema_version: 1, kind: 'self_eval_report', benchmark_id: data.benchmark_id, bundle_sha256: data.bundle_sha256,
    created_at: new Date().toISOString(), label, label_identity_verified: false, case_ids: metadata.case_ids,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    metrics: aggregateResults(results), model_usage: { tokens: null, cost: null, task_duration_ms: null, status: 'not_measured' },
    grade_duration_ms: Date.now() - started, results, corpus_inputs: data.inputs };
  await writeJSON(join(directory, 'report.json'), report); await writeFile(join(directory, 'report.md'), reportMarkdown(report));
  return { out: directory, report };
}
async function validatedReport(path) {
  const report = await readJSON(path), data = await corpus();
  assert.equal(report.schema_version,1); assert.equal(report.kind,'self_eval_report'); assert.equal(report.benchmark_id,data.benchmark_id); assert.equal(report.bundle_sha256,data.bundle_sha256);
  assert.deepEqual(report.corpus_inputs, data.inputs);
  assert.ok(typeof report.label === 'string' && report.label.trim() && report.label.length <= 200 && !/[\r\n\0]/u.test(report.label));
  assert.equal(report.label_identity_verified, false);
  assert.ok(report.runtime && typeof report.runtime.node === 'string' && typeof report.runtime.platform === 'string' && typeof report.runtime.architecture === 'string');
  assert.deepEqual(report.model_usage, { tokens: null, cost: null, task_duration_ms: null, status: 'not_measured' });
  assert.ok(Array.isArray(report.results) && report.results.length > 0 && report.results.length <= 8);
  assert.deepEqual(report.case_ids,report.results.map(r=>r.id)); assert.equal(new Set(report.case_ids).size,report.case_ids.length);
  for (const result of report.results) {
    const task=data.cases.find(c=>c.id===result.id); assert.ok(task);
    assert.deepEqual(result.behavior.checks.map(c=>c.id),behaviorCheckIds(task.id)); assert.ok(result.behavior.checks.every(c=>['passed','failed','unverified'].includes(c.status)));
    const statuses = result.behavior.checks.map(c=>c.status);
    const expectedBehavior = statuses.every(s=>s==='passed') ? 'passed' : statuses.every(s=>s==='unverified') ? 'unverified' : 'failed';
    assert.equal(result.behavior.status, expectedBehavior);
    assert.deepEqual(result.compliance.map(c=>c.id),complianceIds); assert.ok(result.compliance.every(c=>['passed','failed','unverified'].includes(c.status)));
    assert.deepEqual(result.reuse.map(o=>[o.id,o.path,o.export_name,o.min_calls]),task.reuse.map(o=>[o.id,o.path,o.export_name,o.min_calls]));
    assert.equal(result.success,result.behavior.status==='passed' && result.behavior.checks.every(c=>c.status==='passed') && result.compliance.every(c=>c.status==='passed'));
    for(const opportunity of result.reuse) {
      assert.ok(opportunity.observed_calls===null || Number.isSafeInteger(opportunity.observed_calls) && opportunity.observed_calls>=0);
      const expected=opportunity.observed_calls===null ? 'unverified' : result.success && opportunity.observed_calls>=opportunity.min_calls ? 'verified' : opportunity.observed_calls>=opportunity.min_calls ? 'invalid_task' : 'not_reused';
      assert.equal(opportunity.status,expected);
    }
  }
  assert.deepEqual(report.metrics,aggregateResults(report.results)); return report;
}
export async function compareReports({ a, b, out } = {}) {
  const first = await validatedReport(a), second = await validatedReport(b);
  assert.deepEqual(first.case_ids,second.case_ids,'Compare the same case set and order'); assert.deepEqual(first.runtime,second.runtime,'Compare under the same grading runtime');
  const metrics=Object.fromEntries(Object.keys(first.metrics).map(key=>{ const x=first.metrics[key],y=second.metrics[key]; assert.equal(x.denominator,y.denominator); return [key,{a:x,b:y,delta_percentage_points:x.rate===null||y.rate===null?null:(y.rate-x.rate)*100}]; }));
  const comparison={schema_version:1,kind:'self_eval_comparison',benchmark_id:first.benchmark_id,bundle_sha256:first.bundle_sha256,labels:{a:first.label,b:second.label},case_ids:first.case_ids,metrics,model_usage:{status:'not_measured',token_savings:null,cost_savings:null},report_hashes:{a:sha(await readFile(a)),b:sha(await readFile(b))}};
  const directory=await freshDirectory(out);
  await writeJSON(join(directory,'comparison.json'),comparison);
  await writeFile(join(directory,'comparison.md'),`# 自评对比\n\nA：${text(first.label)}；B：${text(second.label)}。差值为 B − A 的百分点，不是相对提升比例。\n\n| 指标 | A | B | 差值（百分点） |\n| --- | --- | --- | --- |\n`+Object.entries(metrics).map(([name,m])=>`| ${name} | ${percentage(m.a)} | ${percentage(m.b)} | ${m.delta_percentage_points===null?'N/A':m.delta_percentage_points.toFixed(1)} |`).join('\n')+'\n\n未采集模型使用量，本报告不推断 token 或费用节省。\n');
  return {out:directory,comparison};
}
export async function calibrate({ out } = {}) {
  const directory=await freshDirectory(out);
  const good=await prepareRun({out:join(directory,'reference-run')});
  for(const id of good.case_ids) await copyTree(join(HERE,'reference',id),join(good.out,id,'workspace'));
  const positive=await gradeRun({run:good.out,out:join(directory,'reference-report'),label:'reference-calibration'});
  assert.equal(positive.report.metrics.task_success.rate,1); assert.equal(positive.report.metrics.effective_reuse.rate,1);
  const baseline=await prepareRun({out:join(directory,'unsolved-run')});
  const negative=await gradeRun({run:baseline.out,out:join(directory,'unsolved-report'),label:'unsolved-calibration'});
  assert.equal(negative.report.metrics.task_success.rate,0); assert.equal(negative.report.metrics.effective_reuse.rate,0);
  const mutants = [];
  async function mutant(name, change, verify, timeoutMs = 5000) {
    const candidate = await prepareRun({out:join(directory,name+'-run'),caseId:'T01'});
    const workspace = join(candidate.out,'T01','workspace');
    await copyTree(join(HERE,'reference','T01'),workspace);
    await change(workspace);
    const graded = await gradeRun({run:candidate.out,out:join(directory,name+'-report'),label:name,timeoutMs});
    assert.equal(graded.report.metrics.task_success.numerator,0);
    assert.equal(graded.report.metrics.effective_reuse.numerator,0);
    verify(graded.report.results[0]);
    mutants.push({name,status:'passed',metrics:graded.report.metrics});
  }
  await mutant('unused-import', root=>writeFile(join(root,'src/features.mjs'),
    "import { normalizeRecord } from './records.mjs';\nimport { summarizeRecords } from './report.mjs';\nexport function summarizeByCategory() { return []; }\n"),
    result=>{ assert.equal(result.behavior.status,'failed'); assert.ok(result.reuse.every(r=>r.observed_calls===0)); });
  await mutant('copied-component', async root=>{
    const component=await readFile(join(BASE,'src/records.mjs'),'utf8');
    await writeFile(join(root,'src/features.mjs'),(await readFile(join(root,'src/features.mjs'),'utf8'))+'\n'+component.replace('export function normalizeRecord','function copiedRecord'));
  }, result=>{ assert.equal(result.compliance.find(c=>c.id==='no_copied_component').status,'failed'); assert.equal(result.behavior.status,'passed'); });
  await mutant('protected-source', root=>writeFile(join(root,'src/records.mjs'),'// Changed protected source\n',{flag:'a'}),
    result=>{ assert.equal(result.compliance.find(c=>c.id==='protected_files').status,'failed'); assert.equal(result.behavior.reason,'PREFLIGHT_REJECTED'); });
  await mutant('outside-scope', root=>writeFile(join(root,'extra.txt'),'Unexpected file\n'),
    result=>{ assert.equal(result.compliance.find(c=>c.id==='scope').status,'failed'); assert.equal(result.behavior.status,'passed'); });
  await mutant('timeout', root=>writeFile(join(root,'src/features.mjs'),'export function summarizeByCategory() { while (true) {} }\n'),
    result=>{ assert.equal(result.behavior.status,'unverified'); assert.equal(result.behavior.reason,'TIMEOUT'); },250);
  const references = await snapshot(join(HERE,'reference'));
  assert.equal(references.problems.length,0);
  const evidence={schema_version:1,status:'passed',kind:'grader_calibration',not_a_model_eval:true,created_at:new Date().toISOString(),
    bundle_sha256:good.bundle_sha256,runtime:positive.report.runtime,
    reference_inputs:[...references.files.values()],positive:positive.report.metrics,unsolved:negative.report.metrics,mutants};
  await writeJSON(join(directory,'calibration.json'),evidence); return {out:directory,...evidence};
}
