// Actual patched HAPI event consumer, with presentation and subprocess seams mocked.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2]);
const temp = await mkdtemp(join(tmpdir(), 'loop-pi-lifecycle-'));
const saved = {...process.env};
try {
  const mocks = {
    '@/ui/logger': 'export const logger = {debug() {}};',
    '@/agent/messageConverter': 'export const convertAgentMessage = x => x;',
    '@/agent/nativeSessionTitle': 'export const createNativeSessionTitleMetadataSync = () => () => {};',
    './piEventConverter': 'export const convertPiEvent = () => []; export const convertPiTurnUsage = () => null;',
    './piMessageAccumulator': 'export class PiMessageAccumulator { flush() {return []} handleEvent() {return []} }',
    './extensionUiHandler': 'export class PiExtensionUiHandler { cancelAll() {} }',
    '@hapi/protocol': 'export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];',
  };
  const outfile = join(temp, 'loop.mjs');
  await build({entryPoints:[join(root,'cli/src/pi/loop.ts')], outfile, bundle:true, platform:'node', format:'esm', logLevel:'silent',
    alias: {zod: resolve('node_modules/zod/index.js')},
    plugins:[{name:'presentation-fixtures',setup(b) {
      b.onResolve({filter:/.*/}, a => a.path in mocks ? {path:a.path,namespace:'fixture'} : undefined);
      b.onLoad({filter:/.*/,namespace:'fixture'}, a => ({contents:mocks[a.path]}));
    }}]});
  const managedFile = join(temp,'managed.mjs');
  await build({entryPoints:[resolve('native/loopManaged.ts')],outfile:managedFile,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
  const {wireTransportEvents} = await import(pathToFileURL(outfile));
  const {managedPiDelivery} = await import(pathToFileURL(managedFile));
  Object.assign(process.env,{LOOP_MANAGED:'1',LOOP_ENVIRONMENT_GENERATION:'2',LOOP_LAUNCH_FILE:join(temp,'launch.json')});
  await writeFile(process.env.LOOP_LAUNCH_FILE,JSON.stringify({generation:2}));
  for (const reason of ['stop','aborted','error','toolUse']) {
    const events = [];
    const delivery = managedPiDelivery(e => events.push(e));
    let emit;
    const transport = {onEvent(fn) {emit=fn}, send(command) {
      // Resolve the consumer's best-effort context probe without a timer leak.
      queueMicrotask(() => emit({type:'response',command:command.type,id:command.id,success:true,data:{}}));
    }};
    const session = {client:{},updateThinkingState() {},emitMessagesConsumed() {},sendAgentMessage() {},sendSessionEvent() {}};
    const control = wireTransportEvents(transport,session,['dispatch'],{
      onNativeOutcome:e => delivery.observe(e), onAgentLifecycleStarted:() => delivery.started(),
      onAgentSettled:() => delivery.settled(), onPromptRejected:id => delivery.rejected(id),
    });
    try {
      delivery.begin('dispatch'); control.beginPromptLifecycle('prompt');
      emit({type:'turn_start'});
      emit({type:'turn_end',message:{stopReason:'error'}});
      emit({type:'agent_end',willRetry:true});
      assert.deepEqual(events.map(e=>e.status),['running']);
      emit({type:'turn_start'});
      emit({type:'turn_end',message:{stopReason:reason,content:[{type:'text',text:'answer'}]}});
      emit({type:'agent_settled'});
      assert.equal(events.length,1,'settlement must await matching prompt response');
      emit({type:'response',command:'prompt',id:'stale',success:true});
      assert.equal(events.length,1,'stale acknowledgment cannot settle');
      emit({type:'response',command:'prompt',id:'prompt',success:true});
      assert.equal(events.length,2);
      assert.equal(events[1].status, {stop:'completed',aborted:'cancelled',error:'failed'}[reason]);
      if(reason==='toolUse') assert.equal(events[1].type,'loop-delivery-unknown');
      emit({type:'agent_settled'}); delivery.lost();
      assert.equal(events.length,2,'terminal event is emitted once');
      await new Promise(r=>setImmediate(r));
    } finally {
      control.abortPromptLifecycle(); control.terminatePendingRpc(new Error('Fixture cleanup'));
    }
  }
  console.log('PASS: patched Pi consumer preserves retry ordering, acknowledgment fencing, terminal outcomes and uncertainty');
} finally {
  for(const key of ['LOOP_MANAGED','LOOP_ENVIRONMENT_GENERATION','LOOP_LAUNCH_FILE']) {
    if(saved[key]===undefined) delete process.env[key]; else process.env[key]=saved[key];
  }
  await rm(temp,{recursive:true,force:true});
}
