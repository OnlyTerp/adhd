import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../native/store.mjs';
import {Runtime, configuration} from '../native/runtime.mjs';
import {claudeRateLimits} from '../native/claude.mjs';
import {backendOf} from '../native/router.mjs';

const tick = () => new Promise(r => setImmediate(r));

test('selections name their backend; legacy model-only selections are inferred', () => {
  assert.equal(backendOf({modelId: 'claude-opus-5-5'}), 'claude');
  assert.equal(backendOf({modelId: 'gpt-6-astra'}), 'codex');
  assert.equal(backendOf({backend: 'devin', modelId: 'swe-2'}), 'devin');
  const c = configuration({thinkers: [{modelId: 'claude-opus-5-5'}], maxRounds: 2});
  assert.deepEqual(c.thinkers[0], {backend: 'claude', modelId: 'claude-opus-5-5', speedId: 'standard', reasoning: 'max'});
  assert.deepEqual(c.tracker, {backend: 'claude', modelId: 'claude-sonnet-5-5', speedId: 'standard', reasoning: 'medium'}, 'a Claude tracker organizes at medium effort');
  assert.equal(configuration({}).tracker.modelId, 'gpt-6.1-terra');
  const d = configuration({thinkers: [{backend: 'devin', modelId: 'swe-2'}]});
  assert.deepEqual(d.tracker, {backend: 'devin', modelId: 'swe-2', speedId: 'standard', reasoning: 'default'}, 'other backends record with their own model');
  assert.equal(configuration({thinkers: [{backend: 'openai:local', modelId: 'm'}], tracker: {backend: 'claude', modelId: 'claude-sonnet-5-5', reasoning: 'low'}}).tracker.reasoning, 'low');
  assert.throws(() => configuration({thinkers: [{backend: 'devin'}]}), /modelId/);
  assert.throws(() => configuration({maxTokens: 50}), /maxTokens/);
});

test('Claude plan events map to the usage guard: overage and rejection count as exhausted', () => {
  assert.equal(claudeRateLimits({status: 'allowed', utilization: 0.42, rateLimitType: 'seven_day'}).primary.usedPercent, 42);
  assert.equal(claudeRateLimits({status: 'allowed', utilization: 63}).primary.usedPercent, 63);
  assert.equal(claudeRateLimits({status: 'allowed', isUsingOverage: true}).rateLimitReachedType, 'overage');
  assert.equal(claudeRateLimits({status: 'rejected'}).primary.usedPercent, 100);
  assert.equal(claudeRateLimits({status: 'allowed_warning', utilization: 0.9}).rateLimitReachedType, null);
});

function setup(t, {capabilities = {}} = {}) {
  const dir = mkdtempSync(path.join(process.env.GOAL_LOOP_TEST_TMP || tmpdir(), 'loop-backend-')), store = new Store(dir), hosts = [];
  class Host extends EventEmitter {
    constructor() { super(); this.turns = []; this.inits = []; hosts.push(this); }
    async initialize(o) { this.inits.push(o); this.account = {}; }
    validate() {}
    capabilities() { return capabilities; }
    async thread(choice) { return {threadId: 't' + Math.random(), model: choice.modelId, modelProvider: choice.backend, serviceTier: choice.speedId, reasoningEffort: choice.reasoning}; }
    async request(method, p) {
      if (method === 'turn/interrupt') { const x = this.turns.find(y => y.id === p.turnId); if (x && !x.done) this.complete(x, null, 'interrupted'); return {}; }
      const turn = {id: 'turn-' + this.turns.length, p, done: false}; this.turns.push(turn); return {turn: {id: turn.id, status: 'inProgress'}};
    }
    complete(turn, text, status = 'completed', usage) {
      turn.done = true;
      if (text !== null) this.emit('notification', {method: 'item/completed', params: {threadId: turn.p.threadId, turnId: turn.id, item: {type: 'agentMessage', id: turn.id, text}}});
      if (usage) this.emit('notification', {method: 'thread/tokenUsage/updated', params: {threadId: turn.p.threadId, turnId: turn.id, tokenUsage: {last: usage}}});
      this.emit('notification', {method: 'turn/completed', params: {threadId: turn.p.threadId, turn: {id: turn.id, status}}});
    }
    async close() { return {confirmed: true}; }
  }
  const runtime = new Runtime(store, {clientFactory: () => new Host()});
  const id = store.prepare({goal: 'Count widgets.', context: 'none', requestId: 'r'});
  t.after(async () => { await runtime.close(); store.close(); rmSync(dir, {recursive: true, force: true}); });
  const until = async f => { for (let n = 0; n < 300; n++) { const x = f(); if (x) return x; await tick(); } throw new Error('Expected event did not occur'); };
  return {store, runtime, id, hosts, until};
}

test('each turn asks for its own worker effort, and only the backends a run uses start', async t => {
  const s = setup(t);
  s.runtime.start(s.id, {thinkers: [{backend: 'claude', modelId: 'claude-opus-5-5', reasoning: 'high'}], maxRounds: 2, maxMinutes: 1});
  const first = await s.until(() => s.hosts.at(-1)?.turns[0]);
  assert.equal(first.p.effort, 'high');
  assert.deepEqual(s.hosts.at(-1).inits[0], {backends: ['claude']});
});

test('a token budget stops the run', async t => {
  const s = setup(t);
  s.runtime.start(s.id, {thinkers: [{backend: 'devin', modelId: 'swe-2'}], continuous: true, maxTokens: 10000});
  const first = await s.until(() => s.hosts.at(-1)?.turns[0]);
  s.hosts.at(-1).complete(first, 'Finding\n<!-- loop:continue -->', 'completed', {inputTokens: 9000, cachedInputTokens: 0, outputTokens: 1500});
  await s.until(() => ['stopped', 'stopping'].includes(s.runtime.status(s.id).state));
  const guard = s.store.db.prepare("SELECT data FROM audit WHERE session_id=? AND type='usage_guard'").all(s.id).map(r => JSON.parse(r.data));
  assert.equal(guard[0].maxTokens, 10000);
});

test('a per-token backend needs a token budget before any turn starts', async t => {
  const s = setup(t, {capabilities: {billing: 'per-token'}});
  s.runtime.start(s.id, {thinkers: [{backend: 'openai:router', modelId: 'some/model'}], continuous: true});
  await s.until(() => s.runtime.status(s.id).state === 'failed');
  assert.match(JSON.stringify(s.runtime.status(s.id).run), /maxTokens/);
  assert.equal(s.hosts.at(-1).turns.length, 0);
});

test('JSON wrapped in a sentence or fence is recovered; prose alone is not', async () => {
  const {extractJson} = await import('../native/acp.mjs');
  assert.deepEqual(extractJson('Here is the note:\n{"markdown":"a","feedback":{}}\nDone.'), {markdown: 'a', feedback: {}});
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), {a: 1});
  assert.equal(extractJson('Sure! The answer is forty-two.'), null);
  assert.equal(extractJson('[1,2]'), null);
});

test('an endpoints.json in the data directory adds openai:<name> to the catalog without any network call', async t => {
  const {writeFileSync} = await import('node:fs');
  const {HostRouter} = await import('../native/router.mjs');
  const dir = mkdtempSync(path.join(process.env.GOAL_LOOP_TEST_TMP || tmpdir(), 'loop-endpoints-'));
  writeFileSync(path.join(dir, 'endpoints.json'), JSON.stringify([{name: 'box', baseUrl: 'http://127.0.0.1:9/v1', billing: 'local', models: [{id: 'm1', contextTokens: 8192}]}]));
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('no network in catalog'); };
  const down = () => ({on() {}, async initialize() { throw new Error('not installed'); }, async close() { return {confirmed: true}; }});
  const router = new HostRouter({cwd: dir, env: {}, codexFactory: down, claudeFactory: down, factories: {devin: down}});
  t.after(async () => { globalThis.fetch = realFetch; await router.close(); rmSync(dir, {recursive: true, force: true}); });
  await router.initialize();
  const cat = router.catalog();
  assert.deepEqual(cat.backends.map(b => b.id), ['openai:box']);
  assert.equal(cat.backends[0].capabilities.billing, 'local');
  assert.deepEqual(cat.models.map(m => [m.backend, m.id]), [['openai:box', 'm1']]);
  assert.deepEqual(Object.keys(cat.unavailable).sort(), ['claude', 'codex', 'devin']);
  assert.equal(calls, 0);
  router.validate({backend: 'openai:box', modelId: 'm1', speedId: 'standard', reasoning: 'default'});
});

test('a broken endpoints.json is reported and leaves the other backends working', async t => {
  const {writeFileSync} = await import('node:fs');
  const {HostRouter} = await import('../native/router.mjs');
  const dir = mkdtempSync(path.join(process.env.GOAL_LOOP_TEST_TMP || tmpdir(), 'loop-endpoints-'));
  writeFileSync(path.join(dir, 'endpoints.json'), '[{"name": "box",');
  const up = () => Object.assign(new EventEmitter(), {async initialize() { this.account = {}; }, catalog: () => ({source: 'fake', models: [{id: 'm', efforts: ['default'], speeds: [{id: 'standard'}]}]}), async close() { return {confirmed: true}; }});
  const down = () => ({on() {}, async initialize() { throw new Error('not installed'); }, async close() { return {confirmed: true}; }});
  const router = new HostRouter({cwd: dir, env: {}, codexFactory: up, claudeFactory: down, factories: {devin: down}});
  t.after(async () => { await router.close(); rmSync(dir, {recursive: true, force: true}); });
  await router.initialize();
  const cat = router.catalog();
  assert.deepEqual(cat.backends.map(b => b.id), ['codex']);
  assert.match(cat.unavailable.endpoints, /not valid JSON/);
  const strict = new HostRouter({cwd: dir, env: {}, codexFactory: up, claudeFactory: down, factories: {devin: down}});
  await assert.rejects(strict.initialize({backends: ['openai:box']}), /Endpoints are unavailable: .*not valid JSON/);
  await strict.close();
});

test('the default thinker skips a backend whose plan is spent', async () => {
  const {defaultThinker} = await import('../native/tools.mjs');
  const {planUsage} = await import('../native/runtime.mjs');
  const models = [{backend: 'codex', id: 'gpt-6-astra', speeds: [{id: 'priority'}], efforts: ['max']}, {backend: 'claude', id: 'claude-opus-5-5', speeds: [{id: 'standard'}], efforts: ['max']}];
  const spent = planUsage({rateLimits: {primary: {usedPercent: 100}}});
  assert.deepEqual(spent, {usedPercent: 100, exhausted: true});
  assert.equal(defaultThinker({backends: [{id: 'codex', usage: spent}, {id: 'claude'}], models}).modelId, 'claude-opus-5-5');
  assert.equal(defaultThinker({backends: [{id: 'codex', usage: {usedPercent: 12, exhausted: false}}], models}).modelId, 'gpt-6-astra');
  assert.throws(() => defaultThinker({backends: [{id: 'codex', usage: spent}], models: models.slice(0, 1)}), /plan limit: codex/);
  assert.equal(planUsage({rateLimitsByLimitId: {a: {primary: {usedPercent: 40}}, b: {rateLimitReachedType: 'credits'}}}).exhausted, true);
});
