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
