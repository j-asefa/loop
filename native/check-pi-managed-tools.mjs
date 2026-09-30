// Actual Pi extension loading and private readiness; no model prompt or credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (!process.argv[2]) throw new Error('Provide the pinned Pi executable');
const root = await mkdtemp(join(tmpdir(), 'loop-pi-tools-'));
let catalogRequests = 0;
let rejectAuth = false;
const server = createServer(async (req, res) => {
  if (rejectAuth || req.headers.authorization !== 'Bearer fixture-only-token') {
    res.writeHead(403).end(); return;
  }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  if (request.id === undefined) { res.writeHead(202).end(); return; }
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: '2024-11-05', capabilities: { tools: {} },
    serverInfo: { name: 'fixture', version: '1' },
  };
  else if (request.method === 'tools/list') {
    catalogRequests++;
    result = { tools: [{ name: 'fixture_workspace_tool', description: 'Fixture', inputSchema: { type: 'object', properties: {} } }] };
  } else throw new Error('Unexpected MCP request; fixture must not execute tools');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
});
try {
  let extension = process.argv[3];
  if (!extension) {
    const { buildNativeAuth } = await import('../scripts/build-native-auth.mjs');
    await buildNativeAuth(join(root, 'bundle'));
    extension = join(root, 'bundle/pi-managed-extension.mjs');
  }
  extension = resolve(extension);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const launchId = '11111111-1111-4111-8111-111111111111';
  const launchFile = join(root, 'launch.json');
  await writeFile(launchFile, JSON.stringify({
    launchId, generation: 1, flavor: 'pi',
    billing: { mode: 'existing', requiredAuth: 'pi', allowApiFallback: false },
    gatewayUrl: `http://127.0.0.1:${server.address().port}/mcp`, gatewayToken: 'fixture-only-token',
  }), { mode: 0o600 });
  for (const expected of [true, false]) {
    rejectAuth = !expected;
    const child = spawn(resolve(process.argv[2]), [
      '--mode', 'rpc', '--no-session', '--no-extensions', '--extension', extension,
    ], { cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'),
      LOOP_LAUNCH_FILE: launchFile, LOOP_LAUNCH_ID: launchId, LOOP_ENVIRONMENT_GENERATION: '1',
    }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    child.stdout.resume(); child.stderr.resume();
    try {
      const handshake = await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error('Native extension readiness timed out')), 30000);
        let data = '';
        child.stdio[3].on('data', chunk => {
          data += chunk;
          if (data.includes('\n')) { clearTimeout(timer); accept(JSON.parse(data.split('\n')[0])); }
        });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Native Pi exited before readiness')); });
      });
      assert.deepEqual(handshake, { type: 'loop-mcp-ready', ready: expected });
    } finally {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(force);
    }
  }
  assert.equal(catalogRequests, 1);
  console.log(JSON.stringify({ nativePiExtension: 'passed', authenticatedCatalog: 'passed', rejectedAuthentication: 'passed', inference: 'not_run' }));
} finally {
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  await rm(root, { recursive: true, force: true });
}
