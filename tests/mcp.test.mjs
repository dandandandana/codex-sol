import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

test('stdio MCP tools apply, validate, pack and recall through the wire', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sol-mcp-'));
  const config = join(root, 'rules.json');
  await writeFile(config, JSON.stringify({ schema_version: 1, rules: [{ schema_version: 1, id: 'txt', globs: ['**/*.txt'], watch_paths: ['**/*'], commands: [{ id: 'pass', argv: [process.execPath, '-e', 'process.exit(0)'], cwd: '.', timeout_ms: 5000 }] }] }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], { cwd: root, env: { ...process.env, CODEX_SOL_WORKSPACE: root, CODEX_SOL_RULES: config }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve } = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });
  let id = 0;
  const rpc = (method, params = {}) => new Promise((resolve) => {
    const next = ++id;
    pending.set(next, { resolve });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
  });
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-sol-test', version: '0.1.0' } });
    assert.ok(initialized.result, `MCP initialization failed: ${JSON.stringify(initialized)} ${stderr}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await rpc('tools/list');
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), ['sol_apply_changes', 'sol_apply_patch', 'sol_read_file', 'sol_recall']);
    const applied = await rpc('tools/call', { name: 'sol_apply_changes', arguments: { changes: [{ action: 'write', path: 'hello.txt', content: 'hello\n' }] } });
    const appliedValue = JSON.parse(applied.result.content[0].text);
    assert.equal(appliedValue.tool_status, 'ok');
    assert.equal(appliedValue.validation.status, 'passed');
    assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'hello\n');
    const unchanged = await rpc('tools/call', { name: 'sol_apply_changes', arguments: { changes: [{ action: 'write', path: 'hello.txt', content: 'hello\n' }] } });
    assert.deepEqual(JSON.parse(unchanged.result.content[0].text).changed_paths, []);
    assert.equal(JSON.parse(unchanged.result.content[0].text).validation, null);
    const multiple = await rpc('tools/call', { name: 'sol_apply_changes', arguments: { changes: [{ action: 'write', path: 'one.txt', content: 'one' }, { action: 'write', path: 'two.txt', content: 'two' }] } });
    assert.deepEqual(JSON.parse(multiple.result.content[0].text).changed_paths, ['one.txt', 'two.txt']);
    assert.equal(JSON.parse(multiple.result.content[0].text).validation.status, 'passed');
    const deleted = await rpc('tools/call', { name: 'sol_apply_changes', arguments: { changes: [{ action: 'delete', path: 'two.txt' }] } });
    assert.deepEqual(JSON.parse(deleted.result.content[0].text).changed_paths, ['two.txt']);
    assert.equal(JSON.parse(deleted.result.content[0].text).validation.status, 'passed');
    const partial = await rpc('tools/call', { name: 'sol_apply_changes', arguments: { changes: [{ action: 'write', path: 'partial.txt', content: 'kept' }, { action: 'delete', path: 'absent.txt' }] } });
    const partialValue = JSON.parse(partial.result.content[0].text);
    assert.equal(partialValue.tool_status, 'error');
    assert.deepEqual(partialValue.changed_paths, ['partial.txt']);
    assert.equal(partialValue.validation.status, 'passed');
    assert.equal(await readFile(join(root, 'partial.txt'), 'utf8'), 'kept');
    const read = await rpc('tools/call', { name: 'sol_read_file', arguments: { path: 'hello.txt' } });
    const readValue = JSON.parse(read.result.content[0].text);
    assert.equal(readValue.observation.mode, 'inline');
    assert.equal(readValue.text, 'hello\n');
    const handle = readValue.observation.raw[0].handle;
    const recalled = await rpc('tools/call', { name: 'sol_recall', arguments: { handle, selector: { kind: 'bytes', start: 0, end: 6 } } });
    assert.equal(Buffer.from(JSON.parse(recalled.result.content[0].text).chunks[0].base64, 'base64').toString(), 'hello\n');
    await writeFile(join(root, 'large.txt'), 'a'.repeat(20000));
    const large = await rpc('tools/call', { name: 'sol_read_file', arguments: { path: 'large.txt' } });
    const packed = JSON.parse(large.result.content[0].text);
    assert.equal(packed.mode, 'packed');
    assert.ok(Buffer.byteLength(large.result.content[0].text) <= 4096);
    assert.ok(packed.omitted_bytes > 0);
    const exact = await rpc('tools/call', { name: 'sol_recall', arguments: { handle: packed.raw[0].handle, selector: { kind: 'bytes', start: 100, end: 110 } } });
    assert.equal(Buffer.from(JSON.parse(exact.result.content[0].text).chunks[0].base64, 'base64').toString(), 'a'.repeat(10));
  } finally {
    child.stdin.end();
    child.kill();
    lines.close();
  }
});
