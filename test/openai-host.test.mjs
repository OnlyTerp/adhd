import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {OpenAICompatibleHost, parseEndpoints, SCHEMA_SUFFIX, SUMMARY_PREFIX, SUMMARY_ACK} from '../native/openai.mjs';

const KEY = 'sk-test-SECRET-4f9a7c';
const MODEL = 'qwen3:8b';
const sel = (o = {}) => ({backend: 'openai:fake', modelId: MODEL, speedId: 'standard', reasoning: 'default', ...o});
const schema = {type: 'object', properties: {markdown: {type: 'string'}}, required: ['markdown']};

// A fake chat-completions server. Each request is recorded and answered by the next
// queued handler, or by the default handler (a streamed echo reply).
async function fakeServer(t) {
  const requests = [], queue = [];
  let fallback = (req, res, body) => sse(res, reply(`answer ${requests.length}`));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const entry = {headers: req.headers, url: req.url, body, raw, closed: false};
      requests.push(entry); res.on('close', () => { entry.closed = true; });
      (queue.shift() ?? fallback)(req, res, body, entry);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return {requests, queue, url: `http://127.0.0.1:${server.address().port}/v1`, setDefault: f => { fallback = f; }};
}

const chunk = (delta, extra = {}) => ({id: 'c', model: MODEL, choices: [{index: 0, delta, finish_reason: null}], ...extra});
function reply(text, {model = MODEL, usage = {prompt_tokens: 50, completion_tokens: 7}} = {}) {
  const parts = text.match(/[\s\S]{1,4}/g) ?? [];
  return [chunk({role: 'assistant', content: ''}), ...parts.map(p => ({...chunk({content: p}), model})),
    {id: 'c', model, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]}, ...(usage ? [{id: 'c', model, choices: [], usage}] : [])];
}
function sse(res, chunks, {done = true} = {}) {
  res.writeHead(200, {'content-type': 'text/event-stream'});
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  if (done) res.end('data: [DONE]\n\n');
}
const fail = (status, text) => (req, res) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(text); };

function endpoint(url, extra = {}) {
  return {name: 'fake', baseUrl: url, apiKeyEnv: 'FAKE_OPENAI_KEY', billing: 'local', models: [{id: MODEL, contextTokens: 32768}], ...extra};
}

async function setup(t, {url, ep, options = {}} = {}) {
  const server = url ? null : await fakeServer(t);
  const host = await new OpenAICompatibleHost(ep ?? endpoint(url ?? server.url), {env: {FAKE_OPENAI_KEY: KEY}, retryDelaysMs: [5, 10], watchdogMs: 2000, ...options}).initialize();
  const events = [], forbidden = [];
  host.on('notification', m => events.push(m)); host.on('forbiddenRequest', m => forbidden.push(m));
  t.after(() => host.close());
  const wait = async turnId => {
    for (let n = 0; n < 500; n++) {
      const done = events.find(e => e.method === 'turn/completed' && e.params.turn.id === turnId);
      if (done) return done.params.turn;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('turn did not complete');
  };
  const run = async (threadId, text, outputSchema) => {
    const {turn} = await host.request('turn/start', {threadId, input: [{type: 'text', text}], ...(outputSchema ? {outputSchema} : {})});
    const done = await wait(turn.id);
    return {turn, done, items: events.filter(e => e.params.turnId === turn.id)};
  };
  return {server, host, events, forbidden, run, wait};
}

test('multi-turn history keeps a byte-stable prefix and publishes deltas, answer, usage in order', async t => {
  const {server, host, run} = await setup(t);
  server.queue.push((req, res) => sse(res, [
    chunk({reasoning_content: 'SECRET-REASONING'}), chunk({reasoning: 'MORE-SECRET'}),
    ...reply('Finding café 🧪 one', {usage: {prompt_tokens: 120, prompt_tokens_details: {cached_tokens: 64}, completion_tokens: 30, completion_tokens_details: {reasoning_tokens: 12}}})]));
  const a = await host.thread(sel(), 'You are a research thinker.');
  assert.deepEqual(Object.keys(a).sort(), ['attestation', 'environmentAccess', 'model', 'modelProvider', 'reasoningEffort', 'serviceTier', 'threadId']);
  assert.equal(a.modelProvider, 'openai:fake'); assert.equal(a.environmentAccess, false); assert.equal(a.serviceTier, 'standard');
  const r1 = await run(a.threadId, 'round 1');
  assert.equal(r1.done.status, 'completed');
  assert.deepEqual(r1.items.map(e => e.method).filter((m, i, all) => m !== all[i - 1]), ['item/agentMessage/delta', 'item/completed', 'thread/tokenUsage/updated', 'turn/completed']);
  const answer = r1.items.find(e => e.method === 'item/completed').params.item;
  assert.equal(answer.type, 'agentMessage'); assert.equal(answer.text, 'Finding café 🧪 one');
  assert.equal(r1.items.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join(''), answer.text);
  assert.deepEqual(r1.items.find(e => e.method === 'thread/tokenUsage/updated').params.tokenUsage.last,
    {inputTokens: 120, cachedInputTokens: 64, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 12});
  assert.ok(!JSON.stringify(r1.items).includes('SECRET'));
  assert.equal(r1.items.filter(e => e.method === 'turn/completed').length, 1);

  const r2 = await run(a.threadId, 'round 2');
  assert.equal(r2.done.status, 'completed');
  const [q1, q2] = server.requests.map(r => r.body);
  assert.deepEqual(q1.messages, [{role: 'system', content: 'You are a research thinker.'}, {role: 'user', content: 'round 1'}]);
  assert.deepEqual(q2.messages.slice(0, 3), [...q1.messages, {role: 'assistant', content: 'Finding café 🧪 one'}]);
  assert.deepEqual(q2.messages[3], {role: 'user', content: 'round 2'});
  // The serialized prefix is byte-identical, so provider prompt caching applies.
  const prefix = JSON.stringify(q1.messages).slice(0, -1);
  assert.ok(JSON.stringify(q2.messages).startsWith(prefix));
  assert.equal(q1.stream, true); assert.deepEqual(q1.stream_options, {include_usage: true});
  for (const k of ['tools', 'functions', 'tool_choice', 'reasoning_effort', 'response_format']) assert.ok(!(k in q1), k);
  assert.equal(server.requests[0].url, '/v1/chat/completions');
});

test('no usage chunk means no usage notification; non-default effort is sent', async t => {
  const server = await fakeServer(t);
  const {host, run} = await setup(t, {ep: endpoint(server.url, {models: [{id: MODEL, contextTokens: 8192, efforts: ['high', 'low']}]})});
  server.queue.push((req, res) => sse(res, reply('hi', {usage: null})));
  server.queue.push((req, res) => sse(res, [...reply('two', {usage: {prompt_tokens: 10, completion_tokens: 1}}), {id: 'c', model: MODEL, choices: [], usage: {prompt_tokens: 10, completion_tokens: 2}}]));
  assert.throws(() => host.validate(sel()), /offers reasoning high, low, not default/);
  const a = await host.thread(sel({reasoning: 'high'}), 'sys');
  assert.equal(a.reasoningEffort, 'high');
  const r = await run(a.threadId, 'q');
  assert.equal(r.done.status, 'completed');
  assert.ok(!r.items.some(e => e.method === 'thread/tokenUsage/updated'));
  assert.equal(server.requests[0].body.reasoning_effort, 'high');
  const repeated = await run(a.threadId, 'q2');
  assert.deepEqual(repeated.items.find(e => e.method === 'thread/tokenUsage/updated').params.tokenUsage.last,
    {inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0});
});

test('a tool_calls delta is a forbidden request and fails the turn without touching history', async t => {
  const {server, host, run, forbidden} = await setup(t);
  server.queue.push((req, res) => sse(res, [chunk({content: 'let me'}), chunk({tool_calls: [{index: 0, id: 'x', type: 'function', function: {name: 'bash', arguments: ''}}]})], {done: false}));
  const a = await host.thread(sel(), 'sys');
  const r = await run(a.threadId, 'q1');
  assert.equal(r.done.status, 'failed'); assert.match(r.done.error.message, /tool boundary/);
  assert.deepEqual(forbidden, [{method: 'tool_calls:bash', threadId: a.threadId}]);
  assert.ok(!r.items.some(e => e.method === 'item/completed'));
  await run(a.threadId, 'q2');
  assert.deepEqual(server.requests[1].body.messages, [{role: 'system', content: 'sys'}, {role: 'user', content: 'q2'}]);
});

test('structured output: fenced JSON is accepted, invalid JSON fails and is not appended', async t => {
  const {server, host, run} = await setup(t);
  server.queue.push((req, res) => sse(res, reply('```json\n{"markdown": "## Note"}\n```')));
  server.queue.push((req, res) => sse(res, reply('Sure! Here is the note: ## Note')));
  server.queue.push((req, res) => sse(res, reply('[1, 2]')));
  const tr = await host.thread(sel(), 'tracker', undefined, {outputSchema: schema});
  await assert.rejects(host.request('turn/start', {threadId: tr.threadId, input: [{type: 'text', text: 'x'}]}), /fixes its output schema/);
  const ok = await run(tr.threadId, 'organize', schema);
  assert.equal(ok.done.status, 'completed');
  assert.ok(!ok.items.some(e => e.method === 'item/agentMessage/delta'));
  assert.equal(ok.items.find(e => e.method === 'item/completed').params.item.text, '{"markdown":"## Note"}');
  const q1 = server.requests[0].body;
  assert.equal(q1.messages[1].content, 'organize' + SCHEMA_SUFFIX + JSON.stringify(schema));
  assert.deepEqual(q1.response_format, {type: 'json_object'});
  const bad = await run(tr.threadId, 'again', schema);
  assert.equal(bad.done.status, 'failed'); assert.equal(bad.done.error.message, 'Endpoint returned no valid JSON');
  const arr = await run(tr.threadId, 'array', schema);
  assert.equal(arr.done.status, 'failed');
  const q3 = server.requests[2].body.messages;
  assert.equal(q3.length, 4); // system, user, assistant(JSON), new user: the bad answer is not in history
  assert.deepEqual(q3[2], {role: 'assistant', content: '{"markdown":"## Note"}'});
});

test('a 400 that mentions response_format is retried once without it', async t => {
  const {server, host, run} = await setup(t);
  server.queue.push(fail(400, '{"error":{"message":"Unsupported parameter: response_format"}}'));
  server.queue.push((req, res) => sse(res, reply('{"markdown":"ok"}')));
  const tr = await host.thread(sel(), 'tracker', undefined, {outputSchema: schema});
  const r = await run(tr.threadId, 'go', schema);
  assert.equal(r.done.status, 'completed');
  assert.equal(server.requests.length, 2);
  assert.ok('response_format' in server.requests[0].body); assert.ok(!('response_format' in server.requests[1].body));
  assert.deepEqual(server.requests[1].body.messages, server.requests[0].body.messages);
  const other = await host.thread(sel(), 'thinker');
  server.queue.push(fail(400, 'bad request: response_format'));
  assert.equal((await run(other.threadId, 'plain')).done.status, 'failed');
});

test('compaction summarizes the middle, keeps the last two pairs verbatim, and reports it', async t => {
  const server = await fakeServer(t);
  const {host, run} = await setup(t, {ep: endpoint(server.url, {models: [{id: MODEL, contextTokens: 4096}]})});
  const big = n => `round ${n} ` + 'x'.repeat(2500);
  server.setDefault((req, res, body) => {
    if (body.stream === false) { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({model: MODEL, choices: [{message: {role: 'assistant', content: 'SUMMARY: finding 42'}}], usage: {prompt_tokens: 900, completion_tokens: 10}})); return; }
    sse(res, reply(`reply ${body.messages.length} ` + 'y'.repeat(500)));
  });
  const a = await host.thread(sel(), 'sys');
  const replies = [];
  for (let n = 1; n <= 3; n++) {
    const r = await run(a.threadId, big(n));
    assert.equal(r.done.status, 'completed'); assert.ok(!r.items.some(e => e.params.item?.type === 'contextCompaction'));
    replies.push(r.items.find(e => e.method === 'item/completed').params.item.text);
  }
  const r4 = await run(a.threadId, big(4));
  assert.equal(r4.done.status, 'completed');
  const methods = r4.items.map(e => e.params.item?.type ?? e.method);
  assert.ok(methods.indexOf('contextCompaction') < methods.indexOf('agentMessage'));
  const summaryReq = server.requests.find(r => r.body.stream === false).body;
  assert.ok(summaryReq.messages[1].content.includes(big(1)) && summaryReq.messages[1].content.includes(replies[0]));
  assert.ok(!summaryReq.messages[1].content.includes(big(2)));
  assert.ok(!('tools' in summaryReq));
  const last = server.requests.at(-1).body.messages;
  assert.deepEqual(last, [{role: 'system', content: 'sys'}, {role: 'user', content: SUMMARY_PREFIX + 'SUMMARY: finding 42'}, {role: 'assistant', content: SUMMARY_ACK},
    {role: 'user', content: big(2)}, {role: 'assistant', content: replies[1]}, {role: 'user', content: big(3)}, {role: 'assistant', content: replies[2]},
    {role: 'user', content: big(4)}]);
  // Summary tokens are counted with the turn's own usage.
  assert.equal(r4.items.find(e => e.method === 'thread/tokenUsage/updated').params.tokenUsage.last.inputTokens, 950);
});

test('a failed summary falls back to dropping the oldest pairs; an oversized message fails clearly', async t => {
  const server = await fakeServer(t);
  const {host, run} = await setup(t, {ep: endpoint(server.url, {models: [{id: MODEL, contextTokens: 4096}]})});
  server.setDefault((req, res, body) => body.stream === false ? fail(500, 'summary down')(req, res) : sse(res, reply('ok ' + 'y'.repeat(500))));
  const a = await host.thread(sel(), 'sys');
  for (let n = 1; n <= 4; n++) {
    const r = await run(a.threadId, `round ${n} ` + 'x'.repeat(2500));
    assert.equal(r.done.status, 'completed');
    if (n === 4) assert.ok(r.items.some(e => e.params.item?.type === 'contextCompaction'));
  }
  const last = server.requests.at(-1).body.messages;
  assert.deepEqual(last.map(m => m.content.slice(0, 7)), ['sys', 'round 2', 'ok yyyy', 'round 3', 'ok yyyy', 'round 4']);
  const before = server.requests.length;
  const huge = await run(a.threadId, 'z'.repeat(4096 * 4));
  assert.equal(huge.done.status, 'failed'); assert.match(huge.done.error.message, /exceed the 4096-token context window/);
  assert.equal(server.requests.length, before);
});

test('429 is retried then succeeds; 500 three times fails with status and body', async t => {
  const {server, host, run} = await setup(t);
  server.queue.push(fail(429, 'slow down'), fail(503, 'busy'));
  const a = await host.thread(sel(), 'sys');
  assert.equal((await run(a.threadId, 'q')).done.status, 'completed');
  assert.equal(server.requests.length, 3);
  server.queue.push(fail(500, 'boom-1'), fail(500, 'boom-2'), fail(500, 'boom-3 ' + 'e'.repeat(1000)));
  const r = await run(a.threadId, 'q2');
  assert.equal(r.done.status, 'failed'); assert.equal(server.requests.length, 6);
  assert.match(r.done.error.message, /HTTP 500: boom-3 e+$/);
  assert.ok(r.done.error.message.length < 400);
});

test('interrupt aborts the request and completes the turn as interrupted; the thread keeps working', async t => {
  const {server, host, run, events, wait} = await setup(t);
  server.queue.push((req, res) => sse(res, [chunk({content: 'partial'})], {done: false}));
  const a = await host.thread(sel(), 'sys');
  const {turn} = await host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: 'slow'}]});
  for (let n = 0; n < 200 && !events.some(e => e.method === 'item/agentMessage/delta' && e.params.turnId === turn.id); n++) await new Promise(r => setTimeout(r, 10));
  await host.request('turn/interrupt', {threadId: a.threadId, turnId: turn.id});
  const done = await wait(turn.id);
  assert.equal(done.status, 'interrupted');
  assert.ok(!events.some(e => e.method === 'item/completed' && e.params.turnId === turn.id));
  for (let n = 0; n < 100 && !server.requests[0].closed; n++) await new Promise(r => setTimeout(r, 10));
  assert.ok(server.requests[0].closed);
  assert.equal((await run(a.threadId, 'next')).done.status, 'completed');
  assert.deepEqual(server.requests[1].body.messages, [{role: 'system', content: 'sys'}, {role: 'user', content: 'next'}]);
});

test('the no-data watchdog fails a stalled stream', async t => {
  const {server, host, run} = await setup(t, {options: {watchdogMs: 150}});
  server.queue.push((req, res) => sse(res, [chunk({content: 'start'})], {done: false}));
  const a = await host.thread(sel(), 'sys');
  const r = await run(a.threadId, 'q');
  assert.equal(r.done.status, 'failed'); assert.match(r.done.error.message, /stalled: no data for 150 ms/);
});

test('the API key goes only in the Bearer header, never into receipt, catalog, account or errors', async t => {
  const {server, host, run} = await setup(t);
  server.queue.push(fail(401, `{"error":"invalid key ${KEY}"}`));
  const a = await host.thread(sel(), 'sys');
  const r = await run(a.threadId, 'q');
  assert.equal(server.requests[0].headers.authorization, 'Bearer ' + KEY);
  assert.equal(r.done.status, 'failed'); assert.match(r.done.error.message, /HTTP 401: .*invalid key \[redacted\]/);
  const c = host.catalog();
  for (const blob of [a, c, host.account, r.items, JSON.stringify(host)]) assert.ok(!JSON.stringify(blob).includes(KEY));
  assert.deepEqual(host.account, {type: 'openai-compatible', endpoint: 'fake', baseUrl: new URL(server.url).host});
  assert.deepEqual(c.capabilities, {toolFree: 'by-construction', usageMeter: 'tokens', billing: 'local', structuredOutput: 'prompted', compaction: 'own'});
  assert.equal(c.backend, 'openai:fake');
  assert.deepEqual(c.models, [{id: MODEL, label: MODEL, efforts: ['default'], speeds: [{id: 'standard', label: 'Standard'}], contextTokens: 32768}]);
  const missing = await new OpenAICompatibleHost(endpoint(server.url), {env: {}}).initialize();
  t.after(() => missing.close());
  const ev = []; missing.on('notification', m => ev.push(m));
  const m = await missing.thread(sel(), 'sys');
  await missing.request('turn/start', {threadId: m.threadId, input: [{type: 'text', text: 'q'}]});
  assert.equal(ev.length, 0, 'no notification before turn/start resolves');
  for (let n = 0; n < 100 && !ev.some(e => e.method === 'turn/completed'); n++) await new Promise(r => setTimeout(r, 10));
  assert.match(ev.find(e => e.method === 'turn/completed').params.turn.error.message, /environment variable FAKE_OPENAI_KEY, which is not set/);
});

test('plain http is refused for non-local hosts and configuration errors are clear', () => {
  const base = {name: 'x', baseUrl: 'https://api.example.com/v1', billing: 'per-token', models: [{id: 'm', contextTokens: 8192}]};
  assert.throws(() => new OpenAICompatibleHost({...base, baseUrl: 'http://api.example.com/v1'}), /must use https unless the host is localhost/);
  assert.throws(() => new OpenAICompatibleHost({...base, baseUrl: 'http://10.0.0.5:8000/v1', apiKeyEnv: 'K'}), /must use https/);
  for (const u of ['http://localhost:1234/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:8080/v1', 'https://api.example.com/v1']) assert.ok(new OpenAICompatibleHost({...base, baseUrl: u}));
  assert.throws(() => parseEndpoints([{...base, name: 'Bad Name'}]), /name must match/);
  assert.throws(() => parseEndpoints([{...base, baseUrl: 'ftp://x/v1'}]), /http or https/);
  assert.throws(() => parseEndpoints([{...base, baseUrl: 'https://user:pw@api.example.com'}]), /must not contain credentials/);
  assert.throws(() => parseEndpoints([{...base, models: [{id: 'm', contextTokens: 2048}]}]), /at least 4096/);
  assert.throws(() => parseEndpoints([{...base, models: [{id: 'm', contextTokens: 8192.5}]}]), /integer/);
  assert.throws(() => parseEndpoints([{...base, models: []}]), /non-empty array/);
  assert.throws(() => parseEndpoints([{...base, billing: 'subscription'}]), /billing must be one of/);
  assert.throws(() => parseEndpoints([{...base, headers: {Authorization: 'Bearer k'}}]), /apiKeyEnv/);
  assert.throws(() => parseEndpoints([base, base]), /configured twice/);
  assert.throws(() => parseEndpoints('{nope'), /not valid JSON/);
  assert.throws(() => parseEndpoints({}), /must be an array/);
  const [ok] = parseEndpoints(JSON.stringify([{...base, baseUrl: 'https://api.example.com/v1/', headers: {'HTTP-Referer': 'adhd'}}]));
  assert.equal(ok.baseUrl, 'https://api.example.com/v1'); assert.deepEqual(ok.models[0].efforts, ['default']);
});

test('a different model served by the endpoint fails the turn; local tag suffixes are allowed', async t => {
  // A non-local https endpoint, reached through the fetch override.
  const server = await fakeServer(t);
  const remoteFetch = (url, init) => fetch(String(url).replace('https://api.example.com/v1', server.url), init);
  const remote = await new OpenAICompatibleHost(endpoint('https://api.example.com/v1', {billing: 'per-token'}), {fetch: remoteFetch, env: {FAKE_OPENAI_KEY: KEY}}).initialize();
  t.after(() => remote.close());
  const ev = []; remote.on('notification', m => ev.push(m));
  server.queue.push((req, res) => sse(res, reply('hi', {model: 'qwen3:8b-q4'})));
  const a = await remote.thread(sel(), 'sys');
  const {turn} = await remote.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: 'q'}]});
  for (let n = 0; n < 200 && !ev.some(e => e.method === 'turn/completed'); n++) await new Promise(r => setTimeout(r, 10));
  const done = ev.find(e => e.method === 'turn/completed' && e.params.turn.id === turn.id).params.turn;
  assert.equal(done.status, 'failed'); assert.match(done.error.message, /served a different model: qwen3:8b-q4/);
  assert.equal(server.requests[0].headers.authorization, 'Bearer ' + KEY);
  assert.equal(remote.catalog().capabilities.billing, 'per-token');

  const {host, run} = await setup(t, {url: server.url});
  server.queue.push((req, res) => sse(res, reply('local ok', {model: 'qwen3:8b-q4'})));
  server.queue.push((req, res) => sse(res, reply('nope', {model: 'llama3:70b'})));
  const l = await host.thread(sel(), 'sys');
  assert.equal((await run(l.threadId, 'q')).done.status, 'completed');
  const wrong = await run(l.threadId, 'q2');
  assert.equal(wrong.done.status, 'failed'); assert.match(wrong.done.error.message, /different model: llama3:70b/);
});

test('close aborts in-flight requests and confirms; release ends one thread', async t => {
  const {server, host, events} = await setup(t);
  server.setDefault((req, res) => sse(res, [chunk({content: 'hang'})], {done: false}));
  const a = await host.thread(sel(), 'sys'), b = await host.thread(sel(), 'sys');
  await host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: 'q'}]});
  await host.request('turn/start', {threadId: b.threadId, input: [{type: 'text', text: 'q'}]});
  for (let n = 0; n < 200 && server.requests.length < 2; n++) await new Promise(r => setTimeout(r, 10));
  await host.release(a.threadId);
  await assert.rejects(host.request('turn/start', {threadId: a.threadId, input: [{type: 'text', text: 'x'}]}), /Unknown/);
  assert.deepEqual(await host.close(), {confirmed: true});
  for (let n = 0; n < 100 && !server.requests.every(r => r.closed); n++) await new Promise(r => setTimeout(r, 10));
  assert.ok(server.requests.every(r => r.closed));
  assert.ok(!events.some(e => e.method === 'turn/completed'));
  await assert.rejects(host.thread(sel(), 'sys'), /closed/);
});

test('a failed summary after an earlier compaction drops the old summary alone, keeping roles aligned', async t => {
  const server = await fakeServer(t);
  const {host, run} = await setup(t, {ep: endpoint(server.url, {models: [{id: MODEL, contextTokens: 4096}]})});
  let summaries = 0;
  server.setDefault((req, res, body) => {
    if (body.stream === false) {
      if (++summaries > 1) return fail(500, 'summary down')(req, res);
      res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({model: MODEL, choices: [{message: {content: 'S1'}}]})); return;
    }
    sse(res, reply('ok ' + 'y'.repeat(500)));
  });
  const a = await host.thread(sel(), 'sys');
  for (let n = 1; n <= 5; n++) assert.equal((await run(a.threadId, `round ${n} ` + 'x'.repeat(2500))).done.status, 'completed');
  assert.equal(summaries, 2);
  const roles = server.requests.at(-1).body.messages.map(m => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.ok(!server.requests.at(-1).body.messages.some(m => m.content.startsWith(SUMMARY_PREFIX)));
});

test('a key-less endpoint on the private network may use http; local billing must be on this machine or that network', () => {
  const base = {name: 'lan', billing: 'local', models: [{id: 'm', contextTokens: 8192}]};
  assert.equal(parseEndpoints([{...base, baseUrl: 'http://192.168.1.20:11434/v1'}])[0].baseUrl, 'http://192.168.1.20:11434/v1');
  assert.equal(parseEndpoints([{...base, baseUrl: 'http://gpu-box.local:1234/v1'}]).length, 1);
  assert.throws(() => parseEndpoints([{...base, baseUrl: 'http://192.168.1.20:11434/v1', apiKeyEnv: 'K'}]), /must use https/);
  assert.throws(() => parseEndpoints([{...base, baseUrl: 'http://8.8.8.8/v1'}]), /must use https/);
  assert.throws(() => parseEndpoints([{...base, baseUrl: 'https://api.example.com/v1'}]), /billing 'local' is only for/);
});
