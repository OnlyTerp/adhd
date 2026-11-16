// Routes each research thread to the backend that serves it (see BACKENDS.md):
// codex (Codex app-server, ChatGPT login), claude (Claude Code CLI, Claude login),
// ACP agent profiles such as devin, and user-configured OpenAI-compatible endpoints
// (openai:<name>). A run can mix them, for example an Opus thinker with a Terra
// tracker. Backends are started only when a run needs them.
import {EventEmitter} from 'node:events';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {CodexClient} from './client.mjs';
import {ClaudeHost} from './claude.mjs';
import {processIdentityAsync} from './identity.mjs';

// Selections made before backends existed name only a model.
export const backendOf = s => s?.backend ?? (typeof s?.modelId === 'string' && s.modelId.startsWith('claude-') ? 'claude' : 'codex');

// Optional OpenAI-compatible endpoints: GOAL_LOOP_ENDPOINTS names a JSON file, else
// <data directory>/endpoints.json. Keys are read from the environment at request time.
export function endpointFile(cwd, env = process.env) {
  if (env.GOAL_LOOP_ENDPOINTS) return env.GOAL_LOOP_ENDPOINTS;
  const f = cwd ? join(cwd, 'endpoints.json') : null;
  return f && existsSync(f) ? f : null;
}

export class HostRouter extends EventEmitter {
  constructor({cwd, env = process.env, codexFactory = o => new CodexClient(o), claudeFactory = o => new ClaudeHost(o), factories = {}} = {}) {
    super(); this.cwd = cwd; this.env = env;
    this.factories = {codex: codexFactory, claude: claudeFactory, ...factories};
    this.hosts = new Map(); this.threads = new Map(); this.closed = false; this.unavailable = {};
  }
  // Every backend this installation could offer. ACP profiles and endpoints load lazily.
  async known() {
    const ids = Object.keys(this.factories);
    const {ACP_PROFILES, AcpHost} = await import('./acp.mjs');
    for (const p of ACP_PROFILES) if (!this.factories[p.id]) { this.factories[p.id] = o => new AcpHost({...o, profile: p.id}); ids.push(p.id); }
    const file = endpointFile(this.cwd, this.env);
    if (file) {
      const {parseEndpoints, OpenAICompatibleHost} = await import('./openai.mjs');
      // A broken endpoints file disables only the endpoints, never the other backends.
      let list = [];
      try { list = parseEndpoints(readFileSync(file, 'utf8')); delete this.unavailable.endpoints; }
      catch (e) { this.unavailable.endpoints = `${file}: ${e.code === 'ENOENT' ? 'file not found' : e.message}`; }
      for (const e of list) {
        const id = 'openai:' + e.name;
        if (!this.factories[id]) { this.factories[id] = o => new OpenAICompatibleHost({...o, endpoint: e}); ids.push(id); }
      }
    }
    return [...new Set(ids)];
  }
  // backends: the backend IDs a run will use; each must start. Omitted (catalog), every
  // known backend is tried and an unavailable one is reported, not fatal.
  // models: legacy form, mapped to backends by model ID.
  async initialize({backends, models} = {}) {
    const wanted = backends ?? models?.map(m => backendOf({modelId: m}));
    const strict = Boolean(wanted);
    const ids = wanted ? [...new Set(wanted)] : await this.known();
    if (wanted && ids.some(id => !this.factories[id])) await this.known();
    for (const id of ids) {
      let host = null;
      try {
        const factory = this.factories[id];
        if (!factory) throw new Error(`Unknown backend ${id}.` + (id.startsWith('openai:') && this.unavailable.endpoints ? ` Endpoints are unavailable: ${this.unavailable.endpoints}.` : '') + ' Read goal_loop_catalog for the backends this installation offers.');
        host = factory({cwd: this.cwd});
        this.wire(host, id === 'codex');
        await host.initialize();
        if (id === 'codex') this.codexIdentity = host.proc?.pid ? await processIdentityAsync(host.proc.pid) : null;
        this.hosts.set(id, host);
      } catch (e) {
        await host?.close?.().catch(() => {});
        if (strict) throw e;
        this.unavailable[id] = e.message;
      }
    }
    if (!this.hosts.size) throw new Error('No research backend is available. ' + Object.entries(this.unavailable).map(([k, v]) => `${k}: ${v}`).join('. '));
    this.account = Object.fromEntries([...this.hosts].map(([id, h]) => [id, h.account]));
    return this;
  }
  get codex() { return this.hosts.get('codex') ?? null; }
  get claude() { return this.hosts.get('claude') ?? null; }
  wire(host, global) {
    host.on('notification', m => this.emit('notification', m));
    host.on('forbiddenRequest', m => this.emit('forbiddenRequest', m));
    // Only the shared Codex app-server can take every Codex thread down at once.
    if (global) host.on('disconnect', e => this.emit('disconnect', e));
  }
  hostFor(selection) {
    const id = backendOf(selection), host = this.hosts.get(id);
    if (!host) throw new Error(`Backend ${id} is unavailable for ${selection?.modelId}` + (this.unavailable[id] ? ': ' + this.unavailable[id] : ''));
    return host;
  }
  validate(selection) { return this.hostFor(selection).validate(selection); }
  // Declared capabilities of one backend (see BACKENDS.md), or {} when it declares none.
  capabilities(backend) { return this.hosts.get(backend)?.catalog?.().capabilities ?? {}; }
  catalog() {
    const backends = [...this.hosts].map(([id, h]) => {
      const c = h.catalog();
      return {id, source: c.source, account: c.account ?? h.account, capabilities: c.capabilities ?? {}, models: (c.models ?? []).map(m => ({...m, backend: id}))};
    });
    return {verified: true, source: backends.map(b => b.id + ': ' + b.source).join(' + '), maxThinkers: 4, account: this.account,
      backends: backends.map(({models, ...b}) => b),
      ...(Object.keys(this.unavailable).length ? {unavailable: this.unavailable} : {}), models: backends.flatMap(b => b.models)};
  }
  async thread(selection, instructions, cwd, options) {
    const host = this.hostFor(selection);
    const receipt = await host.thread(selection, instructions, cwd, options);
    this.threads.set(receipt.threadId, host);
    return {...receipt, backend: backendOf(selection)};
  }
  request(method, params = {}, options) {
    const host = this.threads.get(params.threadId);
    if (!host) return Promise.reject(new Error('Unknown research thread'));
    return host.request(method, params, options);
  }
  async release(threadId) { const host = this.threads.get(threadId); this.threads.delete(threadId); await host?.release?.(threadId); }
  hostIdentity() {
    const members = [...(this.codexIdentity?.status === 'alive' ? [this.codexIdentity] : [])];
    for (const [id, h] of this.hosts) if (id !== 'codex') members.push(...(h.identities?.() ?? []));
    return members.length === 0 ? null : members.length === 1 ? members[0] : {members};
  }
  // Free read of the ChatGPT plan's usage pools; null when no Codex host runs.
  async rateLimits() { return this.codex ? this.codex.request('account/rateLimits/read', {}, {timeoutMs: 10000}) : null; }
  get proc() { return this.codex?.proc; }
  async close() {
    this.closing = true; this.closed = true;
    const results = await Promise.all([...this.hosts.values()].map(h => h.close()));
    return {confirmed: results.every(r => r?.confirmed === true)};
  }
}
