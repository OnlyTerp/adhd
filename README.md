# ADHD

**Allowed to Drift. Held to Direction.**

ADHD is a deep-research loop for AI models. A thinker model does nothing but think: it has no tools and never waits on anything. A separate tracker model keeps the research notebook organized in the background. Every round the thinker publishes enters the document word for word, straight away. The tracker can organize, connect and annotate, but it can't remove or hold back anything.

Models left alone tend to grab one idea, chase it down a rabbit hole, and lose the big picture. ADHD lets the thinker wander as far as it likes, and keeps the objective in front of it every round. Evidence you supply (test results, measurements, corrections) reaches the next round without pausing it.

## What it does

- **Uninterrupted thinking.** The next round starts as soon as the last one is saved, usually a few milliseconds later. Recording, exports, evidence and the tracker never gate it.
- **A lossless notebook.** Sources are stored verbatim in SQLite and shown in the main document before the tracker gets to them. Tracker notes are additive.
- **Big-picture guard.** Every round restates the objective and asks the thinker to say so when it has drifted. The tracker's first next direction names any drift it sees.
- **Evidence feedback.** You submit attributed observations with provenance. Each round records exactly which evidence and tracker feedback it received.
- **Pause, stop, recover, export.** Exports are hash-verified packages you can restore read-only on another machine.
- **A local viewer.** A clean, live web view of the notebook that renders Markdown and KaTeX safely.

## Models

| Host | Models | Login used |
| --- | --- | --- |
| Codex app-server | GPT-6 models your Codex catalog offers with max reasoning, for example `gpt-6-astra` and `gpt-6.1-terra` | Your ChatGPT login in Codex Desktop |
| Claude Code CLI | `claude-opus-5-5`, `claude-sonnet-5-5` | Your Claude subscription login |

Mix them freely, for example an Opus thinker with a Terra tracker. Thinkers always run at max reasoning. ADHD never substitutes a different model. Each Claude turn is checked against the CLI's own report of the model, credential source and tool list. By default, API keys and third-party provider routes are refused, so runs use your subscription. Set `GOAL_LOOP_CLAUDE_ALLOW_API_KEY=1` to allow an API key.

Defaults: one thinker (up to four). The tracker is Terra, or Sonnet 5.5 when every thinker is a Claude model. If you have Codex, use Terra as the tracker: it writes a note in about 30 seconds, while Sonnet 5.5 at max effort took 3 to 7 minutes per note in testing.

## Requirements

- Node.js 24 or later
- Windows 10 or 11. It has only been tested on Windows. macOS and Linux code paths exist but are untested.
- For GPT models: Codex Desktop running and signed in with ChatGPT (or set `GOAL_LOOP_CODEX_EXE`)
- For Claude models: Claude Code installed and signed in (or set `GOAL_LOOP_CLAUDE_EXE`)

## Install

```bash
git clone https://github.com/OnlyTerp/adhd.git
cd adhd
npm ci
npm run build
npm test
```

## Run

Write a spec file:

```json
{
  "goal": "Why does checkout time out under load, and what is the smallest fix?",
  "context": "Relevant excerpts, measurements, constraints and unknowns.",
  "configuration": {
    "thinkers": [{"modelId": "claude-opus-5-5", "speedId": "standard", "reasoning": "max"}],
    "tracker": {"modelId": "gpt-6.1-terra", "speedId": "priority", "reasoning": "max"},
    "continuous": true
  }
}
```

```bash
node native/cli.mjs catalog
node native/cli.mjs run --spec research.json
```

`run` prints the viewer URL. Type `quit` to stop. Continuous runs go on until you pause or stop them. For a bounded run, use `"maxRounds"` and `"maxMinutes"` instead of `"continuous"`. Data lives in `~/.adhd/data` unless you pass `--data` or set `GOAL_LOOP_DATA`.

## Use from an agent (MCP)

```bash
codex mcp add adhd -- node /path/to/adhd/native/mcp.mjs
claude mcp add adhd -- node /path/to/adhd/native/mcp.mjs
```

| Tool | Purpose |
| --- | --- |
| `goal_loop_catalog` | Models the installed hosts actually offer |
| `goal_loop_start` | Start a run with a goal, context and configuration (keep its `requestId` for retries) |
| `goal_loop_status` | Lifecycle, recorder coverage and timing metrics |
| `goal_loop_evidence` | Add an attributed observation or correction; it reaches the next round |
| `goal_loop_read` | The document, sources, tracker notes or input packets |
| `goal_loop_control` | `pause`, `resume`, `stop`, `recover_recording`, `repair_export` |
| `goal_loop_export` | A hash-manifested research package |

The owning agent runs tests and retrieval itself, then submits the results as evidence. The thinker and tracker never get tools.

## Honest limits

- The thinker gets no tools, and every tool attempt is detected and stops the run. That is not proof that every host feature is excluded.
- Timing metrics measure this controller, not provider inference speed or cost.
- Claude effort is requested as `max`; the CLI doesn't report it back. Claude reports the model at the first turn, so a mismatch fails that turn after inference has started.
- The big-picture guard is a prompt instruction to the thinker and tracker. The tests check that every round carries it, not how well a model follows it.
- A slow tracker never holds up the thinker, but its notes arrive less often and refer to older rounds.
- Stopping confirms the local host processes exited, not upstream billing cancellation.
- The `worker/`, `db/` and `drizzle/` folders are an optional hosted storage service. They aren't needed for local use and aren't deployed by this repository. `npm run package:worker` bundles it and needs your own `.openai/hosting.json`.

## Tests

`npm test` runs the full suite with fake hosts, using no model usage. `scripts/verify-native-continuous.mjs <dir>` is an opt-in live acceptance run on your own subscriptions. Choose its workers with `GOAL_LOOP_VERIFY_THINKER` and `GOAL_LOOP_VERIFY_TRACKER`.
