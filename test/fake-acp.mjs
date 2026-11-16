// Stand-in for an ACP agent (`devin acp ...`): newline-delimited JSON-RPC 2.0 on stdio.
// The scenario is chosen by a [keyword] in each prompt. Each session keeps the
// prompts it received so [echo] can show the history the agent holds.
import {StringDecoder} from 'node:string_decoder';
const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const model = arg('--model');
const out = o => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...o}) + '\n');
const sessions = new Map();
let nextReq = 1000, active = null, lastClientReply = null;
const usage = {totalTokens: 30, inputTokens: 21, outputTokens: 9, cachedReadTokens: 15, cachedWriteTokens: 4};
const update = (sessionId, u) => out({method: 'session/update', params: {sessionId, update: u}});
const chunk = (sid, text, messageId) => update(sid, {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text}, ...(messageId ? {messageId} : {})});
const end = (stopReason, extra = {}) => { if (!active) return; const a = active; active = null; out({id: a.id, result: {stopReason, ...extra}}); };

if (process.env.FAKE_ACP_FAIL_INIT === '1') { process.stderr.write('warming up\nfake-acp: not logged in\n'); process.exit(2); }

function prompt(id, params) {
  const s = sessions.get(params.sessionId);
  if (!s) { out({id, error: {code: -32602, message: 'unknown session'}}); return; }
  const text = params.prompt.map(p => p.text).join('');
  s.history.push(text);
  active = {id, sid: params.sessionId};
  const kw = (text.match(/\[(\w+)\]/) || [])[1] || 'normal';
  const sid = params.sessionId;
  if (kw === 'die') { chunk(sid, 'about to die'); setTimeout(() => process.exit(3), 5); return; }
  if (kw === 'tool') { update(sid, {sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending'}); return; }
  if (kw === 'perm') { out({id: nextReq++, method: 'session/request_permission', params: {sessionId: sid, toolCall: {toolCallId: 't2'}, options: [{optionId: 'allow', kind: 'allow_once', name: 'Allow'}]}}); return; }
  if (kw === 'fsread') { out({id: nextReq++, method: 'fs/read_text_file', params: {sessionId: sid, path: 'x.txt'}}); return; }
  if (kw === 'slow') { chunk(sid, 'partial '); return; }
  if (kw === 'lastreply') { chunk(sid, JSON.stringify(lastClientReply)); end('end_turn'); return; }
  if (kw === 'refuse') { end('refusal'); return; }
  if (kw === 'rpcerror') { active = null; out({id, error: {code: -32000, message: 'model overloaded'}}); return; }
  if (kw === 'echo') {
    chunk(sid, JSON.stringify({history: s.history, cwd: s.cwd, model}), 'e1');
    end('end_turn', {usage}); return;
  }
  if (kw === 'json') { chunk(sid, '```json\n{"answer":'); chunk(sid, ' "forty-two"}\n```'); end('end_turn', {usage}); return; }
  if (kw === 'plainjson') { chunk(sid, '{"answer":"plain"}'); end('end_turn', {usage}); return; }
  if (kw === 'badjson') { chunk(sid, 'Sure! The answer is forty-two.'); end('end_turn', {usage}); return; }
  // normal: hidden thought, vendor noise, informational updates, two message blocks.
  out({method: '_cognition.ai/output', params: {text: 'VENDOR-NOISE'}});
  update(sid, {sessionUpdate: 'agent_thought_chunk', content: {type: 'text', text: 'SECRET-THOUGHT'}});
  update(sid, {sessionUpdate: 'available_commands_update', availableCommands: []});
  // Split a multi-byte character across two writes to exercise the UTF-8 decoder.
  const frame = Buffer.from(JSON.stringify({jsonrpc: '2.0', method: 'session/update', params: {sessionId: sid, update: {sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: {type: 'text', text: 'Finding café 🧪 '}}}}) + '\n');
  const cut = frame.indexOf(Buffer.from('é')) + 1; process.stdout.write(frame.subarray(0, cut));
  setTimeout(() => {
    process.stdout.write(frame.subarray(cut));
    chunk(sid, 'one', 'm1');
    update(sid, {sessionUpdate: 'usage_update', size: 200000, used: 30});
    chunk(sid, 'Second block', 'm2');
    end('end_turn', {usage});
  }, 5);
}

const dec = new StringDecoder('utf8'); let buf = '';
process.stdin.on('data', d => {
  buf += dec.write(d);
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
    const m = JSON.parse(l);
    if (m.method === undefined) { lastClientReply = m.result ?? {error: m.error}; continue; }
    if (m.method === 'initialize') {
      const ok = m.params?.protocolVersion === 1 && m.params?.clientCapabilities?.terminal === false && m.params.clientCapabilities.fs?.readTextFile === false;
      if (!ok) out({id: m.id, error: {code: -32602, message: 'bad initialize'}});
      else out({id: m.id, result: {protocolVersion: 1, agentInfo: {name: 'fake-acp', version: '0'}, agentCapabilities: {}}});
    } else if (m.method === 'session/new') {
      const sid = 'sess-' + (sessions.size + 1); sessions.set(sid, {history: [], cwd: m.params.cwd});
      out({id: m.id, result: {sessionId: sid}});
    } else if (m.method === 'session/prompt') prompt(m.id, m.params);
    else if (m.method === 'session/cancel') end('cancelled');
    else if (m.id !== undefined) out({id: m.id, error: {code: -32601, message: 'unknown method'}});
  }
});
// FAKE_ACP_STUBBORN=1 ignores stdin end, so only a kill ends the process.
if (process.env.FAKE_ACP_STUBBORN === '1') setInterval(() => {}, 1000);
else process.stdin.on('end', () => process.exit(0));
