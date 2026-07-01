import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

test("doctor --json reports readiness without leaking secret values", async () => {
  const secret = "sk-test-secret-that-must-not-leak";
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--json", "doctor", "--coral-url", "http://127.0.0.1:9"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CORAL_API_KEY: secret,
        OPENROUTER_API_KEY: secret,
        EXA_API_KEY: secret
      }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stdout.includes(secret), false);
  const report = JSON.parse(result.stdout) as {
    ok: boolean;
    env: Record<string, { present: boolean; source: string }>;
    coral: { reachable: boolean };
  };
  assert.equal(report.env.CORAL_API_KEY.present, true);
  assert.equal(report.env.OPENROUTER_API_KEY.present, true);
  assert.equal(report.env.EXA_API_KEY.present, true);
  assert.equal(report.coral.reachable, false);
});

test("offline fixture research run records blackboard negotiation and writes markdown artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-cli-"));
  try {
    const dbPath = path.join(dir, "blackboard.db");
    const outDir = path.join(dir, "artifacts");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--json",
        "research",
        "run",
        "--topic",
        "optimisation techniques for real-time voice agents",
        "--format",
        "markdown",
        "--db",
        dbPath,
        "--out",
        outDir,
        "--offline-fixture"
      ],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      runId: string;
      finalizationBlockedBeforeNegotiation: boolean;
      agentsCount: number;
      markdownPath: string;
      finalPackagePath: string;
      negotiation: { status: string };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.finalizationBlockedBeforeNegotiation, true);
    assert.equal(payload.agentsCount, 3);
    assert.equal(payload.negotiation.status, "complete_with_dissent");
    assert.equal(existsSync(payload.markdownPath), true);
    assert.equal(existsSync(payload.finalPackagePath), true);

    const markdown = await readFile(payload.markdownPath, "utf8");
    assert.match(markdown, /# Research: optimisation techniques for real-time voice agents/);
    assert.match(markdown, /## Codex Synthesis Handoff/);
    assert.match(markdown, /## Sources/);
    assert.match(markdown, /## Negotiation/);
    assert.match(markdown, /Dissent/);

    const finalPackage = JSON.parse(await readFile(payload.finalPackagePath, "utf8")) as {
      sources: unknown[];
      runQuality: {
        degradedWork: unknown[];
        revisionRequests: unknown[];
        dissentingVerdicts: unknown[];
      };
      synthesis: {
        document: { recommendedSections: unknown[] };
        slides: { recommendedSlides: unknown[] };
      };
    };
    assert.equal(finalPackage.sources.length, 3);
    assert.equal(finalPackage.runQuality.degradedWork.length, 0);
    assert.equal(finalPackage.runQuality.revisionRequests.length, 1);
    assert.equal(finalPackage.runQuality.dissentingVerdicts.length, 2);
    assert.equal(finalPackage.synthesis.document.recommendedSections.length, 4);
    assert.equal(finalPackage.synthesis.slides.recommendedSlides.length, 4);

    const sourcesResult = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--json",
        "blackboard",
        "sources",
        "--run",
        payload.runId,
        "--db",
        dbPath
      ],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    assert.equal(sourcesResult.status, 0, sourcesResult.stderr);
    assert.equal(JSON.parse(sourcesResult.stdout).length, 3);

    const qualityResult = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--json",
        "blackboard",
        "quality",
        "--run",
        payload.runId,
        "--db",
        dbPath
      ],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    assert.equal(qualityResult.status, 0, qualityResult.stderr);
    const quality = JSON.parse(qualityResult.stdout) as {
      degradedWork: unknown[];
      revisionRequests: unknown[];
      dissentingVerdicts: unknown[];
    };
    assert.equal(quality.degradedWork.length, 0);
    assert.equal(quality.revisionRequests.length, 1);
    assert.equal(quality.dissentingVerdicts.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("offline dynamic-revision run records inspectable topology trace", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-cli-topology-"));
  try {
    const dbPath = path.join(dir, "blackboard.db");
    const outDir = path.join(dir, "artifacts");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--json",
        "research",
        "run",
        "--topic",
        "dynamic topology for agentic deep research",
        "--format",
        "markdown",
        "--db",
        dbPath,
        "--out",
        outDir,
        "--offline-fixture",
        "--topology",
        "dynamic-revision"
      ],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      runId: string;
      finalPackagePath: string;
      topology: { mode: string; revisionTasks: unknown[]; openRevisionTasks: unknown[] };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.topology.mode, "dynamic-revision");
    assert.equal(payload.topology.revisionTasks.length, 1);
    assert.equal(payload.topology.openRevisionTasks.length, 0);

    const finalPackage = JSON.parse(await readFile(payload.finalPackagePath, "utf8")) as {
      topologyTrace: {
        mode: string;
        events: unknown[];
        revisionTasks: Array<{ status: string; assignedAgents: string[] }>;
        openRevisionTasks: unknown[];
      };
      markdown: string;
    };
    assert.equal(finalPackage.topologyTrace.mode, "dynamic-revision");
    assert.equal(finalPackage.topologyTrace.revisionTasks[0]?.status, "resolved");
    assert.deepEqual(finalPackage.topologyTrace.revisionTasks[0]?.assignedAgents, ["systems-researcher"]);
    assert.equal(finalPackage.topologyTrace.openRevisionTasks.length, 0);
    assert.match(finalPackage.markdown, /## Topology Trace/);

    const topologyResult = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--json",
        "blackboard",
        "topology",
        "--run",
        payload.runId,
        "--db",
        dbPath
      ],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    assert.equal(topologyResult.status, 0, topologyResult.stderr);
    const topology = JSON.parse(topologyResult.stdout) as {
      mode: string;
      events: unknown[];
      revisionTasks: unknown[];
      openRevisionTasks: unknown[];
    };
    assert.equal(topology.mode, "dynamic-revision");
    assert.equal(topology.events.length > 0, true);
    assert.equal(topology.revisionTasks.length, 1);
    assert.equal(topology.openRevisionTasks.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
