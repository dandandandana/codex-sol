// Test-only generic-agent bridge. Uses the existing real STDIO MCP client; no
// inference, host installation, fake thread metadata or production implementation.
import { appendFile, readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { startMcpServer } from '../../tests/helpers/mcp-client.mjs';

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i]; const value = process.argv[i + 1];
  if (!['--workspace', '--action', '--request', '--tool', '--patch-executable', '--actor'].includes(name) || value === undefined || flags.has(name))
    throw new Error('Use --workspace <fixture> --action initialize|describe|call; call also needs --request <fixture JSON file>.');
  flags.set(name, value);
}
const action = flags.get('--action');
if (!['initialize', 'describe', 'call'].includes(action)) throw new Error('Unsupported bridge action.');
const actor = flags.get('--actor') ?? 'unspecified';
if (!['parent-preflight', 'feature-model', 'unspecified'].includes(actor)) throw new Error('Unsupported evidence actor.');
const workspaceInput = flags.get('--workspace');
if (!workspaceInput || !isAbsolute(workspaceInput)) throw new Error('Pass the absolute fixture workspace.');
const root = await realpath(workspaceInput);
const manifest = JSON.parse(await readFile(join(root, 'fixture-manifest.json'), 'utf8'));
if (manifest.kind !== 'codex-sol-ordinary-feature-fixture' || manifest.synthetic !== true) throw new Error('Only an explicitly marked synthetic feature fixture is supported.');
if (!Array.isArray(manifest.generated) || manifest.generated.some((path) => typeof path !== 'string')) throw new Error('Fixture generated exclusions must be explicit.');
let request;
if (action === 'call') {
  const requestPath = await realpath(resolve(root, flags.get('--request') ?? ''));
  const subpath = relative(root, requestPath);
  if (isAbsolute(subpath) || subpath === '..' || subpath.startsWith(`..${sep}`)) throw new Error('Request JSON must stay within the fixture.');
  const bytes = await readFile(requestPath);
  if (bytes.length > 128 * 1024) throw new Error('Request JSON exceeds 128 KiB.');
  request = JSON.parse(bytes.toString('utf8'));
  if (!request || typeof request.name !== 'string' || !request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments) || Object.keys(request).some((field) => !['name', 'arguments'].includes(field)))
    throw new Error('Request JSON must contain only name and arguments.');
}
const invocationId = randomUUID();
const client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), env: {
  CODEX_SOL_CONTEXT_RULES: join(root, 'context.json'), CODEX_SOL_GENERATED_PATHS: JSON.stringify(manifest.generated),
  CODEX_SOL_HOST_EXECUTABLE: '', CODEX_SOL_PATCH_EXECUTABLE: flags.get('--patch-executable') ?? process.env.CODEX_SOL_PATCH_EXECUTABLE ?? '',
} });
const logPath = join(root, '.codex', 'sol', 'ordinary-feature-rpc.jsonl');
const log = (value) => appendFile(logPath, JSON.stringify({ invocation_id: invocationId, actor, at: new Date().toISOString(), ...value }) + '\n');
try {
  const initialized = await client.initialize({ timeoutMs: 10000 });
  await log({ phase: 'initialize_response', response: initialized });
  if (action === 'initialize' || action === 'describe') {
    const tools = await client.request('tools/list');
    await log({ phase: 'tools_list_response', response: tools });
    if (action === 'initialize') process.stdout.write(JSON.stringify({ transport: 'real STDIO; generic-agent test bridge',
      instructions: initialized.result.instructions, tools: tools.result.tools.map((tool) => tool.name),
      usage: 'Use --action describe --tool NAME for the real schema. Use --action call --request workspace-relative JSON file containing name and arguments.' }) + '\n');
    else {
      const tool = tools.result.tools.find((item) => item.name === flags.get('--tool'));
      if (!tool) throw new Error('Tool is not advertised by this fixture server.');
      process.stdout.write(JSON.stringify(tool) + '\n');
    }
  } else {
    await log({ phase: 'tools_call_request', request });
    const response = await client.request('tools/call', request, { timeoutMs: 30000 });
    await log({ phase: 'tools_call_response', response });
    process.stdout.write(JSON.stringify(response) + '\n');
    if (response.error || response.result?.isError) process.exitCode = 1;
  }
  if (client.protocolErrors.length) throw new Error('Invalid MCP protocol output was observed.');
} catch (error) {
  // A timed-out write may have effects; callers must inspect state, never replay.
  process.stderr.write(`${error.message}\nDo not replay a write automatically; inspect the persisted change state.\n`);
  process.exitCode = 1;
} finally { await client.close(); }
