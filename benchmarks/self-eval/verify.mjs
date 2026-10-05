// Trusted behavioral checks stay outside the candidate workspace.
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const row = (name = ' A ', category = ' x ', amount = 2) => ({ name, category, amount });
const normalized = { name: 'A', category: 'x', amount: 2 };
let entry, root;
const specifications = {
  T01: [
    ['group_totals', async () => assert.deepEqual(await entry([row('C', ' y ', 4), row(), row('B', 'x', -3)]), [{ category: 'x', count: 2, total: -1 }, { category: 'y', count: 1, total: 4 }])],
    ['empty_and_unknown', async () => { assert.deepEqual(await entry([]), []); assert.deepEqual(await entry([row('Z', '  ', 0)]), [{ category: 'unknown', count: 1, total: 0 }]); }],
    ['reject_invalid', async () => { for (const input of [null, {}, [row(' ', 'x')], [row('A', 'x', Infinity)], [row('A', 3)]]) await assert.rejects(async () => entry(input), TypeError); }],
    ['preserve_input', async () => { const rows = [Object.freeze(row())]; Object.freeze(rows); await entry(rows); assert.deepEqual(rows, [row()]); }],
  ],
  T02: [
    ['escape_text_and_attribute', async () => assert.equal(await entry([row('<b>&"\'', '\"><img>&\'', 1)]), '<ul><li data-category="&quot;&gt;&lt;img&gt;&amp;&#39;">&lt;b&gt;&amp;&quot;&#39;</li></ul>')],
    ['order_and_empty', async () => { assert.equal(await entry([]), '<ul></ul>'); assert.equal(await entry([row(' A ', ' ', 0), row('B', 'x', -2)]), '<ul><li data-category="unknown">A</li><li data-category="x">B</li></ul>'); }],
    ['reject_invalid', async () => { for (const input of [null, [row('', 'x')], [row('A', 'x', NaN)]]) await assert.rejects(async () => entry(input), TypeError); }],
    ['preserve_input', async () => { await entry(Object.freeze([Object.freeze(row())])); }],
  ],
  T03: [
    ['read_once_and_total', async () => { let reads = 0; assert.deepEqual(await entry(async () => { reads++; return JSON.stringify([row(), row('B', ' ', -1)]); }), { count: 2, total: 1 }); assert.equal(reads, 1); }],
    ['empty', async () => assert.deepEqual(await entry(async () => '[]'), { count: 0, total: 0 })],
    ['propagate_read_failure', async () => { const error = new Error('fixture read failed'); await assert.rejects(() => entry(async () => { throw error; }), e => e === error); }],
    ['reject_parse_and_shape', async () => { await assert.rejects(() => entry(async () => '{'), SyntaxError); await assert.rejects(() => entry(async () => '{}'), TypeError); await assert.rejects(() => entry(async () => JSON.stringify([row(' ')])), TypeError); await assert.rejects(async () => entry(null), TypeError); }],
  ],
  T04: [
    ['retry_read_then_success', async () => { for (const options of [{ attempts: 3 }, undefined]) { let calls = 0; const result = await entry(async () => { if (++calls < 3) throw new Error('temporary'); return JSON.stringify([row()]); }, options); assert.deepEqual(result, { count: 1, total: 2 }); assert.equal(calls, 3); } }],
    ['bound_and_last_error', async () => { let calls = 0; const error = new Error('read failed'); await assert.rejects(() => entry(async () => { calls++; throw error; }, { attempts: 2 }), e => e === error); assert.equal(calls, 2); }],
    ['parse_failure_is_not_retried', async () => { for (const [text, error] of [['{', SyntaxError], ['{}', TypeError], [JSON.stringify([row(' ')]), TypeError]]) { let calls = 0; await assert.rejects(() => entry(async () => { calls++; return text; }, { attempts: 3 }), error); assert.equal(calls, 1); } }],
    ['abort_without_another_read', async () => { const c = new AbortController(), error = new Error('stop'); let calls = 0; c.abort(error); await assert.rejects(() => entry(async () => { calls++; return '[]'; }, { signal: c.signal }), e => e === error); assert.equal(calls, 0); const d = new AbortController(); await assert.rejects(() => entry(async () => { calls++; d.abort(error); throw error; }, { signal: d.signal }), e => e === error); assert.equal(calls, 1); const plain = new AbortController(); plain.abort(); await assert.rejects(() => entry(async () => { calls++; return '[]'; }, { signal: plain.signal }), e => e.name === 'AbortError'); assert.equal(calls, 1); }],
    ['validate_options', async () => { for (const attempts of [0, 6, 1.5]) await assert.rejects(() => entry(async () => '[]', { attempts }), RangeError); await assert.rejects(async () => entry(null), TypeError); }],
  ],
  T05: [
    ['legacy_behavior', async () => { assert.deepEqual(await entry([row(), row(' B ', 'y')]), ['A', 'B']); assert.deepEqual(await entry([]), []); }],
    ['category_filter', async () => { const rows = [row(), row('B', 'y'), row('C', ' ')]; assert.deepEqual(await entry(rows, { category: ' x ' }), ['A']); assert.deepEqual(await entry(rows, { category: ' ' }), ['C']); assert.deepEqual(await entry(rows, { category: 'absent' }), []); assert.deepEqual(await entry(rows, Object.create({ category: 'y' })), ['A', 'B', 'C']); }],
    ['invalid_category_and_records', async () => { for (const category of [3, undefined]) await assert.rejects(async () => entry([row()], { category }), TypeError); await assert.rejects(async () => entry(null), TypeError); await assert.rejects(async () => entry([row('')]), TypeError); await assert.rejects(async () => entry([row('', 'y'), row()], { category: 'x' }), TypeError); }],
    ['existing_consumer', async () => { const { readLabels } = await import(pathToFileURL(join(root, 'src/consumer.mjs'))); assert.deepEqual(readLabels([row()]), ['A']); }],
  ],
  T06: [
    ['pages', async () => { assert.deepEqual(await entry(['a','b','c'], { offset: 0, limit: 2 }), { items: ['a','b'], nextOffset: 2, total: 3 }); assert.deepEqual(await entry(['a','b','c'], { offset: 2, limit: 2 }), { items: ['c'], nextOffset: null, total: 3 }); }],
    ['empty_and_end', async () => { assert.deepEqual(await entry([]), { items: [], nextOffset: null, total: 0 }); assert.deepEqual(await entry([1], { offset: 1 }), { items: [], nextOffset: null, total: 1 }); }],
    ['validate_boundaries', async () => { for (const options of [{ offset: -1 }, { offset: 2 }, { limit: 0 }, { limit: 101 }]) await assert.rejects(async () => entry([1], options), RangeError); for (const options of [{ offset: 0.5 }, { limit: Infinity }]) await assert.rejects(async () => entry([1], options), TypeError); await assert.rejects(async () => entry(null), TypeError); }],
    ['default_and_no_mutation', async () => { const input = Object.freeze(Array.from({ length: 21 }, (_, i) => i)); const result = await entry(input); assert.deepEqual(result, { items: Array.from({ length: 20 }, (_, i) => i), nextOffset: 20, total: 21 }); assert.equal(input.length, 21); }],
  ],
  T07: [
    ['complete', async () => { const seen = []; const result = await entry([row(), row('B', 'y', 3)], { onRecord: async (r, i) => seen.push([r, i]) }); assert.deepEqual(result, { status: 'completed', nextIndex: 2, processed: [normalized, { name: 'B', category: 'y', amount: 3 }] }); assert.deepEqual(seen.map(x => x[1]), [0, 1]); }],
    ['interrupt_and_resume_without_replay', async () => { const c = new AbortController(), seen = [], rows = [row(), row('B'), row('C')]; const first = await entry(rows, { signal: c.signal, onRecord: async (_, i) => { seen.push(i); if (i === 1) c.abort(); } }); assert.deepEqual(first, { status: 'interrupted', nextIndex: 2, processed: [normalized, { name: 'B', category: 'x', amount: 2 }] }); const second = await entry(rows, { start: first.nextIndex, onRecord: async (_, i) => seen.push(i) }); assert.equal(second.status, 'completed'); assert.equal(second.nextIndex, 3); assert.deepEqual(seen, [0,1,2]); assert.equal(second.processed.length, 1); }],
    ['preabort_and_empty', async () => { const c = new AbortController(); c.abort(); let calls = 0; assert.deepEqual(await entry([row()], { signal: c.signal, onRecord: async () => calls++ }), { status: 'interrupted', nextIndex: 0, processed: [] }); assert.equal(calls, 0); assert.deepEqual(await entry([], { onRecord: async () => calls++ }), { status: 'completed', nextIndex: 0, processed: [] }); }],
    ['failed_write_is_not_retried', async () => { let calls = 0; const error = new Error('write failed'); await assert.rejects(() => entry([row()], { onRecord: async () => { calls++; throw error; } }), e => e === error); assert.equal(calls, 1); }],
    ['validate_start_and_callback', async () => { for (const start of [-1, 2]) await assert.rejects(() => entry([row()], { start, onRecord: async () => {} }), RangeError); await assert.rejects(() => entry([row()], { start: 0.5, onRecord: async () => {} }), TypeError); await assert.rejects(() => entry([row()]), TypeError); await assert.rejects(() => entry(null, { onRecord: async () => {} }), TypeError); let calls = 0; await assert.rejects(() => entry([row(' ')], { onRecord: async () => calls++ }), TypeError); assert.equal(calls, 0); assert.deepEqual(await entry([row()], { start: 1, onRecord: async () => calls++ }), { status: 'completed', nextIndex: 1, processed: [] }); assert.equal(calls, 0); }],
  ],
  T08: [
    ['new_entries', async () => assert.deepEqual(await entry([row(), row('B',' ')]), [{ label: 'A', category: 'x' }, { label: 'B', category: 'unknown' }])],
    ['legacy_export', async () => { const m = await import(pathToFileURL(join(root,'src/gateway.mjs'))); assert.deepEqual(m.listRecords([row()]), ['A']); assert.deepEqual(m.listRecords([]), []); }],
    ['updated_consumer', async () => { const m = await import(pathToFileURL(join(root,'src/consumer.mjs'))); assert.deepEqual(m.readLabels([row()]), ['A']); }],
    ['empty_and_invalid', async () => { assert.deepEqual(await entry([]), []); await assert.rejects(async () => entry(null), TypeError); await assert.rejects(async () => entry([row('')]), TypeError); }],
  ],
};

export function behaviorCheckIds(id) { return specifications[id].map(([name]) => name); }

async function execute() {
  const [id, workspace, entryPath, exportName] = process.argv.slice(2);
  assert.ok(Object.hasOwn(specifications, id));
  root = resolve(workspace);
  const results = [];
  let importError;
  try { entry = (await import(pathToFileURL(join(root, entryPath))))[exportName]; assert.equal(typeof entry, 'function'); }
  catch (error) { importError = error; }
  for (const [name, check] of specifications[id]) {
    try { if (importError) throw importError; await check(); results.push({ id: name, status: 'passed' }); }
    catch (error) { results.push({ id: name, status: 'failed', error_type: error.name }); }
  }
  process.stdout.write('SOL_EVAL_RESULT=' + JSON.stringify({ case_id: id, checks: results }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await execute();
