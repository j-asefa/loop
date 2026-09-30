// Exercise the actual patched transport without a native process or inference.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = await mkdtemp(join(tmpdir(), 'loop-pi-transport-'));
const saved = process.env.LOOP_MANAGED;
try {
  const outfile = join(temp, 'transport.mjs');
  await build({
    entryPoints: [resolve(process.argv[2], 'cli/src/pi/piTransport.ts')],
    outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'transport-fixtures', setup(b) {
      const mocks = {
        'node:child_process': 'export const spawn = () => globalThis.__loopPiChild;',
        '@/ui/logger': 'export const logger = { debug() {}, warn() {} };',
        '@/utils/jsonLineParser': 'export class JsonLineParser { feed() {} }',
        './schemas': 'export const PiAgentEventSchema = { safeParse: () => ({ success: false }) };',
      };
      b.onResolve({filter: /^(node:child_process|@\/ui\/logger|@\/utils\/jsonLineParser|\.\/schemas)$/},
        args => ({path: args.path, namespace: 'fixture'}));
      b.onLoad({filter: /.*/, namespace: 'fixture'}, args => ({contents: mocks[args.path]}));
    }}],
  });
  const { PiTransport } = await import(pathToFileURL(outfile).href);
  for (const mode of ['unstarted', 'closed', 'callback', 'throw', 'stream', 'healthy']) {
    process.env.LOOP_MANAGED = '1';
    const child = new EventEmitter();
    for (const key of ['stdin', 'stdout', 'stderr']) {
      child[key] = new EventEmitter();
      child[key].setEncoding = () => {};
    }
    child.stdin.write = (_message, callback) => {
      if (mode === 'throw') throw Object.assign(new Error('private native detail'), {code: 'EPIPE'});
      if (mode === 'callback') callback(new Error('private native detail'));
      return true;
    };
    globalThis.__loopPiChild = child;
    const transport = new PiTransport({command: '/fixture/pi', args: [], cwd: temp});
    const errors = [];
    transport.onError(error => errors.push(error.message));
    if (mode !== 'unstarted') transport.start();
    if (mode === 'closed') child.emit('close', 1, null);
    if (mode === 'stream') child.stdin.emit('error', new Error('private native detail'));
    transport.send({type: 'prompt', message: 'fixture'});
    transport.send({type: 'prompt', message: 'fixture'});
    assert.deepEqual(errors, mode === 'healthy' ? [] : ['Managed Pi transport delivery is uncertain']);
  }
  for (const ready of [true, false, 'closed', 'missing']) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const pipe = new PassThrough();
    child.stdio = [child.stdin, child.stdout, child.stderr, ready === 'missing' ? null : pipe];
    let killed = false;
    child.kill = () => { killed = true; };
    globalThis.__loopPiChild = child;
    const transport = new PiTransport({command: '/fixture/pi', args: [], cwd: temp, managedTools: true});
    const errors = [];
    transport.onError(error => errors.push(error.message));
    transport.start();
    if (ready === 'closed') pipe.end();
    else if (ready !== 'missing') pipe.write(JSON.stringify({type: 'loop-mcp-ready', ready}) + '\n');
    if (ready === true) {
      await transport.waitForTools();
      assert.equal(killed, false);
      assert.deepEqual(errors, []);
    } else {
      await assert.rejects(transport.waitForTools(), /workspace tools/);
      assert.equal(killed, true);
      assert.deepEqual(errors, ['Managed Pi workspace tools failed to initialize']);
    }
    for (const stream of child.stdio) stream?.destroy();
  }
  process.env.LOOP_MANAGED = '0';
  const standalone = new PiTransport({command: '/fixture/pi', args: [], cwd: temp});
  standalone.onError(() => assert.fail('Standalone behavior changed'));
  standalone.send({type: 'prompt', message: 'fixture'});
  console.log('PASS: managed unavailable, closed, async/sync failed writes and stdin errors notify once; healthy and standalone preserved');
} finally {
  delete globalThis.__loopPiChild;
  if (saved === undefined) delete process.env.LOOP_MANAGED;
  else process.env.LOOP_MANAGED = saved;
  await rm(temp, {recursive: true, force: true});
}
