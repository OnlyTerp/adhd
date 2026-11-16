# ADHD native runtime

ADHD (formerly Goal Loop Studio) runs dedicated thinkers and an independent
recorder through the installed Codex app-server (ChatGPT login) and/or the
Claude Code CLI (Claude subscription login). Hosts can be mixed, for example an
Opus 5.5 thinker with a Terra recorder.
Thinking continues without waiting for document updates, tracker admission,
evidence collection or tests. Every published turn is durably saved verbatim and
immediately enters the main document. The recorder adds organization and connections;
it cannot remove or select which research is retained. Evidence and corrections
enter through the controller and reach the next eligible thinker round.

The hosted Site remains a separate storage/preview service. This local runtime
uses only the existing subscription logins: Codex must report a ChatGPT account,
and each Claude turn must report no API-key credential (opt in with
GOAL_LOOP_CLAUDE_ALLOW_API_KEY=1). It verifies the exact requested model and never
silently substitutes a worker. Codex receipts attest max effort and service tier;
Claude effort is requested as max but not reported back by the CLI.

## Use from Codex

Ask: “Use Goal Loop Studio to investigate this problem. Supply the relevant source
context, use Astra Max/Fast, and return evidence requests as they arise.”

| Tool | Purpose |
| --- | --- |
| goal_loop_catalog | Actual installed model/tier catalog; no inference. |
| goal_loop_start | Immutable goal/context/configuration with retained requestId. |
| goal_loop_status | Compact lifecycle, recorder coverage, metrics and export state. |
| goal_loop_evidence | Idempotent attributed observations/corrections with revision checks. |
| goal_loop_read | Lossless document/feedback, paged sources/notes, or input packet. |
| goal_loop_control | pause, resume, stop, recover_recording, repair_export. |
| goal_loop_export | Consistent hash-manifested research package. |

Start example:

    {
      "requestId": "retain-this-id-on-retry",
      "goal": "A concrete research objective",
      "context": "Relevant excerpts, provenance, constraints and unknowns",
      "configuration": {
        "thinkers": [{"modelId":"gpt-6-astra","speedId":"priority","reasoning":"max"}],
        "continuous": true,
        "feedbackEnabled": true,
        "trackerContextBytes": 2097152
      }
    }

Use exact model/tier IDs from the live catalog. Defaults are one Astra/max/Fast
thinker and Terra/max/Fast recording. Up to four thinker threads are supported.
Runs are continuous by default, until user pause/stop or a genuine host/storage
failure. Completion/blocked markers do not halt continuous thinking; the next turn
investigates another useful in-scope direction using currently available evidence.
For a deliberately bounded run, supply maxRounds/maxMinutes with continuous false
or omitted. Its wall deadline includes initialization, paused time and recording.
A reached limit is limited, not objective completion. Never pause a research run
to wait for tracker reconciliation, a test or an evidence submission.

## Evidence feedback

Read status.inputRevision, then submit:

    {
      "sessionId": "the-run-id",
      "requestId": "retained-measurement-id",
      "expectedInputRevision": 1,
      "text": "The measured result contradicts the original estimate...",
      "provenance": "Command, document reference or source URL",
      "sourceRevision": "commit or document revision",
      "observedAt": "2026-11-16T10:00:00Z",
      "status": "observed"
    }

Status is observed, reported, hypothesis or stale. Optional supersedes names an
existing evidence ID. “Observed” is the submitting caller's attribution, not an
independent certification by Studio. Reusing an ID with the same payload returns
the original receipt; changed payloads conflict. A stale expectedInputRevision is
rejected, except for an exact replay.

Every immutable packet includes objective/context hashes and evidence provenance.
Every turn admission records its packet hash, input revision and feedback revision.
A turn already running keeps its original inputs. The next eligible round takes
the latest committed evidence and Terra feedback without waiting for Terra.

Terra retains a bounded ledger of new findings, corrections, disagreements,
repetition, uncertainty, open evidence requests and useful next directions.
References are checked before acceptance. The owning assistant performs authorized
retrieval/tests and submits the resulting evidence; neither worker receives tools.
Studio does not execute a ledger's proposed actions or start cross-project work.

Evidence can also be saved to a finished run. This does not restart a thinker.
Explicit recording recovery can reconcile its notebook; a new research objective
requires a new start request. Future unattended orchestration is a separate
[design proposal](../docs/ALWAYS_ON_RESEARCH_PLAN.md), not an enabled service.

## Control, recovery and durability

Pause closes thinker admission after current turns, including when another thinker
finishes. Terra may drain saved sources during pause. Resume uses the same owned
thinker threads. Stop closes admission synchronously, marks outstanding operations,
interrupts active turns and bounds local-host shutdown. Expected interruption is
distinguished from genuine failure, including late admission acknowledgements.

Research outcome, recorder state, termination and export freshness are separate.
A completed thinker objective with failed recording is recording_failed, with the
original outcome preserved. Confirmed local process exit does not independently
prove upstream billing cancellation.

One recorder owns the durable source queue. Completed malformed responses get one
automatic retry by default; uncertain outcomes are never blindly retried. Tracker
backlog and errors never throttle healthy thinkers. Source publication dispatches
the next thinker turn before scheduling tracker/export work. A busy tracker
coalesces publications into batches. Evidence-only updates are included in the next
publication hook; explicit recording recovery can reconcile them separately.

Use recover_recording to retry a known-ended recorder or reconstruct recording
from saved sources after confirmed host termination. It never admits a thinker.
Recovery has its own ten-minute deadline. Optional trackerContextBytes explicitly
raises the recorder budget up to 8 MiB; the original research configuration stays
archived. Unknown prior termination blocks recovery. Controller instance, process
start identity and epoch fence ownership; a crashed controller never causes
automatic thinker re-admission.

SQLite is authoritative. Markdown export is a rebuildable projection, with failures
reported separately. repair_export regenerates it. Package export contains inputs,
sources, synthesis history, audit/admission receipts and a per-section hash manifest
from one consistent SQLite transaction. No raw WAL-file copy is used.

## Notebook and local commands

The native viewer fetches compact status, the changed lossless document, and requested
source/history pages. Every source is included even before Terra has recorded it;
all prior tracker notes remain alongside later additions. It displays evidence
provenance, exact source links, recorder and
export freshness, and adjacent revision comparison. Markdown is sanitized before
KaTeX renders with trust disabled. Literal placeholder text cannot collide with
the math formatter; rendering failure leaves readable source text.

Node 24 or later:

    npm run build:ui
    npm run build:native
    node native/cli.mjs catalog
    node native/cli.mjs run --spec research.json
    node native/cli.mjs view --session RUN_ID --data ~/.adhd/data
    node native/cli.mjs verify-package --package PATH
    node native/cli.mjs restore --package PATH --request-id RETAINED_ID --data NEW_DIRECTORY

Restore verifies integrity and imports a read-only historical run without model
admission. Enter quit to close a CLI viewer and its owned run. The registered MCP
process owns its loopback viewer for the connection lifetime; it is not a daemon
that survives arbitrary connector shutdown.
The CLI has no implicit one-hour shutdown; an explicit --lifetime sets its deadline.

Registration:

    codex mcp add adhd -- node /path/to/adhd/native/mcp.mjs
    claude mcp add adhd -- node /path/to/adhd/native/mcp.mjs

Configuration refresh and a connection actually running the new implementation
are separate checks. Existing notebooks are retained; back up SQLite before a
schema upgrade. Do not run an old writer against the migrated database.

## Bounds and measurement

Continuous mode has no round/time limit. Optional bounded mode supports up to
10,000 rounds per thinker and 24 hours. Durable storage limits remain 2 MiB per
completed source and 64 MiB total sources, reserving the per-turn maximum before
admission. Exhaustion fails visibly without deleting prior publications or waiting
for Terra. Legacy maxPending/maxPendingBytes configuration fields are retained for
request compatibility but no longer act as thinker admission limits.
Evidence is capped at 100 submissions / 250 KB per workspace. Oversized individual
outputs stop visibly rather than being silently truncated.

Recorder context counts explicitly submitted/generated UTF-8 bytes. Before its
configured cumulative budget fills, a new Terra thread is admitted from the latest
accepted organization note and current ledger, with a new receipt. All older notes
remain in the document. A single oversized checkpoint
blocks recording visibly; retained sources remain available for explicit recovery
with a sufficient budget. Terra emits additive notes rather than rewriting a full
notebook each time.

Recorded metrics include text bytes, per-turn latency, controller-settlement to
next-turn-setup gaps, backlog bytes/age and tracker rotations. The setup gap is
captured before the admission audit and request; compare completion-metrics and
subsequent turn_started receipts to include the local host request/response.
Neither measure includes event-loop notification delay or provider scheduling.
These are not billed tokens, cost or
a controlled model-throughput comparison. Tool restrictions
and zero observed calls are not universal tool-exclusion proof. The current
[qualification record](SELF_RESEARCH_VALIDATION.md) separates controlled, live and
visual evidence. `scripts/verify-native-continuous.mjs` exercises real uninterrupted
Astra/ultrafast turns, asynchronous tracker feedback and lossless export/restore.
