import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedPiDelivery } from '../native/loopManaged';
test('Pi delivery retains identity through loss and never replays or duplicates uncertainty', () => {
  const saved = {...process.env};
  const dir = mkdtempSync(join(tmpdir(), 'pi-delivery-'));
  try {
    process.env.LOOP_MANAGED = '1';
    process.env.LOOP_ENVIRONMENT_GENERATION = '2';
    process.env.LOOP_LAUNCH_FILE = join(dir, 'binding.json');
    writeFileSync(process.env.LOOP_LAUNCH_FILE, JSON.stringify({generation: 2}));
    const events: any[] = [];
    const delivery = managedPiDelivery((event, key) => events.push({event, key}));
    delivery.lost();
    assert.throws(() => delivery.begin(), /identity/);
    delivery.begin('dispatch-a');
    assert.throws(() => delivery.begin('dispatch-b'), /unresolved/);
    delivery.lost(); delivery.lost();
    assert.deepEqual(events, [{event: {type:'loop-delivery-unknown', localId:'dispatch-a'}, key:'loop-pi-unknown:dispatch-a'}]);
    delivery.begin('dispatch-b'); delivery.rejected('dispatch-b'); delivery.lost();
    events.pop();
    assert.equal(events.length, 1);
    delivery.begin('dispatch-c');
    delivery.started(); delivery.started();
    delivery.rejected('stale-dispatch');
    assert.throws(() => delivery.begin('dispatch-d'), /unresolved/);
    delivery.rejected('dispatch-c'); delivery.rejected('dispatch-c'); delivery.lost();
    assert.deepEqual(events.slice(1), [
      {event: {type: 'loop-turn', localId: 'dispatch-c', status: 'running'}, key: 'loop-pi-running:dispatch-c'},
      {event: {type: 'loop-turn', localId: 'dispatch-c', status: 'failed', output: 'Native Pi rejected the prompt'}, key: 'loop-pi-failed:dispatch-c'},
    ]);
    delivery.begin('dispatch-d'); delivery.rejected();
    assert.deepEqual(events.at(-1), {event: {type: 'loop-turn', localId: 'dispatch-d', status: 'failed', output: 'Native Pi rejected the prompt'}, key: 'loop-pi-failed:dispatch-d'});
    writeFileSync(process.env.LOOP_LAUNCH_FILE, JSON.stringify({generation: 3}));
    assert.throws(() => delivery.begin('fenced'), /Fenced/);
    delivery.lost(); assert.equal(events.length, 4);
    process.env.LOOP_MANAGED = '0';
    delivery.begin(); delivery.lost(); assert.equal(events.length, 4);
  } finally {
    for (const key of ['LOOP_MANAGED','LOOP_ENVIRONMENT_GENERATION','LOOP_LAUNCH_FILE']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    rmSync(dir, {recursive:true, force:true});
  }
});

test('Pi settlement uses the final native outcome and never invents success', () => {
  const saved = {...process.env};
  const dir = mkdtempSync(join(tmpdir(), 'pi-settlement-'));
  try {
    process.env.LOOP_MANAGED = '1';
    process.env.LOOP_ENVIRONMENT_GENERATION = '2';
    process.env.LOOP_LAUNCH_FILE = join(dir, 'binding.json');
    writeFileSync(process.env.LOOP_LAUNCH_FILE, JSON.stringify({generation: 2}));
    const events: any[] = [];
    const delivery = managedPiDelivery((event) => events.push(event));
    for (const [reason, expected] of [['stop', 'completed'], ['aborted', 'cancelled'], ['error', 'failed'], ['length', 'failed'], ['toolUse', undefined], [undefined, undefined]]) {
      delivery.begin('dispatch');
      delivery.observe({type: 'turn_end', message: {stopReason: reason, content: [{type:'text', text:'answer'}], errorMessage:'private error'}});
      assert.equal(delivery.settled(), Boolean(expected)); delivery.settled(); delivery.lost();
      const event = events.pop();
      assert.equal(event.type, expected ? 'loop-turn' : 'loop-delivery-unknown');
      assert.equal(event.status, expected);
      assert.ok(!JSON.stringify(event).includes('private error'));
      assert.equal(events.length, 0);
    }
    delivery.begin('retry');
    delivery.observe({type:'turn_end', message:{stopReason:'error'}});
    delivery.observe({type:'turn_end', message:{stopReason:'stop', content:[{type:'text',text:'recovered'}]}});
    assert.equal(events.length, 0);
    delivery.settled();
    assert.equal(events[0].status, 'completed');
    assert.equal(events[0].output, 'recovered');
  } finally {
    for (const key of ['LOOP_MANAGED','LOOP_ENVIRONMENT_GENERATION','LOOP_LAUNCH_FILE']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    rmSync(dir, {recursive:true, force:true});
  }
});
