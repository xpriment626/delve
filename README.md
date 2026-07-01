# delve

Coral-backed multi-agent research CLI. It launches three local specialist agents through Coral, coordinates them with Coral threads, gathers live sources with Exa, writes shared state to SQLite, blocks finalization until negotiation verdicts exist, and emits a structured final package that Codex can turn into Markdown, DOCX, slides, or another requested artifact format.

## Requirements

- Node.js 24 or newer. The blackboard uses `node:sqlite`.
- For live runs, Delve can auto-start a local Coral server with this project's `coral-config.toml`.
- `.env` containing `CORAL_API_KEY`, `OPENROUTER_API_KEY`, and `EXA_API_KEY`.
- Local server auth key `dev`, unless `CORAL_SERVER_AUTH_KEY` is set and the config is changed to match.

`npx coral@latest` is not the working server launcher on npm for this setup. Use the project script, which invokes `coralos-dev@latest`.

## Setup

```bash
npm install
npm run build
npm run install-local
```

The installer creates a `delve` wrapper in `~/.local/bin` using the same Node binary that built the project. It removes the old `deep-research-yolo` and `dryolo` wrappers if they exist.

`delve research run` auto-starts Coral on `http://localhost:5555` if it is not already reachable. If port 5555 is already owned by another local Coral process, pass another explicit loopback URL such as `--coral-url http://localhost:5556`; Delve will pass the matching bind port to Coral. Start Coral manually only when you want foreground server logs or a reusable server process:

```bash
npm run coral:start
```

The start script loads `.env`, sets `CONFIG_FILE_PATH`, and maps `CORAL_API_KEY` into Coral's Cloud proxy config so manifests declaring `CORAL_MAIN` can receive `CORAL_PROXY_URL_CORAL_MAIN`.

Verify from any directory:

```bash
delve --json doctor
```

## Run Research

Live Coral run:

```bash
delve --json research run \
  --topic "privacy preserving synthetic customer support data" \
  --format markdown \
  --db /tmp/delve/blackboard.db \
  --out /tmp/delve/artifacts \
  --topology fixed \
  --coral-url http://localhost:5555 \
  --auth-key dev
```

If `--coral-url` points at a remote server, Delve will not auto-start that server. Start it yourself, then run Delve against it.

`--topology fixed` is the default. `--topology dynamic-revision` keeps the same fixed specialist roster but turns `revise` verdicts into targeted follow-up tasks before finalization. In live mode, Delve opens task-specific Coral threads, mentions the assigned specialist, waits for linked follow-up notes, and records the topology trace in SQLite and the final package.

Offline deterministic fixture:

```bash
delve --json research run \
  --topic "optimisation techniques for real-time voice agents" \
  --format markdown \
  --db /tmp/delve-fixture/blackboard.db \
  --out /tmp/delve-fixture/artifacts \
  --offline-fixture
```

`--offline-fixture` is only a deterministic smoke path. It uses fixed example sources and should not be treated as real research.

The JSON result includes:

- `runId`
- `finalizationBlockedBeforeNegotiation`
- `markdownPath`
- `finalPackagePath`
- `negotiation.status`
- `coralSession` for live runs

## Blackboard

```bash
delve --json blackboard notes --run <run-id> --db /tmp/delve/blackboard.db
delve --json blackboard sources --run <run-id> --db /tmp/delve/blackboard.db
delve --json blackboard claims --run <run-id> --db /tmp/delve/blackboard.db
delve --json blackboard negotiation --run <run-id> --db /tmp/delve/blackboard.db
delve --json blackboard quality --run <run-id> --db /tmp/delve/blackboard.db
delve --json blackboard topology --run <run-id> --db /tmp/delve/blackboard.db
delve --json final --file /tmp/delve/artifacts/<run-id>/final-package.json
```

The app-owned SQLite database is the durable blackboard. Agents write topic-specific notes, source metadata, evidence-backed claims, confidence, caveats, and negotiation verdicts. Agents can only read through bounded single-statement `SELECT` tools.

`blackboard quality` summarizes degraded agent work, revision requests, and dissenting verdicts. Use it before handing a run to Codex for user-facing synthesis.

`blackboard topology` summarizes the selected topology mode, topology events, revision tasks, open revision tasks, and degraded topology actions.

## Model And Source Routing

Live agents search and fetch sources through Exa MCP (`web_search_exa`, `web_fetch_exa`). Agent synthesis prefers the Coral runtime proxy URL injected from the `[[llm.proxies]]` manifest entry:

- proxy name: `CORAL_MAIN`
- preferred model: `gpt-5.4-nano`
- fallback endpoint: OpenRouter
- fallback model: `deepseek/deepseek-v4-pro`

If the Coral proxy call fails inside an agent but `OPENROUTER_API_KEY` is available, the agent retries the same JSON synthesis request through OpenRouter. If both model routes fail, the agent writes an extractive source-backed fallback note with an explicit caveat.

## Codex Synthesis Handoff

Delve does not create native `.docx` or `.pptx` deliverables. Codex owns that final artifact synthesis.

Use `final-package.json` as the source of truth. Its important fields are:

- `notes`: role-specific blackboard notes with source metadata.
- `sources`: deduplicated sources with domains, reliability notes, and linked note IDs.
- `claims`: evidence-backed claims with confidence, caveats, and source URLs.
- `negotiation`: debate transcripts and verdicts; status is `complete`, `complete_with_revision_requests`, or `complete_with_dissent`.
- `runQuality`: degraded work, revision requests, and dissenting verdicts extracted for quick review.
- `topologyTrace`: selected topology mode, topology events, revision tasks, open tasks, and degraded topology actions.
- `synthesis.document.recommendedSections`: suggested long-form document sections.
- `synthesis.slides.recommendedSlides`: suggested slide structure.
- `markdown`: a ready Markdown research artifact.

For a user request like "produce a longer-form document and presentable slides on XYZ", Codex should:

1. Run `delve --json research run --topic "XYZ" --format markdown ...`.
2. Read `finalPackagePath`.
3. Use `claims`, `sources`, and `negotiation` to draft the long-form document.
4. Use `synthesis.slides.recommendedSlides` as the first slide outline, then refine for the user's audience.
5. Use the appropriate Codex document or presentation skill to emit `.docx`, `.md`, `.pptx`, or another requested final format.

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

Live flow:

1. CLI creates a blackboard run.
2. CLI creates a Coral session with `latency-researcher`, `systems-researcher`, and `quality-researcher`.
3. CLI creates a Coral thread and mentions each agent with the research task.
4. Each agent searches Exa, writes notes and claims to SQLite, and includes sources, confidence, and caveats.
5. CLI proves `finalizeRun()` is blocked before negotiation.
6. CLI creates a negotiation thread and mentions each agent.
7. Each agent reviews blackboard contents and records a debate verdict.
8. In `dynamic-revision` mode, CLI converts `revise` verdicts into revision tasks, opens topic-specific Coral threads, mentions assigned agents, and resolves tasks when linked follow-up notes appear.
9. CLI finalizes only after every agent has a verdict, preserves revision/dissent/topology status, and writes `research.md` and `final-package.json`.

## Verification

```bash
npm run check
npm test
npm run build
npm run install-local
command -v delve
delve --help
delve --json doctor
```
