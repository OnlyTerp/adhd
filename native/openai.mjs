// OpenAI-compatible host: runs thinkers/trackers against any /v1/chat/completions
// endpoint (Ollama, LM Studio, vLLM, llama.cpp server, OpenRouter, gateways). The API
// is stateless HTTP, so this adapter keeps each thread's conversation itself as an
// append-only message list (byte-stable prefix, so provider prompt caching works),
// compacts it when it nears the context window, and never sends tools. Events are
// translated into the notification shape described in BACKENDS.md.
import {extractJson} from './json.mjs';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const BILLING = ['local', 'free', 'per-token'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const COMPACT_AT = 0.75, SUMMARY_SHARE = 0.15, KEEP_PAIRS = 2, BODY_LIMIT = 300;
export const SUMMARY_PREFIX = 'Summary of earlier rounds (compacted):\n';
export const SUMMARY_ACK = 'Noted. I will continue from this summary.';
export const SCHEMA_SUFFIX = '\n\nReply with only one JSON object matching this JSON Schema, no prose and no code fence: ';
const SPEEDS = [{id: 'standard', label: 'Standard'}];

export const estimateTokens = messages => Math.ceil(messages.reduce((n, m) => n + Buffer.byteLength(m.content ?? '', 'utf8'), 0) / 3.5);
const isLocalHost = hostname => LOCAL_HOSTS.has(hostname);
// This machine or the home/office network (another PC running Ollama, LM Studio, vLLM).
const isPrivateHost = h => isLocalHost(h) || /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(h) || /\.(local|lan|home\.arpa)$/.test(h);
const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseEndpoint(e, where) {
  if (!plainObject(e)) throw new Error(`${where}: an endpoint must be an object`);
  if (typeof e.name !== 'string' || !NAME.test(e.name)) throw new Error(`${where}: name must match ${NAME} (lowercase letters, digits and dashes, at most 32 characters)`);
  const at = `endpoint ${e.name}`;
  if (typeof e.baseUrl !== 'string') throw new Error(`${at}: baseUrl must be a string such as http://127.0.0.1:11434/v1`);
  let url; try { url = new URL(e.baseUrl); } catch { throw new Error(`${at}: baseUrl is not a valid URL`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${at}: baseUrl must use http or https`);
  if (url.username || url.password) throw new Error(`${at}: baseUrl must not contain credentials; name an environment variable in apiKeyEnv`);
  if (url.protocol !== 'https:' && !isLocalHost(url.hostname) && !(isPrivateHost(url.hostname) && e.apiKeyEnv === undefined))
    throw new Error(`${at}: baseUrl must use https unless the host is localhost, 127.0.0.1 or [::1], or a private network address with no apiKeyEnv (an API key must not travel over plain http)`);
  if (e.apiKeyEnv !== undefined && (typeof e.apiKeyEnv !== 'string' || !ENV_NAME.test(e.apiKeyEnv))) throw new Error(`${at}: apiKeyEnv must be an environment variable name`);
  if (!BILLING.includes(e.billing)) throw new Error(`${at}: billing must be one of ${BILLING.join(', ')}`);
  if (e.billing === 'local' && !isPrivateHost(url.hostname)) throw new Error(`${at}: billing 'local' is only for this machine or a private network address; a hosted endpoint is 'free' or 'per-token'`);
  if (!Array.isArray(e.models) || e.models.length === 0) throw new Error(`${at}: models must be a non-empty array`);
  const ids = new Set();
  const models = e.models.map((m, i) => {
    if (!plainObject(m)) throw new Error(`${at}: models[${i}] must be an object`);
    if (typeof m.id !== 'string' || !m.id.trim() || m.id.trim() !== m.id) throw new Error(`${at}: models[${i}].id must be a non-empty string without surrounding spaces`);
    if (ids.has(m.id)) throw new Error(`${at}: model ${m.id} is listed twice`);
    ids.add(m.id);
    if (m.label !== undefined && (typeof m.label !== 'string' || !m.label.trim())) throw new Error(`${at}: model ${m.id}: label must be a non-empty string`);
    if (!Number.isInteger(m.contextTokens) || m.contextTokens < 4096) throw new Error(`${at}: model ${m.id}: contextTokens must be an integer of at least 4096`);
    if (m.efforts !== undefined && (!Array.isArray(m.efforts) || m.efforts.length === 0 || m.efforts.some(x => typeof x !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(x)) || new Set(m.efforts).size !== m.efforts.length))
      throw new Error(`${at}: model ${m.id}: efforts must be a non-empty array of distinct effort names such as "high" or "default"`);
    return {id: m.id, label: m.label ?? m.id, contextTokens: m.contextTokens, efforts: [...(m.efforts ?? ['default'])]};
  });
  let headers = {};
  if (e.headers !== undefined) {
    if (!plainObject(e.headers)) throw new Error(`${at}: headers must be an object of header names to string values`);
    for (const [k, v] of Object.entries(e.headers)) {
      if (!HEADER_NAME.test(k)) throw new Error(`${at}: invalid header name ${JSON.stringify(k)}`);
      if (typeof v !== 'string' || /[\r\n]/.test(v)) throw new Error(`${at}: header ${k} must be a single-line string`);
      if (/^(authorization|proxy-authorization|content-type|content-length|host)$/i.test(k)) throw new Error(`${at}: header ${k} is set by the adapter; put the API key's variable name in apiKeyEnv`);
    }
    headers = {...e.headers};
  }
  return {name: e.name, baseUrl: e.baseUrl.replace(/\/+$/, ''), ...(e.apiKeyEnv ? {apiKeyEnv: e.apiKeyEnv} : {}), models, billing: e.billing, headers};
}

// Validates a JSON string or array of endpoint configurations; throws a clear Error.
export function parseEndpoints(json) {
  let list = json;
  if (typeof json === 'string') { try { list = JSON.parse(json); } catch { throw new Error('OpenAI-compatible endpoints: configuration is not valid JSON'); } }
  if (!Array.isArray(list)) throw new Error('OpenAI-compatible endpoints: configuration must be an array of endpoints');
  const names = new Set();
  return list.map((e, i) => {
    const ep = parseEndpoint(e, `endpoints[${i}]`);
    if (names.has(ep.name)) throw new Error(`endpoint ${ep.name} is configured twice`);
    names.add(ep.name); return ep;
  });
}

const redactWith = key => text => key ? String(text).split(key).join('[redacted]') : String(text);

// Sleeps, waking early (rejected) when the signal aborts.
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const done = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, ms);
    signal.addEventListener('abort', done, {once: true});
  });
}

class TurnFailure extends Error {}

class OpenAIThread {
  constructor(host, {selection, instructions, outputSchema}) {
    this.host = host; this.id = 'openai-' + randomUUID();
    this.model = host.endpoint.models.find(m => m.id === selection.modelId);
    this.effort = selection.reasoning;
    this.schema = outputSchema ? JSON.stringify(outputSchema) : null;
    this.messages = [{role: 'system', content: String(instructions ?? '')}];
    this.turn = null; this.closed = false; this.released = false; this.useResponseFormat = true;
  }
  notify(turnId, method, params = {}) { this.host.emit('notification', {method, params: {threadId: this.id, turnId, ...params}}); }
  start(text, outputSchema) {
    if (this.closed) throw new Error('OpenAI-compatible thread is closed');
    if (this.turn) throw new Error('Concurrent turn on one OpenAI-compatible thread');
    if ((outputSchema ? JSON.stringify(outputSchema) : null) !== this.schema) throw new Error('An OpenAI-compatible thread fixes its output schema when admitted');
    const id = randomUUID();
    const t = this.turn = {id, controller: new AbortController(), reason: null, error: null};
    // Start after the current tick so no notification precedes the caller learning the turn id.
    t.done = new Promise(r => setImmediate(r)).then(() => this.run(t, text)).catch(() => {}).finally(() => { if (this.turn === t) this.turn = null; });
    return {turn: {id, status: 'inProgress'}};
  }
  abort(t, reason) { if (!t.reason) t.reason = reason; t.controller.abort(reason); }
  interrupt(turnId) { const t = this.turn; if (t && t.id === turnId && !this.closed) this.abort(t, 'interrupt'); return {}; }
  stop() { this.closed = true; const t = this.turn; if (t) this.abort(t, 'close'); return t?.done ?? Promise.resolve(); }

  async run(t, text) {
    const host = this.host, usage = {sum: null};
    let key = null, status = 'completed', error = null, answer = null, history = null, user = null;
    try {
      key = host.apiKey();
      user = {role: 'user', content: text + (this.schema ? SCHEMA_SUFFIX + this.schema : '')};
      history = await this.fit(t, user, key, usage);
      answer = this.finish(await this.stream(t, [...history, user], key, usage));
    } catch (e) {
      if (t.reason === 'interrupt') status = 'interrupted';
      else { status = 'failed'; error = redactWith(key)(e instanceof TurnFailure ? e.message : `Endpoint ${host.endpoint.name} request failed: ${describe(e)}`); }
    }
    if (t.reason === 'interrupt') status = 'interrupted';
    // Only a completed turn joins the thread's history; earlier messages never change.
    if (status === 'completed') this.messages = [...history, user, {role: 'assistant', content: answer}];
    if (this.turn === t) this.turn = null;
    // An owned shutdown or release settles outstanding turns in the runtime itself.
    if (t.reason === 'close' || this.released || host.closing) return;
    if (status === 'completed') this.notify(t.id, 'item/completed', {item: {type: 'agentMessage', id: `${t.id}:1`, text: answer}});
    if (usage.sum) this.notify(t.id, 'thread/tokenUsage/updated', {tokenUsage: {last: usage.sum}});
    this.notify(t.id, 'turn/completed', {turn: {id: t.id, status, ...(error ? {error: {message: error}} : {})}});
  }

  // Returns the history to send before the new user message, compacting it first
  // when the request would pass 75% of the model's context window.
  async fit(t, user, key, usage) {
    const ctx = this.model.contextTokens, history = this.messages;
    if (estimateTokens([...history, user]) <= COMPACT_AT * ctx) return history;
    const system = history[0];
    const floor = estimateTokens([system, user]);
    if (floor > ctx) throw new TurnFailure(`The instructions and the new message alone (about ${floor} tokens) exceed the ${ctx}-token context window of ${this.model.id}`);
    const kept = history.slice(Math.max(1, history.length - 2 * KEEP_PAIRS));
    const middle = history.slice(1, history.length - kept.length);
    let next = history;
    if (middle.length) {
      let summary = null;
      try { summary = await this.summarize(t, middle, key, usage); } catch (e) { if (t.reason) throw e; }
      if (summary) next = [system, {role: 'user', content: SUMMARY_PREFIX + summary}, {role: 'assistant', content: SUMMARY_ACK}, ...kept];
      else {
        // The summary failed: drop the oldest rounds until the request fits.
        // A summary left by an earlier compaction is one message; every other round is a pair.
        let rest = middle;
        while (rest.length && estimateTokens([system, ...rest, ...kept, user]) > COMPACT_AT * ctx) rest = rest.slice(2);
        next = [system, ...rest, ...kept];
      }
    }
    // Still too large: give up verbatim rounds, oldest first, before failing.
    while (next.length > 1 && estimateTokens([...next, user]) > ctx) {
      const summarized = next[1].role === 'user' && next[1].content.startsWith(SUMMARY_PREFIX);
      next = summarized && next.length > 3 ? [system, next[1], next[2], ...next.slice(5)] : [system, ...next.slice(3)];
    }
    if (estimateTokens([...next, user]) > ctx) throw new TurnFailure(`The conversation does not fit the ${ctx}-token context window of ${this.model.id}`);
    if (next !== history) { this.messages = next; this.notify(t.id, 'item/completed', {item: {type: 'contextCompaction', id: `${t.id}:compact`}}); }
    return next;
  }

  async summarize(t, dropped, key, usage) {
    const host = this.host, ctx = this.model.contextTokens, budget = Math.floor(SUMMARY_SHARE * ctx);
    const transcript = dropped.map(m => `[${m.role}]\n${m.content}`).join('\n\n');
    const prompt = [
      {role: 'system', content: 'You compress the history of a research conversation so the work can continue without it.'},
      {role: 'user', content: `Summarize the conversation below faithfully. Keep every finding, number, decision, correction and open question; drop repetition. Stay under ${budget} tokens. Reply with the summary only.\n\n<history>\n${transcript}\n</history>`},
    ];
    if (estimateTokens(prompt) > 0.9 * ctx) return null;
    const timeout = AbortSignal.timeout(host.summaryTimeoutMs);
    const res = await host.post(this.body(prompt, {stream: false}), key, AbortSignal.any([t.controller.signal, timeout]));
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
    const json = await res.json();
    if (json?.model && !this.sameModel(json.model)) return null;
    const summary = json?.choices?.[0]?.message?.content;
    if (typeof summary !== 'string' || !summary.trim()) return null;
    if (json.usage) usage.sum = addUsage(usage.sum, json.usage);
    return summary.trim();
  }

  body(messages, {stream = true, responseFormat = false} = {}) {
    return {model: this.model.id, messages, stream, ...(stream ? {stream_options: {include_usage: true}} : {}),
      ...(this.effort !== 'default' ? {reasoning_effort: this.effort} : {}),
      ...(responseFormat ? {response_format: {type: 'json_object'}} : {})};
  }

  sameModel(echoed) {
    const want = this.model.id;
    if (echoed === want) return true;
    // Hosted gateways echo a dated version (gpt-x -> gpt-x-2026-01-01) or a provider prefix (vendor/gpt-x).
    if (echoed.startsWith(want) && /^-\d{4}-?\d{2}-?\d{2}$/.test(echoed.slice(want.length))) return true;
    if (echoed.endsWith('/' + want)) return true;
    return this.host.local && (echoed.startsWith(want) || echoed.endsWith(want) || want.startsWith(echoed) || want.endsWith(echoed));
  }

  // Sends the turn with retries (429/5xx) and the response_format fallback, then
  // reads the SSE stream. Returns the visible text.
  async stream(t, messages, key, usage) {
    const host = this.host, name = host.endpoint.name, signal = t.controller.signal;
    let retries = 0, res;
    for (;;) {
      const withFormat = Boolean(this.schema && this.useResponseFormat);
      res = await this.watched(t, () => host.post(this.body(messages, {responseFormat: withFormat}), key, signal), host.firstByteMs);
      if (res.ok) break;
      const body = await this.watched(t, () => res.text()).catch(() => '');
      if (res.status === 400 && withFormat && /response_format/i.test(body)) { this.useResponseFormat = false; continue; }
      if ((res.status === 429 || res.status >= 500) && retries < host.retryDelaysMs.length) { await pause(host.retryDelaysMs[retries++], signal); continue; }
      throw new TurnFailure(`Endpoint ${name} returned HTTP ${res.status}: ${redactWith(key)(body).slice(0, BODY_LIMIT)}`);
    }
    let text = '', finished = false, buffer = '', streamUsage = null;
    const decoder = new TextDecoder();
    const handle = data => {
      if (data === '[DONE]') { finished = true; return; }
      let chunk; try { chunk = JSON.parse(data); } catch { throw new TurnFailure(`Endpoint ${name} sent a malformed stream chunk`); }
      if (chunk?.error) throw new TurnFailure(`Endpoint ${name} reported an error: ${String(chunk.error.message ?? JSON.stringify(chunk.error)).slice(0, BODY_LIMIT)}`);
      if (typeof chunk?.model === 'string' && chunk.model && !this.sameModel(chunk.model)) {
        this.abort(t, 'model'); throw new TurnFailure(`Endpoint ${name} served a different model: ${chunk.model}, not the requested ${this.model.id}`);
      }
      const choice = chunk?.choices?.[0], delta = choice?.delta ?? {};
      const calls = [...(Array.isArray(delta.tool_calls) ? delta.tool_calls : []), ...(delta.function_call ? [{function: delta.function_call}] : [])];
      if (calls.length || choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call') {
        const names = calls.map(c => c?.function?.name).filter(Boolean);
        host.emit('forbiddenRequest', {method: 'tool_calls:' + (names.join(',') || 'unknown'), threadId: this.id});
        this.abort(t, 'forbidden');
        throw new TurnFailure(`Research tool boundary crossed: the model asked to call ${names.join(', ') || 'a tool'}`);
      }
      // delta.reasoning_content / delta.reasoning are hidden reasoning: never published.
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        if (!this.schema) this.notify(t.id, 'item/agentMessage/delta', {itemId: `${t.id}:1`, delta: delta.content});
      }
      if (choice?.finish_reason) finished = true;
      if (chunk?.usage) streamUsage = chunk.usage; // the last usage chunk wins (some endpoints repeat it)
    };
    const reader = res.body.getReader();
    let clean = false;
    try {
      for (;;) {
        const {value, done} = await this.watched(t, () => reader.read());
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (line.startsWith('data:')) handle(line.slice(5).trim());
        }
      }
      buffer += decoder.decode();
      if (buffer.startsWith('data:')) handle(buffer.slice(5).trim());
      clean = true;
    } finally { if (!clean) reader.cancel().catch(() => {}); }
    if (streamUsage) usage.sum = addUsage(usage.sum, streamUsage);
    if (!finished) throw new TurnFailure(`Endpoint ${name} closed the stream before the answer finished`);
    return text;
  }

  // Runs one step of a request under the no-data watchdog: a step that brings no
  // data within watchdogMs aborts the request as stalled.
  async watched(t, step, ms = this.host.watchdogMs) {
    const host = this.host;
    const timer = setTimeout(() => this.abort(t, 'stall'), ms);
    try { return await step(); }
    catch (e) {
      if (t.reason === 'stall') throw new TurnFailure(`Endpoint ${host.endpoint.name} stalled: no data for ${ms} ms`);
      throw e;
    } finally { clearTimeout(timer); }
  }

  finish(raw) {
    if (!this.schema) {
      if (!raw.trim()) throw new TurnFailure(`Endpoint ${this.host.endpoint.name} returned no visible answer`);
      return raw;
    }
    const parsed = extractJson(raw);
    if (!plainObject(parsed)) throw new TurnFailure('Endpoint returned no valid JSON');
    return JSON.stringify(parsed);
  }
}

function addUsage(sum, u) {
  const n = v => (Number.isFinite(v) ? v : 0);
  const next = {inputTokens: n(u.prompt_tokens), cachedInputTokens: n(u.prompt_tokens_details?.cached_tokens), cacheWriteInputTokens: 0,
    outputTokens: n(u.completion_tokens), reasoningOutputTokens: n(u.completion_tokens_details?.reasoning_tokens)};
  if (!sum) return next;
  for (const k of Object.keys(next)) next[k] += sum[k];
  return next;
}

function describe(e) {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'request aborted';
  const cause = e?.cause ? ` (${e.cause.code ?? e.cause.message ?? e.cause})` : '';
  return String(e?.message ?? e) + cause;
}

export class OpenAICompatibleHost extends EventEmitter {
  // new OpenAICompatibleHost(endpoint, {fetch, env, watchdogMs, retryDelaysMs, summaryTimeoutMs})
  // or new OpenAICompatibleHost({endpoint, fetch, ...}) for router factories.
  constructor(endpoint, options = {}) {
    super();
    if (plainObject(endpoint) && endpoint.endpoint && endpoint.name === undefined) ({endpoint, ...options} = endpoint);
    const {fetch: fetchImpl = globalThis.fetch, env = process.env, watchdogMs = 30000, firstByteMs = 300000, retryDelaysMs = [2000, 6000], summaryTimeoutMs = 180000} = options;
    [this.endpoint] = parseEndpoints([endpoint]);
    this.backend = this.id = 'openai:' + this.endpoint.name;
    const url = new URL(this.endpoint.baseUrl);
    this.local = isLocalHost(url.hostname); this.urlHost = url.host;
    this.watchdogMs = watchdogMs; this.firstByteMs = Math.max(firstByteMs, watchdogMs); this.retryDelaysMs = retryDelaysMs; this.summaryTimeoutMs = summaryTimeoutMs;
    // The environment (holding the key) and fetch stay off enumerable fields.
    Object.defineProperty(this, 'env', {value: env, enumerable: false});
    Object.defineProperty(this, 'fetchImpl', {value: fetchImpl, enumerable: false});
    this.threads = new Map(); this.closed = false;
  }
  async initialize() {
    if (typeof this.fetchImpl !== 'function') throw new Error('This Node.js has no fetch; OpenAI-compatible endpoints need Node 18 or later');
    this.account = {type: 'openai-compatible', endpoint: this.endpoint.name, baseUrl: this.urlHost};
    return this;
  }
  // Read at request time only; never stored.
  apiKey() {
    const n = this.endpoint.apiKeyEnv; if (!n) return null;
    const v = this.env[n];
    if (typeof v !== 'string' || !v) throw new Error(`Endpoint ${this.endpoint.name} needs its API key in the environment variable ${n}, which is not set`);
    return v;
  }
  post(body, key, signal) {
    const headers = {...this.endpoint.headers, 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json', ...(key ? {authorization: 'Bearer ' + key} : {})};
    return this.fetchImpl(this.endpoint.baseUrl + '/chat/completions', {method: 'POST', headers, body: JSON.stringify(body), signal});
  }
  validate(selection) {
    const name = this.endpoint.name;
    if (selection.backend !== undefined && selection.backend !== this.id) throw new Error(`Selection backend ${selection.backend} is not ${this.id}`);
    const m = this.endpoint.models.find(x => x.id === selection.modelId);
    if (!m) throw new Error(`Endpoint ${name} does not offer model ${selection.modelId}`);
    if (!m.efforts.includes(selection.reasoning)) throw new Error(`Endpoint ${name} model ${m.id} offers reasoning ${m.efforts.join(', ')}, not ${selection.reasoning}`);
    if (selection.speedId !== 'standard') throw new Error(`Requested speed is unavailable for ${selection.modelId}: ${selection.speedId}`);
    return selection;
  }
  catalog() {
    return {verified: true, source: `OpenAI-compatible endpoint ${this.endpoint.name} (${this.urlHost}); models from configuration, the model the endpoint echoes is checked per response`,
      backend: this.id, account: this.account,
      capabilities: {toolFree: 'by-construction', usageMeter: 'tokens', billing: this.endpoint.billing, structuredOutput: 'prompted', compaction: 'own'},
      models: this.endpoint.models.map(m => ({id: m.id, label: m.label, efforts: [...m.efforts], speeds: SPEEDS.map(s => ({...s})), contextTokens: m.contextTokens}))};
  }
  async thread(selection, instructions, cwd, {outputSchema} = {}) {
    if (this.closed) throw new Error('OpenAI-compatible host is closed');
    this.validate(selection);
    const t = new OpenAIThread(this, {selection, instructions, outputSchema});
    this.threads.set(t.id, t);
    return {threadId: t.id, model: t.model.id, modelProvider: this.id, serviceTier: 'standard', reasoningEffort: selection.reasoning, environmentAccess: false,
      attestation: 'Plain chat-completions request with no tools; model echoed by the endpoint is checked per response'};
  }
  request(method, params = {}) {
    try {
      const t = this.threads.get(params.threadId); if (!t) throw new Error('Unknown OpenAI-compatible thread');
      if (method === 'turn/start') {
        const text = (params.input ?? []).filter(i => i.type === 'text').map(i => i.text).join('\n');
        return Promise.resolve(t.start(text, params.outputSchema));
      }
      if (method === 'turn/interrupt') return Promise.resolve(t.interrupt(params.turnId));
      throw new Error('Unsupported OpenAI-compatible host request: ' + method);
    } catch (e) { return Promise.reject(e); }
  }
  identities() { return []; }
  async release(threadId) {
    const t = this.threads.get(threadId); if (!t) return;
    t.released = true; this.threads.delete(threadId); await t.stop();
  }
  async close() {
    this.closing = true; this.closed = true;
    const all = [...this.threads.values()]; this.threads.clear();
    const settled = Promise.all(all.map(t => t.stop())).then(() => true);
    let timer; const deadline = new Promise(r => { timer = setTimeout(() => r(false), 5000); });
    const confirmed = await Promise.race([settled, deadline]); clearTimeout(timer);
    return {confirmed};
  }
}
