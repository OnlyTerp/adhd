# Durable launch guard (integration candidate)

This module is connected to the local Worker tools and UI. Migration `0003_launch_requests.sql` and its journal entry are additive and have not been deployed. The SQLite migration test executes its single statement with `prepare().run()`. Never edit applied migrations.

## Integration contract

All calls take the existing authenticated owner identity at the server boundary. Never accept owner identity from UI arguments. `claimId` and `dispatchId` are caller-generated opaque operation IDs; the host must retain its claim ID for receipt recovery. They are concurrency guards, not authentication credentials or a separate tracker identity.

1. The Worker `launch_status` tool returns `{request: object|null}`; the internal module `status(sessionId)` returns that request directly. UI reads session status with its `launchRequest` field on load. An existing request controls the button, even after reopen. Do not infer launch status from paginated document events.
2. On a user click, call `prepare({sessionId,requestId,configuration})`. One durable request exists per session. Reopening with a new request ID returns the existing request. Same request ID with different configuration is rejected. UI must use the **returned** request ID and configuration, never its unsaved new values.
3. Before sending `ui/message`, call `dispatch({sessionId,requestId,dispatchId})`. Only a response with `granted:true` permits this instance to send once. Persisted state becomes `sending` before the external action. Replayed calls always return false, including the same dispatch ID. A lost response leaves a blocked/uncertain request, not permission to resend.
4. Send exactly one host message containing session ID, request ID and the instruction that the host must call `claim` before spawning any agents. Record `deliveryReceipt(...,state:'sent')` if host accepts the message; `unknown` if ambiguous. `sent` means message accepted, not agents launched. No timeout or reopen re-enables sending.
5. Host calls `claim({sessionId,requestId,claimId})` **before** native spawn/control. Only the caller receiving `granted:true` may act. If claim response is lost or its retry returns false, do not execute: inspect existing work and reconcile. Do not reuse a grant across another execution. No lease expires and no automatic claim stealing occurs.
6. Host records `receipt` with `started`, `unknown`, `completed`, or `rejected` and concise observed evidence/reference. Receipts are assertions by the authenticated caller, not independent telemetry. A configuration mismatch or unavailable maximum reasoning should be `rejected` before execution. `started` must follow actual admission, not just a message acknowledgment. `completed` requires actual result verification. Unknown remains non-retryable, though the same claim holder can reconcile it to observed started/completed/rejected.

## Intentional limits

One launch per session. No automatic restart, retry-generation, purge, timeout release, or retention deletion is provided. A future explicit user-approved reconciliation flow may enable a new request after proving no prior work can run. Until then, retain the blocked state and explain it instead of silently starting replacement work.

This guard provides a one-shot durable dispatch/claim opportunity **only for cooperating adapters**. It cannot make external native-agent launch transactional, prevent a malicious/buggy host ignoring the claim, prove a user-visible result, or guarantee exactly-once execution. Crash-before-spawn can result in no execution and a stuck claim. That is safer than duplicate cost/work. No model, speed, maximum-reasoning or transcript capability is granted by the protocol.

## Verification

`node --test test/launch-safety.test.mjs` covers reopen/retry, separate sessions, changed configuration, owner isolation, wrong claim receipts, unknown non-retry state and terminal-state protection. Hosted D1 behavior and a real host's cooperation remain unverified.
