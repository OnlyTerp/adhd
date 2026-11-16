// Claude Code host: runs Claude thinkers/trackers through the installed Claude Code
// CLI and the user's existing subscription login. Each research thread is one
// long-lived `claude -p` process speaking stream-json, with every tool, MCP server,
// setting source and slash command disabled. Events are translated into the same
// notification shape the Codex app-server emits, so the runtime treats both alike.
import {spawn, spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {processIdentityAsync} from './identity.mjs';

export const CLAUDE_MODELS = [
  {id: 'claude-opus-5-5', label: 'Claude Opus 5.5'},
  {id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5'},
];
export const isClaudeModel = id => typeof id === 'string' && id.startsWith('claude-');

const FRAME_LIMIT = 8 * 1024 * 1024;
// Credentials and provider switches that would move billing off the subscription
// login, plus variables a parent Claude Code session leaks into its children.
const BILLING_VARS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_BEDROCK_BASE_URL|ANTHROPIC_VERTEX_BASE_URL|ANTHROPIC_VERTEX_PROJECT_ID|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/;
const PARENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_SESSION_ID)$/;

export function discoverClaude() {
  if (process.env.GOAL_LOOP_CLAUDE_EXE) return process.env.GOAL_LOOP_CLAUDE_EXE;
  if (process.platform !== 'win32') return 'claude';
  const found = spawnSync('where.exe', ['claude'], {encoding: 'utf8', windowsHide: true, timeout: 4000});
  for (const line of (found.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    if (/\.exe$/i.test(line) && existsSync(line)) return line;
    if (/\.cmd$/i.test(line)) {
      const exe = join(dirname(line), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error('Install Claude Code or set GOAL_LOOP_CLAUDE_EXE to its claude executable.');
}

export function childEnvironment(env = process.env, allowApiKey = env.GOAL_LOOP_CLAUDE_ALLOW_API_KEY === '1') {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (PARENT_VARS.test(k)) continue;
    if (!allowApiKey && BILLING_VARS.test(k)) continue;
    out[k] = v;
  }
  return out;
}

class ClaudeThread {
  constructor(host, {selection, instructions, cwd, outputSchema}) {
    this.host = host; this.selection = selection; this.id = 'claude-' + randomUUID();
    this.schema = outputSchema ? JSON.stringify(outputSchema) : null;
    this.turn = null; this.closed = false; this.released = false; this.init = null; this.stderr = '';
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--model', selection.modelId, '--effort', 'max', '--tools', '',
      '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence',
      '--system-prompt', instructions, ...(this.schema ? ['--json-schema', this.schema] : [])];
    this.proc = spawn(host.exe, [...host.exeArgs, ...args], {cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: host.env});
    const decoder = new StringDecoder('utf8'); let buffer = '';
    this.proc.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    this.proc.stdin.on('error', () => {});
    this.proc.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > FRAME_LIMIT) return this.dead(new Error('Claude frame limit exceeded'));
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { return this.dead(new Error('Malformed Claude frame')); }
        this.handle(msg);
      }
    });
    this.proc.once('error', e => this.dead(e));
    this.proc.once('close', (code, signal) => this.dead(new Error(`Claude process exited (${code ?? signal})${this.stderr ? ': ' + this.stderr.trim().split('\n').pop() : ''}`)));
  }
  write(msg) { if (this.closed) throw new Error('Claude thread is closed'); this.proc.stdin.write(JSON.stringify(msg) + '\n'); }
  notify(turnId, method, params = {}) { this.host.emit('notification', {method, params: {threadId: this.id, turnId, ...params}}); }
  start(text, outputSchema) {
    if (this.closed) throw new Error('Claude thread is closed');
    if (this.turn) throw new Error('Concurrent turn on one Claude thread');
    if ((outputSchema ? JSON.stringify(outputSchema) : null) !== this.schema) throw new Error('A Claude thread fixes its output schema when admitted');
    const id = randomUUID();
    this.turn = {id, items: 0, current: null, interrupted: false, error: null};
    this.write({type: 'user', message: {role: 'user', content: [{type: 'text', text}]}});
    return {turn: {id, status: 'inProgress'}};
  }
  interrupt(turnId) {
    const t = this.turn; if (!t || t.id !== turnId || this.closed) return {};
    t.interrupted = true;
    this.write({type: 'control_request', request_id: randomUUID(), request: {subtype: 'interrupt'}});
    return {};
  }
  // The model, credential source and tool list are attested by the CLI's init
  // message, which it emits at the start of every turn.
  checkInit(m) {
    if (m.model !== this.selection.modelId) return `Claude Code admitted ${m.model}, not the requested ${this.selection.modelId}`;
    if (!this.host.allowApiKey && m.apiKeySource !== 'none') return `Claude Code used ${m.apiKeySource}; only the subscription login is allowed`;
    const tools = Array.isArray(m.tools) ? m.tools : ['unknown'];
    const allowed = this.schema ? tools.every(t => t === 'StructuredOutput') && tools.length <= 1 : tools.length === 0;
    if (!allowed) return 'Claude Code exposed tools to a research worker: ' + tools.join(', ');
    if ((m.mcp_servers ?? []).length) return 'Claude Code connected MCP servers to a research worker';
    return null;
  }
  handle(m) {
    const t = this.turn;
    if (m.type === 'system' && m.subtype === 'init') {
      this.init = {model: m.model, apiKeySource: m.apiKeySource, tools: m.tools ?? [], mcpServers: (m.mcp_servers ?? []).length, permissionMode: m.permissionMode};
      const problem = this.checkInit(m);
      if (problem && t) { t.error = problem; this.interrupt(t.id); }
      return;
    }
    if (!t) return;
    if (m.type === 'stream_event') {
      const e = m.event ?? {};
      if (e.type === 'content_block_start') {
        const b = e.content_block ?? {};
        if (b.type === 'tool_use' && !(this.schema && b.name === 'StructuredOutput')) {
          this.host.emit('forbiddenRequest', {method: 'tool_use:' + b.name, threadId: this.id});
          t.error = 'Research tool boundary crossed: ' + b.name; this.interrupt(t.id);
        }
        if (b.type === 'text' && !this.schema) t.current = `${t.id}:${++t.items}`;
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && !this.schema && t.current) {
        this.notify(t.id, 'item/agentMessage/delta', {itemId: t.current, delta: e.delta.text ?? ''});
      }
      return;
    }
    // With partial messages on, each completed content block arrives as its own
    // assistant message. Only text blocks are published; thinking never is.
    if (m.type === 'assistant' && !this.schema) {
      for (const c of m.message?.content ?? []) if (c.type === 'text') {
        const id = t.current ?? `${t.id}:${++t.items}`; t.current = null;
        this.notify(t.id, 'item/completed', {item: {type: 'agentMessage', id, text: c.text ?? ''}});
      }
      return;
    }
    if (m.type === 'result') {
      this.turn = null; let status, error = null;
      if (t.error) { status = 'failed'; error = t.error; }
      else if (t.interrupted) status = 'interrupted';
      else if (m.subtype === 'success' && !m.is_error) {
        status = 'completed';
        if (this.schema) {
          if (m.structured_output === undefined || m.structured_output === null) { status = 'failed'; error = 'Claude returned no structured output'; }
          else this.notify(t.id, 'item/completed', {item: {type: 'agentMessage', id: `${t.id}:structured`, text: JSON.stringify(m.structured_output)}});
        }
      } else { status = 'failed'; error = String(m.result || (Array.isArray(m.errors) && m.errors.join('; ')) || m.subtype || 'Claude turn failed'); }
      this.lastUsage = m.usage ? {inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens, cacheRead: m.usage.cache_read_input_tokens, cacheWrite: m.usage.cache_creation_input_tokens} : null;
      this.notify(t.id, 'turn/completed', {turn: {id: t.id, status, ...(error ? {error: {message: error}} : {})}});
    }
  }
  // A dead process fails only this thread's turn; the other threads keep running.
  dead(error) {
    if (this.closed) return; this.closed = true;
    try { this.proc.stdin.end(); } catch {}
    const t = this.turn; this.turn = null;
    // During an owned shutdown the runtime settles outstanding turns itself.
    if (t && !this.released && !this.host.closing) this.notify(t.id, 'turn/completed', {turn: {id: t.id, status: 'failed', error: {message: error.message}}});
    if (this.proc.exitCode === null && this.proc.signalCode === null) killTree(this.proc);
  }
  exited() { return this.proc.exitCode !== null || this.proc.signalCode !== null; }
  close() {
    return new Promise(resolve => {
      if (this.exited()) { this.closed = true; resolve(true); return; }
      let force, deadline; const finish = ok => { clearTimeout(force); clearTimeout(deadline); resolve(ok); };
      this.proc.once('close', () => finish(true));
      try { this.proc.stdin.end(); } catch {}
      force = setTimeout(() => killTree(this.proc), 1000);
      deadline = setTimeout(() => finish(this.exited()), 6500);
    });
  }
}

function killTree(proc) {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore', timeout: 4000});
    killer.on('error', () => {});
  } else proc.kill('SIGKILL');
}

export class ClaudeHost extends EventEmitter {
  constructor({exe, exeArgs = [], env = process.env, cwd, models = CLAUDE_MODELS} = {}) {
    super(); this.exeArgs = exeArgs; this.cwd = cwd; this.modelList = models; this.threads = new Map(); this.closed = false;
    this.allowApiKey = env.GOAL_LOOP_CLAUDE_ALLOW_API_KEY === '1';
    this.env = childEnvironment(env, this.allowApiKey); this.exeOverride = exe;
  }
  async initialize() {
    this.exe = this.exeOverride ?? discoverClaude();
    this.account = {type: this.allowApiKey ? 'claude-code (API key allowed)' : 'claude-code subscription'};
    return this;
  }
  validate(selection) {
    if (!this.modelList.some(m => m.id === selection.modelId)) throw new Error(`Claude model is not offered: ${selection.modelId}`);
    if (selection.reasoning !== 'max') throw new Error('Research workers require max reasoning.');
    if (selection.speedId !== 'standard') throw new Error(`Requested speed is unavailable for ${selection.modelId}: ${selection.speedId}`);
    return selection;
  }
  catalog() {
    return {verified: true, source: 'Claude Code CLI; model, credential source and tools attested per turn', maxThinkers: 4, account: this.account,
      models: this.modelList.map(m => ({id: m.id, label: m.label, maximumReasoning: {value: 'max'}, independentSpeed: true, speeds: [{id: 'standard', label: 'Standard'}]}))};
  }
  async thread(selection, instructions, cwd, {outputSchema} = {}) {
    if (this.closed) throw new Error('Claude host is closed');
    this.validate(selection);
    const t = new ClaudeThread(this, {selection, instructions, cwd: cwd ?? this.cwd, outputSchema});
    this.threads.set(t.id, t);
    t.identity = await processIdentityAsync(t.proc.pid);
    return {threadId: t.id, model: selection.modelId, modelProvider: 'anthropic', serviceTier: 'standard', reasoningEffort: 'max', environmentAccess: false,
      attestation: 'Claude Code init is checked every turn for exact model, subscription credential and tool list; max effort is requested, not attested',
      ...(t.schema ? {structuredOutputTool: 'StructuredOutput'} : {})};
  }
  request(method, params = {}) {
    try {
      const t = this.threads.get(params.threadId); if (!t) throw new Error('Unknown Claude thread');
      if (method === 'turn/start') {
        const text = (params.input ?? []).filter(i => i.type === 'text').map(i => i.text).join('\n');
        return Promise.resolve(t.start(text, params.outputSchema));
      }
      if (method === 'turn/interrupt') return Promise.resolve(t.interrupt(params.turnId));
      throw new Error('Unsupported Claude host request: ' + method);
    } catch (e) { return Promise.reject(e); }
  }
  identities() { return [...this.threads.values()].filter(t => !t.exited() && t.identity?.status === 'alive').map(t => t.identity); }
  async release(threadId) { const t = this.threads.get(threadId); if (!t) return; t.released = true; this.threads.delete(threadId); await t.close(); }
  async close() {
    this.closing = true; this.closed = true;
    const results = await Promise.all([...this.threads.values()].map(t => t.close()));
    return {confirmed: results.every(Boolean)};
  }
}
