# Backend contract

ADHD runs research workers (thinkers and the tracker) on **backends**. A backend is a
host object that the router owns. The runtime never talks to a model directly; it
speaks one small protocol, shaped like the Codex app-server, and every backend
translates to it. `native/claude.mjs` is the reference implementation of a
non-Codex backend.

## Selection

A worker selection is `{backend, modelId, speedId, reasoning}`.

- `backend`: the backend ID from `goal_loop_catalog` (`codex`, `claude`, `devin`,
  `openai:<name>`). Older selections without `backend` are inferred: `claude-*`
  models go to `claude`, every other model to `codex`.
- `modelId`: exact model ID that backend offers.
- `speedId`: a speed the backend lists for that model (`standard` when it has one).
- `reasoning`: an effort the backend lists for that model (`max`, `high`, `medium`,
  `low`, or `default` for backends that cannot set effort).

## Host interface

```
class Host extends EventEmitter {
  async initialize()                    // returns this; sets this.account (no secrets)
  validate(selection)                   // throws a clear Error when unsupported
  catalog()                             // {verified, source, backend, capabilities, models:[{id,label,efforts,speeds,contextTokens?}]}
  async thread(selection, instructions, cwd, {outputSchema})   // -> receipt (below)
  request('turn/start', {threadId, input:[{type:'text',text}], outputSchema})   // -> Promise<{turn:{id,status:'inProgress'}}>
  request('turn/interrupt', {threadId, turnId})                                  // -> Promise<{}>
  identities()                          // [] or process identities for owned processes
  async release(threadId)               // end one thread and its resources
  async close()                         // -> {confirmed: boolean}; ends everything
}
```

Receipt: `{threadId, model, modelProvider, serviceTier, reasoningEffort,
environmentAccess:false, attestation}`. `attestation` says in one sentence what is
verified (for example "model echoed by the endpoint per response") and what is only
requested.

One turn at a time per thread. A thread keeps its own conversation: turn N sees
turns 1..N-1. `instructions` is the system prompt for the whole thread and must be
the stable first part of every request so provider prompt caching works.

## Notifications

Emit `notification` events `{method, params:{threadId, turnId, ...}}`:

| method | params | when |
| --- | --- | --- |
| `item/agentMessage/delta` | `itemId, delta` | streamed visible text (optional) |
| `item/completed` | `item:{type:'agentMessage', id, text}` | each finished visible answer block |
| `item/completed` | `item:{type:'contextCompaction', id}` | the thread's history was compacted |
| `thread/tokenUsage/updated` | `tokenUsage:{last:{inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}}` | before `turn/completed`; `inputTokens` includes cached tokens |
| `turn/completed` | `turn:{id, status:'completed'\|'failed'\|'interrupted', error?:{message}}` | exactly once per turn, last |

Hidden reasoning is never published. When the turn has an `outputSchema`, the final
`agentMessage` text must be the JSON object itself (no prose, no code fence).

Emit `forbiddenRequest` `{method, threadId}` and fail the turn if the model or agent
tries to use any tool, file, terminal, permission or MCP capability. Workers are
tool-free; a backend that cannot guarantee that must detect and fail instead.

## Capabilities

`catalog().capabilities` declares, honestly:

- `toolFree`: `'attested'` (the backend proves no tools are exposed), `'by-construction'`
  (plain completion API), or `'detected'` (tools requested off; any use fails the turn).
- `usageMeter`: `'plan'` (reads plan usage, can stop before paid overage), `'tokens'`
  (reports tokens only), or `'none'`.
- `billing`: `'subscription'`, `'free'`, `'local'`, or `'per-token'` (spends money per call).
- `structuredOutput`: `'native'` or `'prompted'` (JSON requested in the prompt and validated).
- `compaction`: `'reported'`, `'own'` (the adapter compacts and reports), or `'unknown'`.

Secrets (API keys) are read from environment variables named in configuration and
never stored in the database, audit, export or receipts.
