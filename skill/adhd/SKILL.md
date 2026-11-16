---
name: adhd
description: >-
  Run a long, uninterrupted deep-thinking loop on a hard problem (math, algorithms,
  debugging theory, design trade-offs, research questions) with any model the user
  has - Codex/ChatGPT models, Claude, Devin's free SWE models, or any
  OpenAI-compatible endpoint. Thinker models work round after round without tools
  while an independent tracker organizes their results into a live document. Use
  when the user asks to "think about this for a long time", "run ADHD", "have
  <model> grind on this", or wants background reasoning while they keep working.
---

# ADHD: deep research loop

ADHD is an MCP server (`adhd`, tools `goal_loop_*`). It runs 1–4 **thinker** models
on one goal, round after round, plus one **tracker** model that organizes what they
publish. Workers never get tools, files or the internet: you (the host agent) supply
the facts and feed back measurements as evidence. Every round is kept verbatim in a
live document.

If the `goal_loop_*` tools are missing, the server is not registered. Tell the user
to register it (`claude mcp add adhd -- node <path>/native/mcp.mjs`, or the same
command in their app's MCP settings) and restart the app.

## Workflow

1. **Catalog.** Call `goal_loop_catalog`. It lists each installed backend, its
   capabilities and its models with `efforts` and `speeds`. Backends that are not
   installed or not signed in are listed under `unavailable` with the reason.
2. **Choose models** with the user, or let ADHD choose. Each worker is a selection
   `{backend, modelId, speedId, reasoning}` copied from the catalog.
   - Thinkers: the strongest model the user wants to spend on the problem.
   - Tracker: a cheap, fast model. If you omit it, ADHD picks Terra (with Codex
     thinkers), Sonnet at medium effort (with Claude thinkers), or the thinker's own
     model.
   - The Codex backend shows `usage.usedPercent`; at its limit a run refuses to
     start, so pick another backend.
   - Check `capabilities.billing`. `per-token` costs money on every call and needs
     `maxTokens`. `free` and `local` cost nothing.
3. **Start** with `goal_loop_start`:
   - `goal` is one concrete objective.
   - `context` holds the source excerpts, constraints, known results and unknowns
     the thinkers need. They cannot look anything up.
   - Keep `requestId` and reuse it on retry.
   - A run is continuous until paused or stopped. Set `maxRounds` / `maxMinutes` for a
     bounded run. `maxRounds` is a cap, not a target: a thinker can finish sooner.
4. **Show the document.** The result has a `url` (a local page that updates live).
   If your app can open a browser pane or side panel, open it there; otherwise give
   the user the link and the `documentPath` Markdown file.
5. **Feed evidence.** When a thinker asks for a measurement or test you can run,
   do it. Also check the key numbers and formulas the thinkers state (a quick
   computation catches arithmetic slips no model in the loop will). Then call
   `goal_loop_evidence` with the result, its provenance and the current
   `inputRevision` from `goal_loop_status`. It reaches the next round
   without pausing anything. A thinker that marks itself `blocked` waits for
   evidence until the time limit (status shows its `status` as `evidence`); if
   none comes, the run ends as `blocked` (on the last allowed round it ends at once). Read the receipt's `notice`: it says
   when the run is paused, when it resumed to check your evidence, or when no
   thinker is left to read it (start a new run if it matters).
6. **Check in** with `goal_loop_status` (compact) or `goal_loop_read`
   (`synthesis` for the document and tracker feedback). Report findings to the user
   in your own words with the source round IDs.
   When a thinker claims the goal is answered, it gets one review round to check its
   own answer; a second claim in a row ends that thinker (new evidence it has not
   seen reopens it). A claim on the last allowed round ends it without the review.
   A bounded run then ends once the tracker has recorded the last round (state
   `draining`, then finished); a continuous run pauses with reason
   `objective_answered`, and evidence you send then resumes it. That is normal for
   an easy goal; do not restart it. The review costs one extra thinker round.
7. **Stop** with `goal_loop_control` `stop` when the user is done, or `pause` /
   `resume`. `goal_loop_export` saves a hash-manifested package.

## Usage safety

- A run stops on its own before it spends purchased Codex credits or Claude extra
  usage. Set `allowCredits: true` only if the user explicitly wants to pay.
- With a Codex thinker, continuous runs pause at `maxUsagePercent` (default 90) of
  the plan.
- `maxTokens` caps the whole run's input+output tokens on any backend.
- Status shows tokens and `cacheHitPercent`. A low cache hit on a long run means
  the backend is re-reading the whole history each round; tell the user.

## What it is not

The thinkers do not run code, browse or edit files, and ADHD does not act on what
they propose. You decide what to test and what to apply.
