# delve

Coral-backed multi-agent research CLI. Delve starts a local Coral session, launches specialist research agents, gathers live sources with Exa, writes shared state to SQLite, blocks finalization until negotiation verdicts exist, and emits a structured final package for downstream synthesis.

The npm package is `@itsshadowai/delve`; the installed command is `delve`.

## Install

```bash
npm install -g @itsshadowai/delve
delve --help
```

Delve requires Node.js 24 or newer because the blackboard uses `node:sqlite`.

## Prerequisites

Required for live research:

- `EXA_API_KEY` for source search and fetch.
- At least one model route:
  - `CORAL_API_KEY` for Coral's runtime LLM proxy.
  - `OPENROUTER_API_KEY` as a fallback route.

Recommended:

- Set both `CORAL_API_KEY` and `OPENROUTER_API_KEY` so Delve can fall back if the Coral proxy is unavailable.
- Install a LaTeX compiler such as `tectonic` if you want Codex or local scripts to turn generated `.tex` drafts into PDFs.

Optional:

- `CORAL_SERVER_URL`, defaults to `http://localhost:5555`.
- `CORAL_SERVER_AUTH_KEY`, defaults to `dev`.

Example shell setup:

```bash
export EXA_API_KEY="..."
export CORAL_API_KEY="..."
export OPENROUTER_API_KEY="..."
```

Or create a project-local `.env` in the directory where you run `delve`:

```bash
EXA_API_KEY=
CORAL_API_KEY=
OPENROUTER_API_KEY=
CORAL_SERVER_URL=http://localhost:5555
CORAL_SERVER_AUTH_KEY=dev
```

## First Run

From the project directory where you want outputs:

```bash
delve init
delve codex install-skill
delve --json doctor
```

`delve init` prints the local setup checklist: expected credentials, output paths, optional LaTeX tooling, Coral reachability, and Codex skill status.

`delve codex install-skill` copies the packaged Delve skill into `${CODEX_HOME:-~/.codex}/skills/delve`. It does not run automatically during `npm install`; the write into Codex's skill directory is explicit. Use `--dry-run` to preview and `--force` to replace an existing non-matching skill.

Run a live research pass:

```bash
delve --json research run \
  --topic "Can query-adaptive retrieval budgeting preserve evidence recall while reducing retrieval work?" \
  --format markdown \
  --db .delve/blackboard.db \
  --out artifacts \
  --topology dynamic-revision \
  --coral-url http://localhost:5555 \
  --auth-key dev
```

`delve research run` auto-starts Coral on the requested loopback URL when it is not already reachable. If port `5555` is busy, use another local port:

```bash
delve --json research run \
  --topic "your topic" \
  --db .delve/blackboard.db \
  --out artifacts \
  --coral-url http://localhost:5556
```

Defaults write to the current working directory:

- `.delve/blackboard.db`
- `artifacts/<run-id>/research.md`
- `artifacts/<run-id>/final-package.json`

## Inspect A Run

Use the `runId` printed by `research run`:

```bash
delve --json blackboard notes --run <run-id> --db .delve/blackboard.db
delve --json blackboard sources --run <run-id> --db .delve/blackboard.db
delve --json blackboard claims --run <run-id> --db .delve/blackboard.db
delve --json blackboard negotiation --run <run-id> --db .delve/blackboard.db
delve --json blackboard quality --run <run-id> --db .delve/blackboard.db
delve --json blackboard topology --run <run-id> --db .delve/blackboard.db
delve --json final --file artifacts/<run-id>/final-package.json
```

`blackboard quality` is the main audit command. It summarizes degraded agent work, revision requests, and dissenting verdicts.

## Codex Skill

Install or update the packaged Codex skill:

```bash
delve codex install-skill
```

Check where the skill would be installed:

```bash
delve codex skill-status
delve codex install-skill --dry-run
```

The target defaults to `${CODEX_HOME:-~/.codex}/skills/delve`. To install somewhere else:

```bash
delve codex install-skill --target /path/to/skills/delve
```

## Offline Smoke

The offline fixture is deterministic and does not do live research. Use it only to verify install wiring:

```bash
delve --json research run \
  --topic "optimisation techniques for real-time voice agents" \
  --format markdown \
  --db /tmp/delve-fixture/blackboard.db \
  --out /tmp/delve-fixture/artifacts \
  --offline-fixture
```

## JSON Contract

Use `--json` for stable machine-readable output. Commands return plain JSON values. Errors under `--json` use:

```json
{
  "ok": false,
  "error": "message"
}
```

Secrets are never printed in full. `doctor` reports only presence and source category.

## Topology Modes

`--topology fixed` is the default. It runs the specialist roster, records notes/claims/sources, then requires negotiation before finalization.

`--topology dynamic-revision` keeps the same specialist roster but turns `revise` verdicts into targeted follow-up tasks before finalization. It records revision tasks and topology events in SQLite and `final-package.json`.

## Model And Source Routing

Live agents search and fetch sources through Exa MCP:

- `web_search_exa`
- `web_search_advanced_exa`
- `web_fetch_exa`

Agent synthesis prefers the Coral runtime proxy:

- proxy name: `CORAL_MAIN`
- preferred model: `gpt-5.4-nano`
- fallback endpoint: OpenRouter
- fallback model: `deepseek/deepseek-v4-pro`

If model synthesis fails, Delve writes an extractive source-backed fallback note and marks the work as degraded.

## Codex Synthesis Handoff

Delve does not create native `.docx` or `.pptx` deliverables. Codex owns final artifact synthesis.

Use `final-package.json` as the source of truth. Important fields:

- `notes`: role-specific blackboard notes with source metadata.
- `sources`: deduplicated sources with domains, reliability notes, and linked note IDs.
- `claims`: evidence-backed claims with confidence, caveats, and source URLs.
- `negotiation`: debate transcripts and verdicts.
- `runQuality`: degraded work, revision requests, and dissenting verdicts.
- `topologyTrace`: selected topology mode, topology events, revision tasks, open tasks, and degraded topology actions.
- `synthesis.document.recommendedSections`: suggested long-form document sections.
- `synthesis.slides.recommendedSlides`: suggested slide structure.
- `markdown`: a ready Markdown research artifact.

## Architecture

- `src/cli.ts`: Commander CLI and JSON envelope handling.
- `src/coral-client.ts`: live Coral REST and Puppet client.
- `src/research-runner.ts`: live/offline orchestration, blocking finalization, artifact writing.
- `src/blackboard.ts`: SQLite schema, safe read tools, finalization rules.
- `src/exa-research.ts`: Exa MCP search/fetch normalization.
- `src/llm-client.ts`: Coral proxy and OpenRouter JSON model calls.
- `src/agent-research.ts`: role-specific research and negotiation synthesis.
- `src/eve-coral-agent.ts`: Coral MCP bridge used by the local agent manifests.
- `agent/`: Vercel Eve project files, specialist subagents, blackboard tools, and Exa MCP connection.
- `agents/`: Coral executable agent manifests and startup scripts.
