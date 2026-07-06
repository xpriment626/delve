---
name: delve
description: Use when Codex needs to run or inspect the installed Delve CLI for Coral-backed multi-agent research workflows, including `delve doctor`, live or offline `research run`, SQLite blackboard notes/sources/claims/negotiation/topology inspection, final-package handoff, Codex skill installation, and preserving dissent from Delve outputs.
---

# Delve

Use the installed `delve` command first. Do not reinstall the npm package unless `command -v delve` fails or the user asks to refresh it.

## Start

Check the command and setup:

```bash
command -v delve || true
delve --json doctor
```

If this skill is missing or stale on a future machine, install or update it from the package:

```bash
delve codex install-skill
```

Use `delve init` for the human-readable onboarding checklist. It reports expected env vars, output paths, optional LaTeX tooling, and whether this Codex skill is installed.

For local credential setup, prefer the non-echoing auth helper instead of asking the user to paste secrets into a shell command:

```bash
delve set auth exa
delve set auth coral
delve auth status
delve model status
```

`delve set auth` writes `${DELVE_HOME:-~/.delve}/config.env` with file mode `0600`. Use `--stdin` only for automation where the token is already in an environment variable.

Use `delve model select` for the arrow-key model menu, or `delve model set <model>` for non-interactive selection. The default Delve model is `deepseek-v4-pro` through Coral Cloud's LLM proxy.

## Cleanup

Run Delve cleanup before uninstalling the global npm package:

```bash
delve uninstall --dry-run
delve uninstall
npm uninstall -g @itsshadowai/delve
```

`delve uninstall` removes `${DELVE_HOME:-~/.delve}` and `${CODEX_HOME:-~/.codex}/skills/delve`. It intentionally leaves project-local research outputs alone. If the Codex skill was locally edited, pass `--force` to remove it.

## Run Research

Prefer project-local outputs unless the user specifies a different directory:

```bash
delve --json research run \
  --topic "privacy preserving synthetic customer support data" \
  --format markdown \
  --db .delve/blackboard.db \
  --out artifacts \
  --topology fixed \
  --coral-url http://localhost:5555 \
  --auth-key dev
```

`--topology fixed` is the default. Use `--topology dynamic-revision` when the run should convert `revise` verdicts into app-owned revision tasks, open topic-specific Coral threads in live mode, mention assigned specialists for follow-up, and include a topology trace in the final package.

For no-server validation only, add `--offline-fixture`. Treat fixture mode as non-research; it uses deterministic example data.

Live `delve research run` auto-starts a packaged local Coral server for loopback URLs such as `http://localhost:5555`. If port 5555 is busy, pass another explicit loopback URL such as `--coral-url http://localhost:5556`. Start Coral manually only when foreground server logs are needed.

## Inspect

Use the `runId` and database path from the JSON result:

```bash
delve --json blackboard notes --run <run-id> --db .delve/blackboard.db
delve --json blackboard sources --run <run-id> --db .delve/blackboard.db
delve --json blackboard claims --run <run-id> --db .delve/blackboard.db
delve --json blackboard negotiation --run <run-id> --db .delve/blackboard.db
delve --json blackboard quality --run <run-id> --db .delve/blackboard.db
delve --json blackboard topology --run <run-id> --db .delve/blackboard.db
delve --json final --file artifacts/<run-id>/final-package.json
```

Use `blackboard quality` before user-facing synthesis. It summarizes degraded work, revision requests, and dissenting verdicts.

Use the raw Coral escape hatch only for read-only inspection:

```bash
delve --json request /api_v1.json --coral-url http://localhost:5555
```

## Handoff

Treat `final-package.json` as the structured source of truth. It contains `usableFinal`, `qualityGate`, `finalizationBlockedBeforeNegotiation`, `notes`, deduplicated `sources`, evidence-backed `claims`, `negotiation`, `runQuality`, `topologyTrace`, `synthesis`, and ready Markdown.

When drafting final artifacts:

- Preserve dissent, caveats, degraded work, and revision requests.
- Check `usableFinal` and `qualityGate` before treating the package as accepted synthesis. If `usableFinal` is false, surface the reasons instead of smoothing them away.
- Use `synthesis.document.recommendedSections` for long-form documents.
- Use `synthesis.slides.recommendedSlides` for slide outlines.
- Use the appropriate document, PDF, or presentation skill for native `.docx`, `.pdf`, or `.pptx` output. Delve itself does not create those final native deliverables.

## Rules

- Prefer `--json` for commands Codex will parse.
- Keep live write behavior scoped to `research run`; `request` is read-only.
- Preserve `finalizationBlockedBeforeNegotiation` as provenance, but trust `qualityGate.usableFinal` as the final machine-readable quality signal.
- Inspect `blackboard topology` after `--topology dynamic-revision`.
- Do not print or pass `CORAL_API_KEY` or `EXA_API_KEY` on the command line.
