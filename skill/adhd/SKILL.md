---
name: adhd
description: >-
  Run a long, uninterrupted deep-thinking loop on a hard problem (math, algorithms,
  debugging theory, design trade-offs, research questions) with any model the user
  has - Codex/ChatGPT models, Claude, Devin's SWE models, or any
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
   OpenAI-compatible endpoints come from `<data dir>/endpoints.json` or the file
   named by `GOAL_LOOP_ENDPOINTS`.
2. **Choose models** with the user, or let ADHD choose. Each worker is a selection
   `{backend, modelId, speedId, reasoning}` copied from the catalog.
   - Thinkers: the strongest model the user wants to spend on the problem.
   - Tracker: a cheap, fast model. If you omit it, ADHD picks the Codex tracker
     model (with Codex thinkers), Sonnet at medium effort (with Claude thinkers), or
     the thinker's own model. With Devin or endpoint thinkers, name a cheaper tracker
     yourself if one is available.
   - The Codex backend shows `usage.usedPercent`; at its limit a run refuses to
     start, so pick another backend. Claude's plan state arrives during turns, so
     its first turn is not blocked in advance.
   - Check `capabilities.billing`. `per-token` costs money on every call and needs
     `maxTokens`. `free` and `local` cost nothing as far as ADHD knows; it does
     not check prices, so mention it if the user's plan may differ.
3. **Start** with `goal_loop_start`. Settings go inside `configuration`, never at
   the top level:

   ```json
   {"requestId": "my-run-1", "goal": "...", "contextFile": "/abs/path/context.md",
    "configuration": {"thinkers": [{"backend": "claude", "modelId": "...", "speedId": "standard", "reasoning": "high"}],
                      "maxRounds": 1000, "maxMinutes": 60}}
   ```

   - `goal` is one concrete objective. `context` holds the source excerpts,
     constraints, known results and unknowns the thinkers need. They cannot look
     anything up. A large goal or context (drafts from an earlier run, long
     excerpts) goes in `goalFile` / `contextFile` (absolute path to a UTF-8 file,
     context up to 500 KB) instead of inline text.
   - Keep `requestId` and reuse it on retry.
   - **Bounds.** A run is continuous until paused or stopped. For a bounded run set
     **both** `maxRounds` and `maxMinutes`: setting only `maxMinutes` silently caps
     rounds at 12, and setting only `maxRounds` caps time at 30 minutes. For a
     time-bounded run, set `maxRounds` high (e.g. 1000). `maxRounds` is a cap, not a
     target: a thinker can finish sooner.
   - Put every fact you already have in `context`, tagged by origin (code at a
     file and commit, measured on a date, reported, assumed). Check key claims
     against current code before writing them down: a context built from old docs
     alone produces plans the code contradicts, and on a long run thinkers keep
     building on whatever the context implies.
   - **Effort vs run length.** At max effort a strong thinker can take 10–18 minutes
     per round, so a 30-minute run gets about one round per thinker and no exchange
     between them. For runs under about 45 minutes use `high`; use `max` for runs of
     60 minutes or more. A good two-pass pattern: a `max` run with `maxRounds: 1`
     (each thinker writes one deep draft, then the run drains on its own), then a
     `high` run seeded with those drafts and told to revise, attack and consolidate
     rather than restart.
   - **Several thinkers.** Each thinker is told "You are thinker k of N" in its
     first round, and all start in parallel on an empty document. So assign lenses
     by number; never tell thinkers to "pick the lens least covered so far". With 3–4
     thinkers, give thinkers 1..N-1 disjoint lenses and make thinker N the attacker,
     judge and merger: each round it attacks the others' strongest proposals against
     the constraints, and near the end it writes one consolidated deliverable that
     the others review.
   - **More than 4 thinkers:** `maxThinkers` is 4, so run several sessions with
     split lenses. Tell each run what the others cover, and relay key results
     between them as evidence. Cite relayed material in prose ("run A, lens B,
     round 3"), not by another run's `source-…` or `evidence-…` IDs.
   - **Long runs (an hour or more).** A single question lets strong thinkers agree
     and finish in minutes. Give an ordered queue (`Q1..Qk`) and a completion gate:
     "When your lens settles a queue item, take the next or attack another lens's
     result. Do not mark complete until every item is settled" (and, if you promise
     live measurements, "until FINAL EVIDENCE arrives").
   - **Say what you can and cannot check** during the run (local repo, compiler,
     benchmarks, web docs vs. production data, credentials). Tell thinkers to use
     `loop:blocked` only when no queue item, conditional design ("if X < T then A
     else B") or cross-lens attack is left; otherwise mark the open question and
     continue. A blocked thinker sits idle until evidence arrives.
4. **Show the document.** The result has a `url` (a local page that updates live).
   If your app can open a browser pane or side panel, open it there; otherwise give
   the user the link and the `documentPath` Markdown file. Closing the page does not
   stop the run; `goal_loop_status` returns the `url` again.
5. **Feed evidence.** When a thinker asks for a measurement or test you can run,
   do it. Also check the key numbers and formulas the thinkers state (a quick
   computation catches arithmetic slips no model in the loop will). Then call
   `goal_loop_evidence` with the result, its provenance and the current
   `inputRevision` from `goal_loop_status`. It reaches the next round
   without pausing anything.
   - Fields: `text` (the result itself), `provenance` (the command, file or
     tool), `sourceRevision` (the commit or build measured; `"n/a"` for pure
     math, never empty), `observedAt`, `status` (`observed` = you measured it,
     `reported`, `hypothesis`, `stale`), a `requestId` to retry with, and
     `expectedInputRevision`. Add `supersedes` with an evidence ID to correct an
     earlier item.
   - Take `observedAt` from the real clock, never from memory.
   - Put related measurements in one item, with the question it settles and the
     decision it changes. Don't send a stream of small items: each one is re-read
     by every thinker and by the tracker, and a session holds at most 100 items
     (250 KB).
   - Say plainly what an item does not show, such as one sample or a proxy build,
     so the thinkers don't overreach.
   - Round 1 takes several minutes. Right after starting, run the obvious baseline
     checks yourself so the first evidence lands before round 2.
   - **Web facts (thinkers have no web; you may).** ADHD does not define this tag:
     put the rule in `context` at start, e.g. "at most one
     `[WEB?] <question> — decides: <decision it changes>` per round".
     - Answer only questions that change a decision and that you cannot measure
       locally. Never run unprompted "inspiration" searches.
     - Source order: local measurement and the repository first, then any local
       research cache you have, then primary sources (official docs, source at the
       pinned version, papers). For a plan-critical claim, fetch the page.
     - Search in an isolated subagent or a focused search call that returns only
       claims and URLs. Keep queries generic, with no user or project details.
     - Send one evidence item with at most 3 claims, with `status: "reported"`.
       Each claim has 1–2 paraphrased sentences, the URL, the source date or
       version, and what it does **not** establish. Keep design advice out of it.
       If sources conflict, say so; if no primary source exists, say that.
     - Budget about 8–10 web items per run.
   - **Blocked thinkers.** In a bounded run, a thinker that marks itself `blocked`
     waits for evidence until the time limit (status shows its `status` as
     `evidence`); if none comes, the run ends as `blocked` (on the last allowed
     round it ends at once). In a continuous run `blocked` does not pause the
     thinker. Read the evidence receipt's `notice`: it says when the run is paused,
     when it resumed to check your evidence, or when no thinker is left to read it
     (start a new run if it matters).
6. **Check in** with `goal_loop_status` (compact) or `goal_loop_read`
   (`synthesis` for the document and tracker feedback). Report findings to the user
   in your own words with the source round IDs.
   - To see only what is new, read `revisions` (tracker notes; open thinker
     questions are in `feedback.questions`) or `sources` with `after` set to the `nextCursor` of the last page
     you read. To wait for something, watch `goal_loop_status` (`state`,
     `contentVersion`, `run.sourceCount`, `run.thinkers`), not a text search of the
     Markdown file: it also contains your prompt, your evidence and tracker notes.
   - With several thinkers, `recordedCount` trails `sourceCount` mid-run. The
     tracker records several rounds per turn, and nothing is lost while it
     catches up.
   - Tracker notes are organization, not verification. Before you tell the user
     something is true, trace it to an evidence item or your own check. Keep
     measured facts apart from the thinkers' proposals.
   - **Completion.** When a thinker claims the goal is answered, it gets one review
     round to check its own answer; a second claim in a row ends that thinker (new
     evidence it has not seen reopens it). A claim on the last allowed round ends
     it without the review. A bounded run then ends once the tracker has recorded
     the last round (state `draining`, then finished). A continuous run pauses with
     reason `objective_answered` only when every thinker has claimed twice in a
     row; evidence you send then resumes it. That is normal for an easy goal; do
     not restart it.
   - **The clock.** In a bounded run each round tells the thinkers how many of
     `maxMinutes` have passed, and a turn still running at the limit is stopped and
     lost. Still send a short "LAST ROUND: consolidate now" evidence notice about
     1.5–2 round-lengths before the limit (or before a usage cap), so the merger's
     final deliverable is published in time.
   - When `maxMinutes` runs out, thinker turns stop at once, but the tracker
     keeps recording the rounds already published for up to 15 more minutes.
     During that time the state is `draining` and `run.drain.until` shows the
     deadline. Let it finish. If the window closes first (`run.drain.capHit`),
     the unrecorded rounds stay saved, and `goal_loop_control`
     `recover_recording` records them later.
7. **Stop** with `goal_loop_control` `stop` when the user is done, or `pause` /
   `resume`. `stop` is immediate: it also interrupts the tracker. Rounds it has
   not recorded stay pending until `recover_recording`. `goal_loop_export`
   saves a hash-manifested package.

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
