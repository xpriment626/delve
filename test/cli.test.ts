import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_VERSION = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const TSX_LOADER = path.join(ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const CLI_PATH = path.join(ROOT, "src", "cli.ts");

test("--version prints package version and exits successfully", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), PACKAGE_VERSION);
  assert.equal(result.stderr.trim(), "");
});

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

test("init prints onboarding with Codex skill install guidance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-init-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI_PATH,
        "init",
        "--db",
        path.join(dir, "blackboard.db"),
        "--out",
        path.join(dir, "artifacts"),
        "--coral-url",
        "http://127.0.0.1:9"
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: path.join(dir, "codex-home")
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Delve setup/);
    assert.match(result.stdout, /delve codex install-skill/);
    assert.match(result.stdout, /codex-home\/skills\/delve/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init prepares working directories for the default blackboard and artifacts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-init-paths-"));
  try {
    const dbPath = path.join(dir, ".delve", "blackboard.db");
    const outDir = path.join(dir, "artifacts");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI_PATH,
        "init",
        "--db",
        dbPath,
        "--out",
        outDir,
        "--coral-url",
        "http://127.0.0.1:9"
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: path.join(dir, "codex-home")
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal((await stat(path.dirname(dbPath))).isDirectory(), true);
    assert.equal((await stat(outDir)).isDirectory(), true);
    assert.match(result.stdout, /directory ready/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auth set stores token from stdin in private Delve config used by doctor", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-auth-"));
  const secret = "sk-test-openrouter-config-secret";
  try {
    const env = {
      ...process.env,
      DELVE_HOME: path.join(dir, ".delve"),
      EXA_API_KEY: "exa-test-secret"
    };
    delete env.CORAL_API_KEY;
    delete env.OPENROUTER_API_KEY;

    const setResult = spawnSync(
      process.execPath,
      ["--import", TSX_LOADER, CLI_PATH, "--json", "auth", "set", "openrouter", "--stdin"],
      {
        cwd: dir,
        encoding: "utf8",
        input: `${secret}\n`,
        env
      }
    );

    assert.equal(setResult.status, 0, setResult.stderr);
    assert.equal(setResult.stdout.includes(secret), false);
    const setPayload = JSON.parse(setResult.stdout) as { key: string; configPath: string };
    assert.equal(setPayload.key, "OPENROUTER_API_KEY");
    assert.equal(setPayload.configPath, path.join(dir, ".delve", "config.env"));

    const configStat = await stat(setPayload.configPath);
    assert.equal(configStat.mode & 0o777, 0o600);
    const configText = await readFile(setPayload.configPath, "utf8");
    assert.match(configText, /OPENROUTER_API_KEY=/);
    assert.match(configText, new RegExp(secret));

    const doctor = spawnSync(
      process.execPath,
      ["--import", TSX_LOADER, CLI_PATH, "--json", "doctor", "--coral-url", "http://127.0.0.1:9"],
      {
        cwd: dir,
        encoding: "utf8",
        env
      }
    );

    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(doctor.stdout.includes(secret), false);
    const report = JSON.parse(doctor.stdout) as {
      env: { OPENROUTER_API_KEY: { present: boolean; source: string } };
    };
    assert.equal(report.env.OPENROUTER_API_KEY.present, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("codex install-skill copies packaged skill and protects existing edits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-skill-"));
  try {
    const target = path.join(dir, "skills", "delve");
    const dryRun = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--json", "codex", "install-skill", "--target", target, "--dry-run"],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).action, "dry-run-install");
    assert.equal(existsSync(target), false);

    const install = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--json", "codex", "install-skill", "--target", target],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    assert.equal(install.status, 0, install.stderr);
    assert.equal(JSON.parse(install.stdout).action, "install");
    assert.equal(existsSync(path.join(target, "SKILL.md")), true);
    assert.equal(existsSync(path.join(target, "agents", "openai.yaml")), true);

    const alreadyInstalled = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--json", "codex", "install-skill", "--target", target],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    assert.equal(alreadyInstalled.status, 0, alreadyInstalled.stderr);
    assert.equal(JSON.parse(alreadyInstalled.stdout).action, "already-installed");

    await writeFile(path.join(target, "SKILL.md"), "locally changed\n", "utf8");
    const blockedOverwrite = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--json", "codex", "install-skill", "--target", target],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    assert.equal(blockedOverwrite.status, 1);
    assert.match(JSON.parse(blockedOverwrite.stdout).error, /--force/);

    const forced = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--json", "codex", "install-skill", "--target", target, "--force"],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(JSON.parse(forced.stdout).action, "overwrite");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uninstall previews and removes Delve home plus the installed Codex skill", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-uninstall-"));
  try {
    const delveHome = path.join(dir, ".delve");
    const codexHome = path.join(dir, ".codex");
    const skillTarget = path.join(codexHome, "skills", "delve");
    await mkdir(delveHome, { recursive: true });
    await writeFile(path.join(delveHome, "config.env"), "EXA_API_KEY=test\n", "utf8");

    const install = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--json", "codex", "install-skill", "--target", skillTarget],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    assert.equal(install.status, 0, install.stderr);

    const env = {
      ...process.env,
      DELVE_HOME: delveHome,
      CODEX_HOME: codexHome
    };
    const dryRun = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--json", "uninstall", "--dry-run"], {
      cwd: ROOT,
      encoding: "utf8",
      env
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryRunPayload = JSON.parse(dryRun.stdout) as {
      dryRun: boolean;
      wouldRemove: string[];
      nextStep: string;
    };
    assert.equal(dryRunPayload.dryRun, true);
    assert.deepEqual(dryRunPayload.wouldRemove.sort(), [delveHome, skillTarget].sort());
    assert.match(dryRunPayload.nextStep, /npm uninstall -g @itsshadowai\/delve/);
    assert.equal(existsSync(delveHome), true);
    assert.equal(existsSync(skillTarget), true);

    const uninstall = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--json", "uninstall"], {
      cwd: ROOT,
      encoding: "utf8",
      env
    });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const payload = JSON.parse(uninstall.stdout) as {
      ok: boolean;
      removed: string[];
      nextStep: string;
    };
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.removed.sort(), [delveHome, skillTarget].sort());
    assert.match(payload.nextStep, /npm uninstall -g @itsshadowai\/delve/);
    assert.equal(existsSync(delveHome), false);
    assert.equal(existsSync(skillTarget), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
