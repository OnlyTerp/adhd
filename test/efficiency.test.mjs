import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../native/store.mjs';
import {Runtime} from '../native/runtime.mjs';

const tick = () => new Promise(r => setImmediate(r));
const feedback = (n = 0) => ({findings: [], questions: [], nextDirections: ['direction ' + n]});

function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(process.env.GOAL_LOOP_TEST_TMP || tmpdir(), 'loop-efficiency-')), store = new Store(dir), hosts = [];
  class Host extends EventEmitter {
    constructor() { super(); this.threads = []; this.turns = []; this.closed = false; hosts.push(this); }
    async initialize() { this.account = {type: 'chatgpt'}; }
    validate() {}
    async catalog() { return {verified: true}; }
    async thread(choice) { const a = {threadId: 't' + this.threads.length, model: choice.modelId, modelProvider: 'openai', serviceTier: choice.speedId, reasoningEffort: 'max'}; this.threads.push(a); return a; }
    async request(method, p) {
      if (method === 'turn/interrupt') { const turn = this.turns.find(x => x.id === p.turnId); if (turn && !turn.done) this.complete(turn, null, 'interrupted'); return {}; }
      assert.equal(method, 'turn/start');
      const turn = {id: 'turn-' + this.turns.length, p, tracker: p.model === 'gpt-6.1-terra', done: false}; this.turns.push(turn);
      return {turn: {id: turn.id, status: 'inProgress'}};
    }
    complete(turn, text, status = 'completed', usage) {
      turn.done = true;
      if (text !== null) this.emit('notification', {method: 'item/completed', params: {threadId: turn.p.threadId, turnId: turn.id, item: {type: 'agentMessage', id: turn.id, text, phase: 'final_answer'}}});
      if (usage) this.emit('notification', {method: 'thread/tokenUsage/updated', params: {threadId: turn.p.threadId, turnId: turn.id, tokenUsage: {last: usage, total: usage}}});
      this.emit('notification', {method: 'turn/completed', params: {threadId: turn.p.threadId, turn: {id: turn.id, status}}});
    }
    async close() { this.closed = true; this.emit('disconnect', new Error('owned host closed')); return {confirmed: true}; }
  }
  if (options.rateLimits) Host.prototype.rateLimits = async function () { return options.rateLimits(); };
  const runtime = new Runtime(store, {clientFactory: () => new Host()});
  const id = store.prepare({goal: 'Investigate the widget count.', context: 'Initial estimate is 7.', requestId: 'start'});
  t.after(async () => { await runtime.close(); store.close(); rmSync(dir, {recursive: true, force: true}); });
  const until = async predicate => { for (let n = 0; n < 200; n++) { const x = predicate(); if (x) return x; await tick(); } throw new Error('Expected event did not occur'); };
  const turn = (tracker, index = 0) => until(() => hosts.at(-1)?.turns.filter(x => x.tracker === tracker)[index]);
  const publish = (turn, body = 'Useful finding', usage) => hosts.at(-1).complete(turn, body + '\n<!-- loop:continue -->', 'completed', usage);
  const record = (turn, ledger = feedback(), markdown = '## Notes\n\nOrganized.') => hosts.at(-1).complete(turn, JSON.stringify({markdown, feedback: ledger}));
  const text = turn => turn.p.input[0].text;
  const audit = type => store.db.prepare('SELECT data FROM audit WHERE session_id=? AND type=? ORDER BY sequence').all(id, type).map(r => JSON.parse(r.data));
  return {store, runtime, id, hosts, until, turn, publish, record, text, audit};
}

test('thinker gets the ledger only when it changed, and the context again after compaction', async t => {
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 5, maxMinutes: 1});
  s.publish(await s.turn(false, 0));
  const round2 = await s.turn(false, 1);
  assert.match(s.text(round2), /No new evidence or tracker feedback since your last round/);
  assert.doesNotMatch(s.text(round2), /Latest committed evidence/);
  s.record(await s.turn(true, 0), feedback(1)); await s.until(() => s.store.latest(s.id));
  s.publish(round2);
  const round3 = await s.turn(false, 2);
  assert.match(s.text(round3), /Latest committed evidence and tracker feedback/);
  assert.match(s.text(round3), /direction 1/);
  assert.doesNotMatch(s.text(round3), /Initial estimate is 7/);
  // Codex compacts the thinker's history during round 3: round 4 restates the reference context once.
  s.hosts.at(-1).emit('notification', {method: 'item/completed', params: {threadId: round3.p.threadId, turnId: round3.id, item: {type: 'contextCompaction', id: 'c1'}}});
  s.publish(round3);
  const round4 = await s.turn(false, 3);
  assert.match(s.text(round4), /restated because earlier history was compacted/);
  assert.match(s.text(round4), /Initial estimate is 7/);
  s.publish(round4);
  const round5 = await s.turn(false, 4);
  assert.doesNotMatch(s.text(round5), /Initial estimate is 7/);
  assert.equal(s.audit('compaction').length, 1);
});

test('a primed tracker gets only the new batch, and its prompt stays small as sources grow', async t => {
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 40, maxMinutes: 1});
  const trackerPrompts = [];
  for (let round = 0; round < 40; round++) {
    s.publish(await s.turn(false, round), 'Finding ' + round + ' ' + 'x'.repeat(200));
    const pending = s.hosts.at(-1).turns.find(x => x.tracker && !x.done);
    if (pending) { trackerPrompts.push(s.text(pending)); s.record(pending, feedback(round), '## Notes ' + round + '\n\n' + 'y'.repeat(3000)); }
  }
  assert.ok(trackerPrompts.length >= 5, 'several tracker notes');
  assert.match(trackerPrompts[0], /Previous ledger/);
  assert.match(trackerPrompts[0], /Valid source IDs: \[/);
  const later = trackerPrompts.slice(1);
  for (const p of later) { assert.doesNotMatch(p, /Previous ledger|Most recent organization notes|Valid source IDs: \[/); }
  const early = Buffer.byteLength(later[0]), last = Buffer.byteLength(later.at(-1));
  assert.ok(last < early * 2, `tracker prompt grew from ${early} to ${last} bytes`);
});

test('a rejected tracker answer is repaired with full context', async t => {
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 3, maxMinutes: 1});
  s.publish(await s.turn(false, 0)); s.record(await s.turn(true, 0)); await s.until(() => s.store.latest(s.id));
  s.publish(await s.turn(false, 1));
  const second = await s.turn(true, 1); assert.doesNotMatch(s.text(second), /Previous ledger/);
  s.hosts.at(-1).complete(second, 'not json');
  const repair = await s.turn(true, 2); assert.match(s.text(repair), /Previous ledger/);
});

test('one tracker turn organizes every source that arrived while it was busy', async t => {
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 12, maxMinutes: 1});
  s.publish(await s.turn(false, 0), 'Finding 0');
  const first = await s.turn(true, 0);
  // Real rounds are substantive; tiny repeated rounds with no new input would be held as idle.
  for (let round = 1; round <= 6; round++) s.publish(await s.turn(false, round), 'Finding ' + round + '. ' + 'Supporting derivation. '.repeat(30));
  await s.until(() => s.store.pending(s.id).n >= 7);
  s.record(first); await s.until(() => s.store.latest(s.id));
  const second = await s.turn(true, 1);
  for (let round = 1; round <= 6; round++) assert.match(s.text(second), new RegExp('Finding ' + round + '\\b'));
  s.record(second);
  await s.until(() => s.store.pending(s.id).n === 0);
});

test('a tracker batch is bounded by size and never skips a source', async t => {
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 12, maxMinutes: 1});
  s.publish(await s.turn(false, 0), 'Finding 0');
  const first = await s.turn(true, 0);
  for (let round = 1; round <= 3; round++) s.publish(await s.turn(false, round), 'Big ' + round + ' ' + 'z'.repeat(60000));
  await s.until(() => s.store.pending(s.id).n >= 4);
  s.record(first); await s.until(() => s.store.latest(s.id));
  const second = await s.turn(true, 1);
  assert.match(s.text(second), /Big 1 /); assert.match(s.text(second), /Big 2 /); assert.doesNotMatch(s.text(second), /Big 3 /);
  s.record(second);
  const third = await s.turn(true, 2);
  assert.match(s.text(third), /Big 3 /);
});

test('an over-long ledger is trimmed to its bounds instead of failing the tracker turn', async t => {
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 3, maxMinutes: 1});
  s.publish(await s.turn(false, 0));
  const findings = Array.from({length: 30}, (_, i) => ({id: 'F' + i, kind: 'new', summary: 'w'.repeat(1900), sourceIds: [], evidenceIds: []}));
  s.record(await s.turn(true, 0), {findings, questions: [], nextDirections: ['keep going']});
  const latest = await s.until(() => s.store.latest(s.id));
  assert.ok(latest.feedback.findings.length <= 24);
  assert.ok(Buffer.byteLength(JSON.stringify(latest.feedback)) <= 32000);
  assert.equal(latest.feedback.findings[0].id, 'F0', 'the tracker\'s first priorities are kept');
  assert.deepEqual(latest.feedback.nextDirections, ['keep going']);
  assert.equal(s.audit('ledger_clamped').length, 1);
  assert.equal(s.audit('attempt_failed').length, 0);
});

test('the tracker moves to a fresh thread before its history reaches backend compaction size', async t => {
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 6, maxMinutes: 1});
  for (let round = 0; round < 3; round++) {
    s.publish(await s.turn(false, round), 'Large ' + round + ' ' + 'q'.repeat(110000));
    const tracker = await s.turn(true, round);
    if (round === 2) { assert.match(s.text(tracker), /Previous ledger/); assert.equal(s.audit('checkpoint_restart').length, 1); }
    else assert.equal(s.audit('checkpoint_restart').length, 0);
    s.record(tracker); await s.until(() => s.store.pending(s.id).n === 0);
  }
});

test('a primed tracker gets only the evidence it has not seen', async t => {
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 6, maxMinutes: 1});
  const ev = text => s.store.submitEvidence(s.id, {requestId: text, expectedInputRevision: s.store.packet(s.id).revision, text, provenance: 'test', sourceRevision: 'test', status: 'observed', observedAt: '2026-01-01T00:00:00Z'});
  s.publish(await s.turn(false, 0)); s.record(await s.turn(true, 0)); await s.until(() => s.store.pending(s.id).n === 0);
  ev('Alpha measurement');
  s.publish(await s.turn(false, 1)); const second = await s.turn(true, 1);
  assert.match(s.text(second), /Alpha measurement/); s.record(second); await s.until(() => s.store.pending(s.id).n === 0 && !s.store.pending(s.id).evidencePending);
  ev('Beta measurement');
  s.publish(await s.turn(false, 2)); const third = await s.turn(true, 2);
  assert.match(s.text(third), /Beta measurement/);
  assert.doesNotMatch(s.text(third), /Alpha measurement/, 'evidence already in the thread is not re-sent');
});

test('token usage is recorded per turn and totalled', async t => {
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 2, maxMinutes: 1});
  s.publish(await s.turn(false, 0), 'Round one', {inputTokens: 1000, cachedInputTokens: 900, outputTokens: 50, reasoningOutputTokens: 30, totalTokens: 1050});
  await s.until(() => s.audit('turn_metrics').length);
  assert.deepEqual(s.audit('turn_metrics')[0].usage, {inputTokens: 1000, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 30});
  assert.equal(s.runtime.status(s.id).run.metrics.tokens.cachedInputTokens, 900);
});

const limits = used => ({rateLimits: {limitId: 'codex', primary: {usedPercent: used, windowDurationMins: 10080}}, rateLimitsByLimitId: {codex: {limitId: 'codex', primary: {usedPercent: used, windowDurationMins: 10080}}}, ordinaryUsageAllowed: used < 100});
const rateUpdate = (s, used, limitId = 'codex') => s.hosts.at(-1).emit('notification', {method: 'account/rateLimits/updated', params: {rateLimits: {limitId, primary: {usedPercent: used}}}});

test('a run never continues onto purchased credits when the plan limit is reached', async t => {
  const s = setup(t, {rateLimits: () => limits(40)}); s.runtime.start(s.id, {continuous: true});
  s.publish(await s.turn(false, 0)); await s.turn(false, 1);
  rateUpdate(s, 100);
  await s.until(() => ['stopped', 'stopping'].includes(s.runtime.status(s.id).state));
  assert.equal(s.audit('usage_guard')[0].action, 'stop');
});

test('a separate limit near its cap is not hidden by another limit, and pauses only continuous runs', async t => {
  const s = setup(t, {rateLimits: () => limits(10)}); s.runtime.start(s.id, {continuous: true});
  s.publish(await s.turn(false, 0)); await s.turn(false, 1);
  rateUpdate(s, 95, 'premium'); rateUpdate(s, 20, 'codex');
  await s.until(() => ['paused', 'pausing'].includes(s.runtime.status(s.id).state));
  assert.equal(s.audit('usage_guard')[0].action, 'pause');
  const b = setup(t, {rateLimits: () => limits(10)}); b.runtime.start(b.id, {maxRounds: 3, maxMinutes: 1});
  b.publish(await b.turn(false, 0)); await b.turn(false, 1);
  rateUpdate(b, 95); for (let i = 0; i < 20; i++) await tick();
  assert.equal(b.runtime.status(b.id).state, 'running');
});

test('a run will not start on an exhausted plan unless credits are allowed', async t => {
  const s = setup(t, {rateLimits: () => limits(100)}); s.runtime.start(s.id, {maxRounds: 2, maxMinutes: 1});
  await s.until(() => s.runtime.status(s.id).state === 'failed');
  assert.match(JSON.stringify(s.runtime.status(s.id).run), /does not spend purchased credits/);
  assert.equal(s.hosts.at(-1).turns.length, 0, 'no paid turn was started');
});

test('the time limit stops thinkers but lets the tracker record what they already published', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 6, maxMinutes: 1});
  s.publish(await s.turn(false, 0));
  const recording = await s.turn(true, 0), thinking = await s.turn(false, 1);
  t.mock.timers.tick(60000);
  await s.until(() => thinking.done);
  assert.equal(recording.done, false, 'the tracker turn in progress is not interrupted');
  await s.until(() => s.runtime.status(s.id).state === 'draining');
  s.record(recording);
  await s.until(() => s.runtime.status(s.id).state === 'limited');
  const run = s.runtime.status(s.id).run;
  assert.equal(run.recordedCount, run.sourceCount, 'every published round is recorded');
  assert.equal(run.reason, 'time_limit'); assert.equal(run.drain.capHit, false);
  assert.equal(s.hosts.at(-1).turns.filter(x => !x.tracker).length, 2, 'no thinker round starts after the limit');
});

test('a drain that outlasts its window is stopped and leaves the unrecorded rounds pending', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 6, maxMinutes: 1});
  s.publish(await s.turn(false, 0));
  const recording = await s.turn(true, 0);
  t.mock.timers.tick(60000);
  await s.until(() => s.runtime.status(s.id).state === 'draining');
  t.mock.timers.tick(15 * 60000);
  await s.until(() => recording.done && s.runtime.status(s.id).state === 'limited');
  const run = s.runtime.status(s.id).run;
  assert.equal(run.drain.capHit, true); assert.equal(run.recordedCount, 0); assert.equal(run.recorder.status, 'pending');
  assert.deepEqual(s.audit('drain_limit').map(x => x.pending), [1]);
});

test('a misnamed evidence field is rejected with the right field names', async t => {
  const s = setup(t);
  assert.throws(() => s.store.submitEvidence(s.id, {requestId: 'e1', expectedInputRevision: 0, evidence: 'x', provenance: 'p', sourceRevision: 'r', status: 'observed', observedAt: '2026-01-01T00:00:00Z'}), /Unknown evidence field evidence; evidence fields are text, provenance/);
});

test('after a repaired tracker reply the next turn restates the accepted note and ledger', async t => {
  const s = setup(t); s.runtime.start(s.id, {maxRounds: 6, maxMinutes: 1});
  s.publish(await s.turn(false, 0));
  const first = await s.turn(true, 0), h = s.hosts.at(-1); first.done = true;
  h.emit('notification', {method: 'item/completed', params: {threadId: first.p.threadId, turnId: first.id, item: {type: 'agentMessage', id: first.id, text: JSON.stringify({markdown: '## Repaired note', feedback: feedback(7)}), phase: 'final_answer'}}});
  h.emit('notification', {method: 'turn/completed', params: {threadId: first.p.threadId, turn: {id: first.id, status: 'completed', structured: {rejections: 1, repaired: true}}}});
  await s.until(() => s.store.pending(s.id).n === 0);
  s.publish(await s.turn(false, 1)); const second = await s.turn(true, 1);
  assert.equal(second.p.threadId, first.p.threadId, 'same primed thread');
  assert.match(s.text(second), /reached the host damaged/); assert.match(s.text(second), /Repaired note/); assert.match(s.text(second), /direction 7/);
  assert.doesNotMatch(s.text(second), /last accepted response in this thread/);
  assert.deepEqual(s.audit('structured_rejected'), [{rejections: 1, repaired: true}]);
  s.record(second); await s.until(() => s.store.pending(s.id).n === 0);
  s.publish(await s.turn(false, 2)); const third = await s.turn(true, 2);
  assert.doesNotMatch(s.text(third), /reached the host damaged/, 'only the turn after a repair restates it');
});
