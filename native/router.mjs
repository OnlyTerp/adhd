// Routes each research thread to the host that serves its model: Codex app-server
// for gpt-* models, Claude Code for claude-* models. A run can mix them, for example
// an Opus thinker with a Terra tracker. Hosts are started only when a run needs them.
import {EventEmitter} from 'node:events';
import {CodexClient} from './client.mjs';
import {ClaudeHost, isClaudeModel} from './claude.mjs';
import {processIdentityAsync} from './identity.mjs';

export class HostRouter extends EventEmitter {
  constructor({cwd, codexFactory = o => new CodexClient(o), claudeFactory = o => new ClaudeHost(o)} = {}) {
    super(); this.cwd = cwd; this.codexFactory = codexFactory; this.claudeFactory = claudeFactory;
    this.threads = new Map(); this.closed = false; this.codex = null; this.claude = null;
  }
  // models: the exact model IDs a run will admit. Omitted (catalog), every
  // available host is tried and an unavailable one is reported, not fatal.
  async initialize({models} = {}) {
    const wantClaude = !models || models.some(isClaudeModel), wantCodex = !models || models.some(m => !isClaudeModel(m));
    this.unavailable = {};
    if (wantClaude) {
      try { this.claude = await this.claudeFactory({cwd: this.cwd}).initialize(); this.wire(this.claude, false); }
      catch (e) { this.claude = null; if (models) throw e; this.unavailable.claude = e.message; }
    }
    if (wantCodex) {
      try {
        this.codex = this.codexFactory({cwd: this.cwd}); this.wire(this.codex, true); await this.codex.initialize();
        this.codexIdentity = this.codex.proc?.pid ? await processIdentityAsync(this.codex.proc.pid) : null;
      } catch (e) {
        const c = this.codex; this.codex = null; await c?.close?.().catch(() => {});
        if (models) throw e; this.unavailable.codex = e.message;
      }
    }
    if (!this.codex && !this.claude) throw new Error('No research host is available. Codex: ' + (this.unavailable.codex ?? 'not requested') + '. Claude Code: ' + (this.unavailable.claude ?? 'not requested'));
    this.account = {...(this.codex ? {chatgpt: this.codex.account} : {}), ...(this.claude ? {claude: this.claude.account} : {})};
    return this;
  }
  wire(host, global) {
    host.on('notification', m => this.emit('notification', m));
    host.on('forbiddenRequest', m => this.emit('forbiddenRequest', m));
    // Only the shared Codex app-server can take every Codex thread down at once.
    if (global) host.on('disconnect', e => this.emit('disconnect', e));
  }
  hostFor(modelId) {
    const host = isClaudeModel(modelId) ? this.claude : this.codex;
    if (!host) throw new Error(`${isClaudeModel(modelId) ? 'Claude Code' : 'Codex'} host is unavailable for ${modelId}`);
    return host;
  }
  validate(selection) { return this.hostFor(selection.modelId).validate(selection); }
  catalog() {
    const parts = [this.codex?.catalog(), this.claude?.catalog()].filter(Boolean);
    return {verified: true, source: parts.map(p => p.source).join(' + '), maxThinkers: 4, account: this.account,
      ...(Object.keys(this.unavailable ?? {}).length ? {unavailable: this.unavailable} : {}), models: parts.flatMap(p => p.models)};
  }
  async thread(selection, instructions, cwd, options) {
    const host = this.hostFor(selection.modelId);
    const receipt = await host.thread(selection, instructions, cwd, options);
    this.threads.set(receipt.threadId, host);
    return receipt;
  }
  request(method, params = {}, options) {
    const host = this.threads.get(params.threadId);
    if (!host) return Promise.reject(new Error('Unknown research thread'));
    return host.request(method, params, options);
  }
  async release(threadId) { const host = this.threads.get(threadId); this.threads.delete(threadId); await host?.release?.(threadId); }
  hostIdentity() {
    const members = [...(this.codexIdentity?.status === 'alive' ? [this.codexIdentity] : []), ...(this.claude?.identities() ?? [])];
    return members.length === 0 ? null : members.length === 1 ? members[0] : {members};
  }
  get proc() { return this.codex?.proc; }
  async close() {
    this.closing = true; this.closed = true;
    const results = await Promise.all([this.codex?.close(), this.claude?.close()].filter(Boolean));
    return {confirmed: results.every(r => r?.confirmed === true)};
  }
}
