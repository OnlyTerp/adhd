// ACP host: runs research workers through an Agent Client Protocol agent (for
// example `devin acp`) speaking newline-delimited JSON-RPC 2.0 over stdio. Each
// research thread is one agent process (the model is fixed per process) with one ACP
// session. The client offers no file system, terminal or MCP capability; any tool
// call or client request from the agent fails the turn. ACP updates are translated
// into the notification shape the Codex app-server emits (see BACKENDS.md).
import {spawn, spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {processIdentityAsync} from './identity.mjs';
import {extractJson} from './json.mjs';

export const ACP_PROFILES = [
  {
    id: 'devin', label: 'Devin', command: 'devin',
    // The summarizer agent type exposes no tools and loads no MCP servers.
    args: m => ['acp', '--agent-type', 'summarizer', '--model', m],
    models: [{id: 'swe-2', label: 'SWE-2'}, {id: 'swe-2-flash', label: 'SWE-2 Flash'}],
    capabilities: {toolFree: 'detected', usageMeter: 'tokens', billing: 'free', structuredOutput: 'prompted', compaction: 'unknown'},
  },
];

const PROTOCOL_VERSION = 1;
const FRAME_LIMIT = 8 * 1024 * 1024;
const STARTUP_TIMEOUT = 60_000;
// Variables a parent agent session leaks into its children.
const PARENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_SESSION_ID)$/;
const TOOL_UPDATES = new Set(['tool_call', 'tool_call_update']);
const SPEEDS = [{id: 'standard', label: 'Standard'}];

export function acpEnvironment(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!PARENT_VARS.test(k)) out[k] = v;
  return out;
}

// Resolve a profile command to an executable spawnable with shell:false.
export function discoverCommand(command, env = process.env) {
  const override = env[`GOAL_LOOP_${command.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_EXE`];
  if (override) return override;
  if (process.platform !== 'win32') return command;
  const found = spawnSync('where.exe', [command], {encoding: 'utf8', windowsHide: true, timeout: 4000});
  const lines = (found.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const exe = lines.find(l => /\.exe$/i.test(l) && existsSync(l));
  if (exe) return exe;
  throw new Error(`Install the ${command} CLI (no ${command}.exe on PATH) or set GOAL_LOOP_${command.toUpperCase()}_EXE.`);
}

// A model asked for JSON may wrap it in a fence or a sentence, or leave LaTeX unescaped.
export {extractJson} from './json.mjs';
export function stripFence(text) {
  const m = text.trim().match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  return (m ? m[1] : text).trim();
}

function killTree(proc) {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore', timeout: 4000});
    killer.on('error', () => {});
  } else proc.kill('SIGKILL');
}

const lastLine = s => s.trim().split(/\r?\n/).pop() ?? '';

class AcpThread {
  constructor(host, {selection, instructions, cwd, outputSchema}) {
    this.host = host; this.selection = selection; this.id = `${host.profile.id}-${randomUUID()}`;
    this.instructions = instructions ?? ''; this.cwd = cwd;
    this.schema = outputSchema ? JSON.stringify(outputSchema) : null;
    this.turn = null; this.closed = false; this.released = false; this.stderr = '';
    this.nextId = 1; this.pending = new Map(); this.sessionId = null; this.prompted = false;
    const args = [...host.command.prefix, ...host.profile.args(selection.modelId)];
    this.proc = spawn(host.command.exe, args, {cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: host.env});
    const decoder = new StringDecoder('utf8'); let buffer = '';
    this.proc.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    this.proc.stdin.on('error', () => {});
    this.proc.stdout.on('data', chunk => {
      if (this.closed) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > FRAME_LIMIT) return this.dead(new Error('ACP frame limit exceeded'));
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { return this.dead(new Error('Malformed ACP frame')); }
        this.handle(msg);
        if (this.closed) return;
      }
    });
    this.proc.once('error', e => this.dead(e));
    this.proc.once('close', (code, signal) => this.dead(new Error(`ACP agent ${host.profile.id} exited (${code ?? signal})${this.stderr ? ': ' + lastLine(this.stderr) : ''}`)));
  }

  write(msg) { if (this.closed) throw new Error('ACP thread is closed'); this.proc.stdin.write(JSON.stringify({jsonrpc: '2.0', ...msg}) + '\n'); }
  call(method, params, timeout = 0) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++; let timer = null;
      if (timeout) timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP ${method} timed out after ${timeout / 1000} s`)); }, timeout);
      this.pending.set(id, {method, resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); }});
      try { this.write({id, method, params}); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  notifyAgent(method, params) { try { this.write({method, params}); } catch {} }
  notify(turnId, method, params = {}) { this.host.emit('notification', {method, params: {threadId: this.id, turnId, ...params}}); }

  async open() {
    try {
      const init = await this.call('initialize', {protocolVersion: PROTOCOL_VERSION, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}}, STARTUP_TIMEOUT);
      this.agentInfo = init?.agentInfo ?? null; this.protocolVersion = init?.protocolVersion;
      if (init?.protocolVersion !== PROTOCOL_VERSION) throw new Error(`ACP agent speaks protocol ${init?.protocolVersion}, not ${PROTOCOL_VERSION}`);
      const session = await this.call('session/new', {cwd: this.cwd, mcpServers: []}, STARTUP_TIMEOUT);
      if (!session?.sessionId) throw new Error('ACP agent returned no sessionId');
      this.sessionId = session.sessionId;
    } catch (e) {
      const tail = this.stderr ? lastLine(this.stderr) : '';
      this.closed = true;
      if (!this.exited()) killTree(this.proc);
      throw new Error(`ACP agent ${this.host.profile.id} (${this.selection.modelId}) failed to start: ${e.message}${tail && !e.message.includes(tail) ? ' | stderr: ' + tail : ''}`);
    }
  }

  start(text, outputSchema) {
    if (this.closed) throw new Error('ACP thread is closed');
    if (this.turn) throw new Error('Concurrent turn on one ACP thread');
    if ((outputSchema ? JSON.stringify(outputSchema) : null) !== this.schema) throw new Error('An ACP thread fixes its output schema when admitted');
    const id = randomUUID();
    const t = this.turn = {id, blocks: new Map(), order: [], items: 0, interrupted: false, error: null};
    // ACP has no system prompt: the instructions lead the first prompt of the session.
    let body = text;
    if (!this.prompted && this.instructions) body = `<instructions>\n${this.instructions}\n</instructions>\n\n${text}`;
    if (this.schema) body += `\n\nReply with only one JSON object matching this JSON Schema, no prose and no code fence:${this.schema}`;
    this.prompted = true;
    this.call('session/prompt', {sessionId: this.sessionId, prompt: [{type: 'text', text: body}]})
      .then(r => this.finish(t, r, null), e => this.finish(t, null, e));
    return {turn: {id, status: 'inProgress'}};
  }
  interrupt(turnId) {
    const t = this.turn; if (!t || t.id !== turnId || this.closed) return {};
    t.interrupted = true;
    this.notifyAgent('session/cancel', {sessionId: this.sessionId});
    return {};
  }
  forbid(method) {
    this.host.emit('forbiddenRequest', {method, threadId: this.id});
    const t = this.turn; if (!t) return;
    if (!t.error) t.error = 'Research tool boundary crossed: ' + method;
    if (!t.cancelSent) { t.cancelSent = true; this.notifyAgent('session/cancel', {sessionId: this.sessionId}); }
  }

  handle(m) {
    if (m.id !== undefined && m.id !== null && m.method === undefined) {
      const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`ACP ${p.method} error ${m.error.code ?? ''}: ${m.error.message ?? 'unknown'}`.replace(' : ', ': ')));
      else p.resolve(m.result);
      return;
    }
    if (typeof m.method !== 'string') return;
    if (m.id !== undefined && m.id !== null) {
      // A request from the agent: the client grants nothing.
      if (m.method === 'session/request_permission') this.write({id: m.id, result: {outcome: {outcome: 'cancelled'}}});
      else this.write({id: m.id, error: {code: -32601, message: `Client does not offer ${m.method}`}});
      this.forbid(m.method);
      return;
    }
    if (m.method.startsWith('_')) return;
    if (m.method !== 'session/update') return;
    const p = m.params ?? {}, u = p.update ?? {};
    if (p.sessionId !== this.sessionId) return;
    if (TOOL_UPDATES.has(u.sessionUpdate)) { this.forbid(u.sessionUpdate + (u.title ? ':' + u.title : '')); return; }
    const t = this.turn; if (!t) return;
    if (u.sessionUpdate === 'agent_message_chunk') {
      const c = u.content ?? {}; if (c.type !== 'text' || typeof c.text !== 'string') return;
      const key = u.messageId ?? '';
      let b = t.blocks.get(key);
      if (!b) { b = {id: `${t.id}:${++t.items}`, text: ''}; t.blocks.set(key, b); t.order.push(b); }
      b.text += c.text;
      if (!this.schema) this.notify(t.id, 'item/agentMessage/delta', {itemId: b.id, delta: c.text});
    }
    // agent_thought_chunk (hidden reasoning) and informational updates are never published.
  }

  finish(t, result, rpcError) {
    if (this.turn !== t) return;
    this.turn = null;
    let status, error = null;
    const stop = result?.stopReason;
    if (t.error) { status = 'failed'; error = t.error; }
    else if (rpcError) { status = 'failed'; error = rpcError.message; }
    else if (stop === 'cancelled' || (t.interrupted && stop !== 'end_turn')) status = 'interrupted';
    else if (stop === 'end_turn') status = 'completed';
    else { status = 'failed'; error = `ACP turn ended with stopReason ${stop ?? 'missing'}`; }
    if (status === 'completed') {
      if (this.schema) {
        const raw = t.order.map(b => b.text).join(''), parsed = extractJson(raw);
        if (parsed) this.notify(t.id, 'item/completed', {item: {type: 'agentMessage', id: `${t.id}:structured`, text: JSON.stringify(parsed)}});
        else { status = 'failed'; error = 'ACP agent returned no valid JSON: ' + JSON.stringify(raw.slice(0, 160)); }
      } else for (const b of t.order) this.notify(t.id, 'item/completed', {item: {type: 'agentMessage', id: b.id, text: b.text}});
    }
    const u = result?.usage;
    this.lastUsage = u ?? null;
    if (u) this.notify(t.id, 'thread/tokenUsage/updated', {tokenUsage: {last: {inputTokens: u.inputTokens ?? 0, cachedInputTokens: u.cachedReadTokens ?? 0, cacheWriteInputTokens: u.cachedWriteTokens ?? 0, outputTokens: u.outputTokens ?? 0, reasoningOutputTokens: 0}}});
    this.notify(t.id, 'turn/completed', {turn: {id: t.id, status, ...(error ? {error: {message: error}} : {})}});
  }

  // A dead process fails only this thread's turn; the other threads keep running.
  dead(error) {
    if (this.closed) return; this.closed = true;
    try { this.proc.stdin.end(); } catch {}
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    const t = this.turn; this.turn = null;
    if (t && !this.released && !this.host.closing) this.notify(t.id, 'turn/completed', {turn: {id: t.id, status: 'failed', error: {message: error.message}}});
    if (!this.exited()) killTree(this.proc);
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

export class AcpHost extends EventEmitter {
  // profile: profile id to host; profiles: extra profiles; commands: {[profileId]: {command, args?}}
  // where args are prepended to the profile's own args (e.g. a script for process.execPath).
  constructor({profile = 'devin', profiles = [], commands = {}, env = process.env, cwd} = {}) {
    super();
    const all = [...profiles, ...ACP_PROFILES];
    this.profile = all.find(p => p.id === profile);
    if (!this.profile) throw new Error(`Unknown ACP profile: ${profile}`);
    this.backend = this.profile.id; this.cwd = cwd; this.threads = new Map(); this.closed = false;
    this.override = commands[this.profile.id] ?? null; this.rawEnv = env; this.env = acpEnvironment(env);
  }
  async initialize() {
    const o = this.override;
    this.command = o?.command ? {exe: o.command, prefix: o.args ?? []} : {exe: discoverCommand(this.profile.command, this.rawEnv), prefix: []};
    this.account = {type: `acp:${this.profile.id}`, label: this.profile.label};
    return this;
  }
  validate(selection) {
    const id = this.profile.id;
    if (selection.backend !== id) throw new Error(`Selection backend ${selection.backend} is not ${id}`);
    if (!this.profile.models.some(m => m.id === selection.modelId)) throw new Error(`${this.profile.label} model is not offered: ${selection.modelId}`);
    if (selection.reasoning !== 'default') throw new Error(`${this.profile.label} cannot set reasoning effort; use 'default', not ${selection.reasoning}`);
    if (selection.speedId !== 'standard') throw new Error(`Requested speed is unavailable for ${selection.modelId}: ${selection.speedId}`);
    return selection;
  }
  catalog() {
    return {verified: true, source: `ACP agent (${this.profile.command}); model requested per process`, backend: this.profile.id,
      capabilities: {...this.profile.capabilities}, account: this.account,
      models: this.profile.models.map(m => ({id: m.id, label: m.label, efforts: ['default'], speeds: SPEEDS.map(s => ({...s}))}))};
  }
  async thread(selection, instructions, cwd, {outputSchema} = {}) {
    if (this.closed) throw new Error('ACP host is closed');
    if (!this.command) throw new Error('ACP host is not initialized');
    this.validate(selection);
    const t = new AcpThread(this, {selection, instructions, cwd: cwd ?? this.cwd ?? process.cwd(), outputSchema});
    this.threads.set(t.id, t);
    try { await t.open(); } catch (e) { this.threads.delete(t.id); throw e; }
    if (this.closed) { await this.release(t.id); throw new Error('ACP host is closed'); }
    t.identity = await processIdentityAsync(t.proc.pid);
    return {threadId: t.id, model: selection.modelId, modelProvider: this.profile.id, serviceTier: 'standard', reasoningEffort: 'default', environmentAccess: false,
      attestation: `ACP agent launched tool-less (summarizer); any tool call or client request fails the turn; model is requested, not attested`};
  }
  request(method, params = {}) {
    try {
      const t = this.threads.get(params.threadId); if (!t) throw new Error('Unknown ACP thread');
      if (method === 'turn/start') {
        const text = (params.input ?? []).filter(i => i.type === 'text').map(i => i.text).join('\n');
        return Promise.resolve(t.start(text, params.outputSchema));
      }
      if (method === 'turn/interrupt') return Promise.resolve(t.interrupt(params.turnId));
      throw new Error('Unsupported ACP host request: ' + method);
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
