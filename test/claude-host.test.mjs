import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ClaudeHost, childEnvironment} from '../native/claude.mjs';
import {HostRouter} from '../native/router.mjs';
import {Store} from '../native/store.mjs';
import {Runtime, configuration} from '../native/runtime.mjs';
import {thinkerInstructions, trackerSchema} from '../native/feedback.mjs';
import {sameProcess} from '../native/identity.mjs';

const fake = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const opus = {modelId: 'claude-opus-5-5', speedId: 'standard', reasoning: 'max'};
const sonnet = {modelId: 'claude-sonnet-5-5', speedId: 'standard', reasoning: 'max'};
const newHost = () => new ClaudeHost({exe: process.execPath, exeArgs: [fake], env: {...process.env, ANTHROPIC_API_KEY: 'should-be-dropped'}});

async function setupHost(t) {
  const host = await newHost().initialize(), events = [], forbidden = [];
  host.on('notification', m => events.push(m)); host.on('forbiddenRequest', m => forbidden.push(m));
  t.after(() => host.close());
  const run = async (threadId, text, outputSchema) => {
    const {turn} = await host.request('turn/start', {threadId, input: [{type: 'text', text}], ...(outputSchema ? {outputSchema} : {})});
    for (let n = 0; n < 400; n++) {
      const done = events.find(e => e.method === 'turn/completed' && e.params.turn.id === turn.id);
      if (done) return {turn, done: done.params.turn, items: events.filter(e => e.params.turnId === turn.id)};
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('turn did not complete');
  };
  return {host, events, forbidden, run};
}

test('Claude turns publish only text, intact across split UTF-8, and never thinking', async t => {
  const {host, run} = await setupHost(t);
  const a = await host.thread(opus, thinkerInstructions);
  assert.equal(a.modelProvider, 'anthropic'); assert.equal(a.environmentAccess, false); assert.match(a.attestation, /requested, not attested/);
  const r = await run(a.threadId, 'round 1 [normal]');
  assert.equal(r.done.status, 'completed');
  const completed = r.items.filter(e => e.method === 'item/completed').map(e => e.params.item.text);
  assert.deepEqual(completed, ['Finding café 🧪 1\n<!-- loop:continue -->']);
  const deltas = r.items.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('');
  assert.equal(deltas, completed[0]);
  assert.ok(!JSON.stringify(r.items).includes('SECRET-THOUGHT'));
  const second = await run(a.threadId, 'round 2 [normal]');
  assert.equal(second.done.status, 'completed');
});

test('wrong admitted model and API-key billing fail the turn', async t => {
  const {host, run} = await setupHost(t);
  const a = await host.thread(opus, thinkerInstructions);
  const wrong = await run(a.threadId, '[wrongmodel]');
  assert.equal(wrong.done.status, 'failed'); assert.match(wrong.done.error.message, /claude-haiku-5-5, not the requested claude-opus-5-5/);
  const key = await run(a.threadId, '[apikey]');
  assert.equal(key.done.status, 'failed'); assert.match(key.done.error.message, /only the subscription login/);
});

test('a tool call is reported as a boundary crossing and fails the turn', async t => {
  const {host, run, forbidden} = await setupHost(t);
  const a = await host.thread(opus, thinkerInstructions);
  const r = await run(a.threadId, '[tool]');
  assert.equal(r.done.status, 'failed'); assert.deepEqual(forbidden.map(f => f.method), ['tool_use:Bash']);
});

test('interrupt ends a running turn as interrupted and the thread keeps working', async t => {
  const {host, run, events} = await setupHost(t);
  const a = await host.thread(opus, thinkerInstructions);
  const {turn} = await host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: '[slow]'}]});
  for (let n = 0; n < 200 && !events.some(e => e.method === 'item/agentMessage/delta' && e.params.turnId === turn.id); n++) await new Promise(r => setTimeout(r, 10));
  await host.request('turn/interrupt', {threadId: a.threadId, turnId: turn.id});
  for (let n = 0; n < 200 && !events.some(e => e.method === 'turn/completed' && e.params.turn.id === turn.id); n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(events.find(e => e.method === 'turn/completed' && e.params.turn.id === turn.id).params.turn.status, 'interrupted');
  assert.equal((await run(a.threadId, 'round 3 [normal]')).done.status, 'completed');
});

test('a dead Claude process fails only its own thread', async t => {
  const {host, run} = await setupHost(t);
  const a = await host.thread(opus, thinkerInstructions), b = await host.thread(opus, thinkerInstructions);
  const died = await run(a.threadId, '[die]');
  assert.equal(died.done.status, 'failed'); assert.match(died.done.error.message, /exited \(3\)/);
  await assert.rejects(host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: 'x'}]}), /closed/);
  assert.equal((await run(b.threadId, 'round 1 [normal]')).done.status, 'completed');
});

test('tracker threads fix the structured output schema and usage limits fail visibly', async t => {
  const {host, run} = await setupHost(t);
  const tr = await host.thread(sonnet, 'tracker', undefined, {outputSchema: trackerSchema});
  assert.equal(tr.structuredOutputTool, 'StructuredOutput');
  const r = await run(tr.threadId, 'organize [normal]', trackerSchema);
  assert.equal(r.done.status, 'completed');
  assert.equal(JSON.parse(r.items.find(e => e.method === 'item/completed').params.item.text).markdown, '## Note\n\nOrganized.');
  await assert.rejects(host.request('turn/start', {threadId: tr.threadId, input: [{type: 'text', text: 'x'}]}), /fixes its output schema/);
  const limit = await run(tr.threadId, '[limit]', trackerSchema);
  assert.equal(limit.done.status, 'failed'); assert.match(limit.done.error.message, /usage limit/);
});

test('child environment drops API-key billing and parent session variables', () => {
  const env = childEnvironment({ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 'login', PATH: 'p'}, false);
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'PATH']);
  assert.ok('ANTHROPIC_API_KEY' in childEnvironment({ANTHROPIC_API_KEY: 'k'}, true));
});

test('router starts only the hosts a run needs and routes by model', async t => {
  let codexBuilt = 0;
  const router = new HostRouter({codexFactory: () => { codexBuilt++; throw new Error('ChatGPT is not open'); }, claudeFactory: o => new ClaudeHost({...o, exe: process.execPath, exeArgs: [fake]})});
  t.after(() => router.close());
  await router.initialize({models: ['claude-opus-5-5', 'claude-sonnet-5-5']});
  assert.equal(codexBuilt, 0);
  assert.throws(() => router.validate({modelId: 'gpt-6-astra', speedId: 'priority', reasoning: 'max'}), /Codex host is unavailable/);
  router.validate(opus);
  const catalogRouter = new HostRouter({codexFactory: () => { throw new Error('ChatGPT is not open'); }, claudeFactory: o => new ClaudeHost({...o, exe: process.execPath, exeArgs: [fake]})});
  await catalogRouter.initialize();
  const c = catalogRouter.catalog();
  assert.deepEqual(c.models.map(m => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5']); assert.match(c.unavailable.codex, /not open/);
  await catalogRouter.close();
  await assert.rejects(new HostRouter({codexFactory: () => { throw new Error('ChatGPT is not open'); }}).initialize({models: ['gpt-6-astra']}), /not open/);
});

test('multi-process host identity is dead only when every member is', () => {
  assert.equal(sameProcess({members: [{pid: 2147483646, start: '1'}, {pid: 2147483645, start: '2'}]}), 'dead');
  assert.equal(sameProcess({members: [{pid: process.pid, start: 'wrong'}, {pid: 2147483646, start: '1'}]}), 'dead');
  assert.equal(sameProcess({members: []}), 'unknown');
});

test('Claude-only configuration defaults to a Sonnet recorder; Astra keeps Terra', () => {
  assert.deepEqual(configuration({thinkers: [opus], maxRounds: 2, maxMinutes: 1}).tracker, sonnet);
  assert.equal(configuration({}).tracker.modelId, 'gpt-6.1-terra');
  assert.equal(configuration({thinkers: [opus], tracker: {modelId: 'gpt-6.1-terra', speedId: 'priority', reasoning: 'max'}}).tracker.modelId, 'gpt-6.1-terra');
  assert.throws(() => configuration({tracker: {modelId: 'x', speedId: 'y', reasoning: 'high'}}), /max reasoning/);
});

test('a bounded Opus run with a Sonnet recorder publishes every round verbatim', async t => {
  const dir = mkdtempSync(path.join(process.env.GOAL_LOOP_TEST_TMP || tmpdir(), 'loop-claude-')), store = new Store(dir);
  const runtime = new Runtime(store, {clientFactory: o => new HostRouter({...o, codexFactory: () => { throw new Error('Codex must not start'); }, claudeFactory: o2 => new ClaudeHost({...o2, exe: process.execPath, exeArgs: [fake]})})});
  t.after(async () => { await runtime.close(); store.close(); rmSync(dir, {recursive: true, force: true}); });
  const id = store.prepare({goal: 'Find why checkout times out.', context: 'Pool size 10.', requestId: 'claude-run'});
  runtime.start(id, {thinkers: [opus], maxRounds: 3, maxMinutes: 1});
  let s;
  for (let n = 0; n < 600; n++) { s = runtime.status(id); if (['completed', 'limited', 'failed', 'recording_failed', 'interrupted'].includes(s.state) || s.run?.finishedAt) break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(s.run.error, null);
  assert.equal(s.run.config.tracker.modelId, 'claude-sonnet-5-5');
  const sources = store.sources(id); assert.equal(sources.length, 3);
  const doc = store.content(id).markdown;
  for (const src of sources) { assert.match(src.text, /Finding café 🧪/); assert.ok(doc.includes(src.text)); }
  assert.ok(doc.includes('Organized.'));
  assert.equal(s.run.toolCalls, 0);
  assert.ok(s.run.receipts.every(r => r.modelProvider === 'anthropic'));
});

test('every thinker round restates the objective and checks for drift', async t => {
  const dir = mkdtempSync(path.join(process.env.GOAL_LOOP_TEST_TMP || tmpdir(), 'loop-drift-')), store = new Store(dir), prompts = [];
  const runtime = new Runtime(store, {clientFactory: o => { const r = new HostRouter({...o, claudeFactory: o2 => new ClaudeHost({...o2, exe: process.execPath, exeArgs: [fake]})}); const req = r.request.bind(r); r.request = (m, p, x) => { if (m === 'turn/start' && !p.outputSchema) prompts.push(p.input[0].text); return req(m, p, x); }; return r; }});
  t.after(async () => { await runtime.close(); store.close(); rmSync(dir, {recursive: true, force: true}); });
  const id = store.prepare({goal: 'UNIQUE-OBJECTIVE-7731: why does checkout time out?', context: 'Pool size 10.', requestId: 'drift-run'});
  runtime.start(id, {thinkers: [opus], maxRounds: 3, maxMinutes: 1});
  for (let n = 0; n < 600 && prompts.length < 3; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(prompts.length, 3);
  for (const p of prompts) assert.ok(p.includes('UNIQUE-OBJECTIVE-7731'));
  for (const p of prompts.slice(1)) assert.match(p, /drifted into a sub-problem/);
});
