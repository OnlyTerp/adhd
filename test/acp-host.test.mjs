import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AcpHost, ACP_PROFILES, acpEnvironment, stripFence} from '../native/acp.mjs';

const fake = fileURLToPath(new URL('./fake-acp.mjs', import.meta.url));
const swe = {backend: 'devin', modelId: 'swe-2', speedId: 'standard', reasoning: 'default'};
const cwd = path.join(process.env.GOAL_LOOP_TEST_TMP || tmpdir(), 'acp-cwd'); mkdirSync(cwd, {recursive: true});
const newHost = (env = {}) => new AcpHost({commands: {devin: {command: process.execPath, args: [fake]}}, env: {...process.env, CLAUDECODE: '1', ...env}, cwd});
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function setupHost(t, env) {
  const host = await newHost(env).initialize(), events = [], forbidden = [];
  host.on('notification', m => events.push(m)); host.on('forbiddenRequest', m => forbidden.push(m));
  t.after(() => host.close());
  const waitDone = async turn => {
    for (let n = 0; n < 500; n++) {
      const done = events.find(e => e.method === 'turn/completed' && e.params.turn.id === turn.id);
      if (done) return {turn, done: done.params.turn, items: events.filter(e => e.params.turnId === turn.id)};
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('turn did not complete');
  };
  const run = async (threadId, text, outputSchema) => waitDone((await host.request('turn/start', {threadId, input: [{type: 'text', text}], ...(outputSchema ? {outputSchema} : {})})).turn);
  return {host, events, forbidden, run, waitDone};
}

test('profile, catalog, validation and receipt follow the backend contract', async t => {
  const {host} = await setupHost(t);
  assert.deepEqual(ACP_PROFILES.map(p => p.id), ['devin']);
  assert.deepEqual(ACP_PROFILES[0].args('swe-2'), ['acp', '--agent-type', 'summarizer', '--model', 'swe-2']);
  assert.equal(host.backend, 'devin');
  const c = host.catalog();
  assert.equal(c.backend, 'devin');
  assert.deepEqual(c.capabilities, {toolFree: 'detected', usageMeter: 'tokens', billing: 'free', structuredOutput: 'prompted', compaction: 'unknown'});
  assert.deepEqual(c.models, [{id: 'swe-2', label: 'SWE-2', efforts: ['default'], speeds: [{id: 'standard', label: 'Standard'}]}, {id: 'swe-2-flash', label: 'SWE-2 Flash', efforts: ['default'], speeds: [{id: 'standard', label: 'Standard'}]}]);
  host.validate(swe);
  assert.throws(() => host.validate({...swe, backend: 'claude'}), /not devin/);
  assert.throws(() => host.validate({modelId: 'swe-2', speedId: 'standard', reasoning: 'default'}), /not devin/);
  assert.throws(() => host.validate({...swe, modelId: 'gpt-6'}), /not offered/);
  assert.throws(() => host.validate({...swe, reasoning: 'max'}), /default/);
  assert.throws(() => host.validate({...swe, speedId: 'priority'}), /speed/);
  const r = await host.thread(swe, 'Be brief.');
  assert.deepEqual(Object.keys(r).sort(), ['attestation', 'environmentAccess', 'model', 'modelProvider', 'reasoningEffort', 'serviceTier', 'threadId']);
  assert.equal(r.model, 'swe-2'); assert.equal(r.modelProvider, 'devin'); assert.equal(r.reasoningEffort, 'default'); assert.equal(r.environmentAccess, false);
  assert.match(r.attestation, /requested, not attested/);
  assert.ok(!('CLAUDECODE' in acpEnvironment({CLAUDECODE: '1', PATH: 'p'})));
  assert.equal(stripFence('```json\n{"a":1}\n```'), '{"a":1}');
});

test('two turns share one session; instructions lead only the first prompt', async t => {
  const {host, run} = await setupHost(t);
  const a = await host.thread(swe, 'SYSTEM-RULES', cwd);
  const one = await run(a.threadId, 'first question [echo]');
  assert.equal(one.done.status, 'completed');
  const h1 = JSON.parse(one.items.find(e => e.method === 'item/completed').params.item.text);
  assert.deepEqual(h1.history, ['<instructions>\nSYSTEM-RULES\n</instructions>\n\nfirst question [echo]']);
  assert.equal(h1.cwd, cwd); assert.equal(h1.model, 'swe-2');
  const two = await run(a.threadId, 'second question [echo]');
  const h2 = JSON.parse(two.items.find(e => e.method === 'item/completed').params.item.text);
  assert.deepEqual(h2.history, [h1.history[0], 'second question [echo]']);
  // Separate threads are separate processes and sessions.
  const b = await host.thread({...swe, modelId: 'swe-2-flash'}, 'OTHER');
  const hb = JSON.parse((await run(b.threadId, '[echo]')).items.find(e => e.method === 'item/completed').params.item.text);
  assert.equal(hb.history.length, 1); assert.equal(hb.model, 'swe-2-flash');
});

test('text streams as deltas, blocks complete per message, usage precedes turn end, thoughts and vendor noise hidden', async t => {
  const {host, run} = await setupHost(t);
  const a = await host.thread(swe, 'x');
  const r = await run(a.threadId, 'go');
  assert.equal(r.done.status, 'completed');
  const methods = r.items.map(e => e.method);
  assert.equal(methods.at(-1), 'turn/completed'); assert.equal(methods.at(-2), 'thread/tokenUsage/updated');
  assert.equal(methods.filter(m => m === 'turn/completed').length, 1);
  const completed = r.items.filter(e => e.method === 'item/completed').map(e => e.params.item);
  assert.deepEqual(completed.map(i => i.text), ['Finding café 🧪 one', 'Second block']);
  assert.ok(completed.every(i => i.type === 'agentMessage')); assert.notEqual(completed[0].id, completed[1].id);
  for (const item of completed) assert.equal(r.items.filter(e => e.method === 'item/agentMessage/delta' && e.params.itemId === item.id).map(e => e.params.delta).join(''), item.text);
  assert.ok(methods.lastIndexOf('item/agentMessage/delta') < methods.indexOf('item/completed'));
  assert.deepEqual(r.items.find(e => e.method === 'thread/tokenUsage/updated').params.tokenUsage.last, {inputTokens: 21, cachedInputTokens: 15, cacheWriteInputTokens: 4, outputTokens: 9, reasoningOutputTokens: 0});
  const all = JSON.stringify(r.items);
  assert.ok(!all.includes('SECRET-THOUGHT')); assert.ok(!all.includes('VENDOR-NOISE'));
});

test('structured output: fenced and plain JSON publish the object, prose fails', async t => {
  const {host, run} = await setupHost(t);
  const schema = {type: 'object', properties: {answer: {type: 'string'}}, required: ['answer'], additionalProperties: false};
  const a = await host.thread(swe, 'tracker', undefined, {outputSchema: schema});
  const r = await run(a.threadId, 'q [json]', schema);
  assert.equal(r.done.status, 'completed');
  const items = r.items.filter(e => e.method === 'item/completed');
  assert.equal(items.length, 1); assert.equal(items[0].params.item.text, '{"answer":"forty-two"}');
  assert.ok(!r.items.some(e => e.method === 'item/agentMessage/delta'));
  assert.equal((await run(a.threadId, '[plainjson]', schema)).items.find(e => e.method === 'item/completed').params.item.text, '{"answer":"plain"}');
  const bad = await run(a.threadId, '[badjson]', schema);
  assert.equal(bad.done.status, 'failed'); assert.match(bad.done.error.message, /^ACP agent returned no valid JSON: "Sure/);
  assert.ok(!bad.items.some(e => e.method === 'item/completed'));
  await assert.rejects(host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: 'x'}]}), /fixes its output schema/);
});

test('the schema line is appended to every structured prompt', async t => {
  const {host, run} = await setupHost(t);
  const schema = {type: 'object'};
  const a = await host.thread(swe, 'tracker', undefined, {outputSchema: schema});
  await run(a.threadId, '[badjson]', schema);
  const r = await run(a.threadId, 'again [echo]', schema);
  // [echo] returns a JSON object, so it is published as the structured answer.
  const h = JSON.parse(r.items.find(e => e.method === 'item/completed').params.item.text).history;
  assert.equal(h.length, 2); assert.match(h[0], /^<instructions>\ntracker\n<\/instructions>/);
  for (const p of h) assert.ok(p.endsWith('Reply with only one JSON object matching this JSON Schema, no prose and no code fence:{"type":"object"}'));
  assert.ok(!h[1].includes('<instructions>'));
});

test('a tool_call update is a boundary crossing and fails the turn; the thread keeps working', async t => {
  const {host, run, forbidden} = await setupHost(t);
  const a = await host.thread(swe, 'x');
  const r = await run(a.threadId, '[tool]');
  assert.equal(r.done.status, 'failed'); assert.match(r.done.error.message, /tool_call/);
  assert.equal(forbidden.length, 1); assert.match(forbidden[0].method, /^tool_call/); assert.equal(forbidden[0].threadId, a.threadId);
  assert.equal((await run(a.threadId, 'next')).done.status, 'completed');
});

test('permission requests are answered cancelled, other requests get an error; both fail the turn', async t => {
  const {host, run, forbidden} = await setupHost(t);
  const a = await host.thread(swe, 'x');
  const r = await run(a.threadId, '[perm]');
  assert.equal(r.done.status, 'failed'); assert.match(r.done.error.message, /session\/request_permission/);
  assert.deepEqual(forbidden.map(f => f.method), ['session/request_permission']);
  const reply = await run(a.threadId, '[lastreply]');
  assert.deepEqual(JSON.parse(reply.items.find(e => e.method === 'item/completed').params.item.text), {outcome: {outcome: 'cancelled'}});
  const fs = await run(a.threadId, '[fsread]');
  assert.equal(fs.done.status, 'failed'); assert.match(fs.done.error.message, /fs\/read_text_file/);
  const reply2 = JSON.parse((await run(a.threadId, '[lastreply]')).items.find(e => e.method === 'item/completed').params.item.text);
  assert.equal(reply2.error.code, -32601);
});

test('interrupt sends session/cancel and ends the turn interrupted; the thread keeps working', async t => {
  const {host, run, events, waitDone} = await setupHost(t);
  const a = await host.thread(swe, 'x');
  const {turn} = await host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: '[slow]'}]});
  await assert.rejects(host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: 'x'}]}), /Concurrent/);
  for (let n = 0; n < 200 && !events.some(e => e.method === 'item/agentMessage/delta' && e.params.turnId === turn.id); n++) await new Promise(r => setTimeout(r, 10));
  await host.request('turn/interrupt', {threadId: a.threadId, turnId: turn.id});
  assert.equal((await waitDone(turn)).done.status, 'interrupted');
  assert.equal((await run(a.threadId, 'after')).done.status, 'completed');
});

test('other stop reasons and JSON-RPC errors fail the turn', async t => {
  const {host, run} = await setupHost(t);
  const a = await host.thread(swe, 'x');
  const r = await run(a.threadId, '[refuse]');
  assert.equal(r.done.status, 'failed'); assert.match(r.done.error.message, /refusal/);
  const e = await run(a.threadId, '[rpcerror]');
  assert.equal(e.done.status, 'failed'); assert.match(e.done.error.message, /model overloaded/);
});

test('a crashed agent fails only its own thread', async t => {
  const {host, run} = await setupHost(t);
  const a = await host.thread(swe, 'x'), b = await host.thread(swe, 'y');
  const died = await run(a.threadId, '[die]');
  assert.equal(died.done.status, 'failed'); assert.match(died.done.error.message, /exited \(3\)/);
  await assert.rejects(host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: 'x'}]}), /closed/);
  assert.equal((await run(b.threadId, 'fine')).done.status, 'completed');
});

test('startup failure throws with the last stderr line and leaves no process', async t => {
  const {host} = await setupHost(t, {FAKE_ACP_FAIL_INIT: '1'});
  await assert.rejects(host.thread(swe, 'x'), /failed to start.*not logged in/);
  assert.equal(host.threads.size, 0);
});

test('close() ends stubborn agents by kill and confirms', async t => {
  const host = await newHost({FAKE_ACP_STUBBORN: '1'}).initialize();
  const a = await host.thread(swe, 'x'), b = await host.thread(swe, 'y');
  const pids = [...host.threads.values()].map(th => th.proc.pid);
  assert.equal(pids.length, 2); assert.ok(pids.every(alive));
  assert.ok(a.threadId && b.threadId);
  const started = Date.now();
  assert.deepEqual(await host.close(), {confirmed: true});
  assert.ok(Date.now() - started < 7000);
  assert.ok(pids.every(p => !alive(p)));
  await assert.rejects(host.thread(swe, 'x'), /closed/);
});

test('release() ends one thread without failing a turn event', async t => {
  const {host, events} = await setupHost(t);
  const a = await host.thread(swe, 'x');
  const pid = host.threads.get(a.threadId).proc.pid;
  await host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: '[slow]'}]});
  await host.release(a.threadId);
  assert.ok(!alive(pid));
  assert.ok(!events.some(e => e.method === 'turn/completed'));
  await assert.rejects(host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: 'x'}]}), /Unknown ACP thread/);
});
