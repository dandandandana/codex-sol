import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArchitectureDeclaration } from '../src/architecture/index.mjs';

function declaration() {
  return {
    schema_version: 1,
    modules: [{
      uid: '00000001',
      id: 'demo',
      parent: null,
      name: { zh: '演示', en: 'Demo' },
      description: { zh: '演示模块', en: 'Demo module' },
      source: [{ path: 'missing/source.mjs' }],
      revision: 'a'.repeat(40),
      updated_at: '2026-10-10T00:00:00Z',
      fingerprint: 'b'.repeat(64),
    }],
    policy: { schema_version: 1, updated_at: '2026-10-10T00:00:00Z', rules: [] },
  };
}

function assertFault(input, code, diagnosticCode) {
  assert.throws(() => validateArchitectureDeclaration(input), (error) => {
    assert.equal(error.code, code);
    if (diagnosticCode) assert.ok(error.diagnostics.some((item) => item.code === diagnosticCode));
    return true;
  });
}

test('architecture declaration validator is synchronous, returns Normify-validated config, and does not read sources', () => {
  const input = declaration();
  const original = JSON.stringify(input);
  const validated = validateArchitectureDeclaration(input);

  assert.equal(validated instanceof Promise, false);
  assert.notEqual(validated, input);
  assert.notEqual(validated.modules, input.modules);
  assert.deepEqual(validated, input);
  assert.equal(JSON.stringify(input), original);
  // This intentionally missing path remains acceptable at declaration-validation level.
  assert.equal(validated.modules[0].source[0].path, 'missing/source.mjs');
});

test('architecture declaration validation preserves strict-root and Normify module/policy errors', () => {
  const unknownRootField = declaration();
  unknownRootField.extra = true;
  assertFault(unknownRootField, 'ARCHITECTURE_CONFIG');

  const invalidModule = declaration();
  invalidModule.modules[0].parent = 'elsewhere';
  assertFault(invalidModule, 'ARCHITECTURE_CONFIG', 'structure/parent-mismatch');

  const invalidPolicy = declaration();
  invalidPolicy.policy.rules = [{ id: 'bad-rule', type: 'naming', pattern: '[' }];
  assertFault(invalidPolicy, 'ARCHITECTURE_CONFIG', 'policy/rule-pattern-invalid');
});

test('declaration validation does not turn locally valid records into a graph-readiness claim', () => {
  const input = declaration();
  input.modules.push({ ...input.modules[0], id: 'demo.child', parent: 'demo' });

  const validated = validateArchitectureDeclaration(input);
  assert.equal(validated.modules.length, 2);
  assert.equal(validated.modules[0].uid, validated.modules[1].uid);
});

test('architecture declaration validation rejects nested and module limits before any compile or source access', () => {
  const tooDeep = declaration();
  let nested = null;
  for (let index = 0; index < 24; index += 1) nested = { child: nested };
  tooDeep.modules[0].extra = nested;
  assertFault(tooDeep, 'ARCHITECTURE_LIMIT');

  const tooComplex = declaration();
  tooComplex.modules[0].extra = Array(20001).fill(null);
  assertFault(tooComplex, 'ARCHITECTURE_LIMIT');

  const tooManySources = declaration();
  tooManySources.modules[0].source = Array.from({ length: 33 }, (_, index) => ({ path: `missing/${index}.mjs` }));
  assertFault(tooManySources, 'ARCHITECTURE_LIMIT');
});
