#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { config as loadEnv } from "dotenv";

import { getCodexSkillStatus, installCodexSkill, type CodexSkillStatus, type InstallCodexSkillResult } from "./codex-skill.js";
import { createDoctorReport } from "./doctor.js";
import type { DoctorReport } from "./doctor.js";
import type { TopologyMode } from "./blackboard.js";

const PROJECT_ROOT = resolveProjectRoot(import.meta.dirname);
loadEnv({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
loadEnv({ quiet: true });
const DEFAULT_WORK_ROOT = process.cwd();
const DEFAULT_DB = path.join(DEFAULT_WORK_ROOT, ".delve", "blackboard.db");
const DEFAULT_OUT = path.join(DEFAULT_WORK_ROOT, "artifacts");
const DEFAULT_CORAL_URL = process.env.CORAL_SERVER_URL ?? "http://localhost:5555";

interface GlobalOptions {
  json?: boolean;
}

const program = new Command();
program
  .name("delve")
  .description("Multi-agent deep research CLI using Coral coordination, Eve agents, and a SQLite blackboard.")
  .option("--json", "emit stable JSON to stdout")
  .version(readPackageVersion(PROJECT_ROOT));

program
  .command("doctor")
  .description("Verify env vars, SQLite path, Coral reachability, model route, and agent manifests.")
  .option("--coral-url <url>", "Coral server base URL", DEFAULT_CORAL_URL)
  .option("--db <path>", "SQLite blackboard path", DEFAULT_DB)
  .action(async (options: { coralUrl: string; db: string }) => {
    const report = await createDoctorReport({
      coralUrl: options.coralUrl,
      dbPath: path.resolve(options.db),
      projectRoot: PROJECT_ROOT,
      env: process.env
    });
    output(report);
  });

program
  .command("init")
  .description("Print local setup paths and config expectations.")
  .option("--db <path>", "SQLite blackboard path", DEFAULT_DB)
  .option("--out <path>", "artifact output directory", DEFAULT_OUT)
  .option("--coral-url <url>", "Coral server base URL", DEFAULT_CORAL_URL)
  .action(async (options: { db: string; out: string; coralUrl: string }) => {
    const report = await createInitReport(options);
    outputWithHuman(report, formatInitReport(report));
  });

const codex = program.command("codex").description("Manage Codex integration helpers.");

codex
  .command("skill-status")
  .description("Inspect whether the packaged Delve Codex skill is installed.")
  .option("--target <path>", "target skill directory; defaults to ${CODEX_HOME:-~/.codex}/skills/delve")
  .action(async (options: { target?: string }) => {
    const status = await getCodexSkillStatus({
      projectRoot: PROJECT_ROOT,
      env: process.env,
      targetPath: options.target
    });
    outputWithHuman(status, formatSkillStatus(status));
  });

codex
  .command("install-skill")
  .description("Install or update the packaged Delve Codex skill.")
  .option("--target <path>", "target skill directory; defaults to ${CODEX_HOME:-~/.codex}/skills/delve")
  .option("--force", "overwrite an existing non-matching skill")
  .option("--dry-run", "show what would be copied without writing files")
  .action(async (options: { target?: string; force?: boolean; dryRun?: boolean }) => {
    const result = await installCodexSkill({
      projectRoot: PROJECT_ROOT,
      env: process.env,
      targetPath: options.target,
      force: options.force,
      dryRun: options.dryRun
    });
    outputWithHuman(result, formatInstallSkillResult(result));
  });

const research = program.command("research").description("Run and inspect research workflows.");

research
  .command("run")
  .description("Run a research topic through the blackboard and negotiation flow.")
  .requiredOption("--topic <topic>", "research topic")
  .option("--format <format>", "artifact format", "markdown")
  .option("--db <path>", "SQLite blackboard path", DEFAULT_DB)
  .option("--out <path>", "artifact output directory", DEFAULT_OUT)
  .option("--coral-url <url>", "Coral server base URL for live mode", DEFAULT_CORAL_URL)
  .option("--auth-key <key>", "Coral server bearer key for live mode", process.env.CORAL_SERVER_AUTH_KEY ?? "dev")
  .option("--live-timeout-ms <ms>", "live Coral wait timeout in milliseconds", "600000")
  .option("--coral-start-timeout-ms <ms>", "Coral auto-start readiness timeout in milliseconds", "120000")
  .option("--topology <mode>", "coordination topology mode: fixed or dynamic-revision", "fixed")
  .option("--offline-fixture", "run deterministic local fixture instead of live Coral")
  .action(
    async (options: {
      topic: string;
      format: "markdown" | "json" | "docx" | "slides";
      db: string;
      out: string;
      coralUrl: string;
      authKey: string;
      liveTimeoutMs: string;
      coralStartTimeoutMs: string;
      topology: string;
      offlineFixture?: boolean;
    }) => {
      const { runResearch } = await import("./research-runner.js");
      const topologyMode = parseTopologyMode(options.topology);
      const result = await runResearch({
        topic: options.topic,
        format: options.format,
        dbPath: path.resolve(options.db),
        outDir: path.resolve(options.out),
        offlineFixture: Boolean(options.offlineFixture),
        coralUrl: options.coralUrl,
        coralAuthKey: options.authKey,
        liveTimeoutMs: Number(options.liveTimeoutMs),
        coralStartTimeoutMs: Number(options.coralStartTimeoutMs),
        topologyMode
      });
      output(result);
    }
  );

const blackboard = program.command("blackboard").description("Inspect app-owned SQLite blackboard state.");

blackboard
  .command("notes")
  .description("List notes for a run.")
  .requiredOption("--run <runId>", "run id")
  .option("--db <path>", "SQLite blackboard path", DEFAULT_DB)
  .action(async (options: { run: string; db: string }) => {
    const { Blackboard } = await import("./blackboard.js");
    output(new Blackboard(path.resolve(options.db)).listNotes(options.run));
  });

blackboard
  .command("claims")
  .description("List claims for a run.")
  .requiredOption("--run <runId>", "run id")
  .option("--db <path>", "SQLite blackboard path", DEFAULT_DB)
  .action(async (options: { run: string; db: string }) => {
    const { Blackboard } = await import("./blackboard.js");
    output(new Blackboard(path.resolve(options.db)).listClaims(options.run));
  });

blackboard
  .command("sources")
  .description("List deduplicated sources for a run.")
  .requiredOption("--run <runId>", "run id")
  .option("--db <path>", "SQLite blackboard path", DEFAULT_DB)
  .action(async (options: { run: string; db: string }) => {
    const { Blackboard } = await import("./blackboard.js");
    output(new Blackboard(path.resolve(options.db)).listSources(options.run));
  });

blackboard
  .command("negotiation")
  .description("List negotiation rounds for a run.")
  .requiredOption("--run <runId>", "run id")
  .option("--db <path>", "SQLite blackboard path", DEFAULT_DB)
  .action(async (options: { run: string; db: string }) => {
    const { Blackboard } = await import("./blackboard.js");
    output(new Blackboard(path.resolve(options.db)).listNegotiationRounds(options.run));
  });

blackboard
  .command("quality")
  .description("Summarize degraded work, revision requests, and dissent for a run.")
  .requiredOption("--run <runId>", "run id")
  .option("--db <path>", "SQLite blackboard path", DEFAULT_DB)
  .action(async (options: { run: string; db: string }) => {
    const { Blackboard } = await import("./blackboard.js");
    output(new Blackboard(path.resolve(options.db)).summarizeRunQuality(options.run));
  });

blackboard
  .command("topology")
  .description("Inspect topology trace events and revision task state for a run.")
  .requiredOption("--run <runId>", "run id")
  .option("--db <path>", "SQLite blackboard path", DEFAULT_DB)
  .action(async (options: { run: string; db: string }) => {
    const { Blackboard } = await import("./blackboard.js");
    output(new Blackboard(path.resolve(options.db)).summarizeTopology(options.run));
  });

program
  .command("final")
  .description("Read a final package JSON artifact.")
  .requiredOption("--file <path>", "final-package.json path")
  .action(async (options: { file: string }) => {
    output(JSON.parse(await readFile(path.resolve(options.file), "utf8")) as unknown);
  });

program
  .command("request")
  .description("Read-only Coral HTTP escape hatch.")
  .argument("<path>", "Coral API path, for example /api_v1.json")
  .option("--coral-url <url>", "Coral server base URL", DEFAULT_CORAL_URL)
  .action(async (requestPath: string, options: { coralUrl: string }) => {
    if (!requestPath.startsWith("/")) throw new Error("request path must start with /");
    const response = await fetch(new URL(requestPath, ensureTrailingSlash(options.coralUrl)));
    const text = await response.text();
    output({
      ok: response.ok,
      status: response.status,
      body: parseMaybeJson(text)
    });
    if (!response.ok) process.exitCode = 1;
  });

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (
    error instanceof CommanderError &&
    (error.code === "commander.helpDisplayed" || error.code === "commander.version")
  ) {
    process.exitCode = 0;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson()) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  }
}

function output(value: unknown): void {
  if ((program.opts<GlobalOptions>().json ?? false) || wantsJson()) {
    console.log(JSON.stringify(value, null, 2));
  } else if (typeof value === "string") {
    console.log(value);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

function outputWithHuman(value: unknown, human: string): void {
  if ((program.opts<GlobalOptions>().json ?? false) || wantsJson()) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(human);
  }
}

function wantsJson(): boolean {
  return process.argv.includes("--json");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseTopologyMode(value: string): TopologyMode {
  if (value === "fixed" || value === "dynamic-revision") return value;
  throw new Error(`Unsupported topology mode: ${value}`);
}

interface InitReport {
  ok: boolean;
  packageRoot: string;
  workDir: string;
  dbPath: string;
  outDir: string;
  coralConfig: string;
  doctor: DoctorReport;
  codexSkill: CodexSkillStatus;
  nextSteps: string[];
}

async function createInitReport(options: { db: string; out: string; coralUrl: string }): Promise<InitReport> {
  const dbPath = path.resolve(options.db);
  const outDir = path.resolve(options.out);
  const doctor = await createDoctorReport({
    coralUrl: options.coralUrl,
    dbPath,
    projectRoot: PROJECT_ROOT,
    env: process.env
  });
  const codexSkill = await getCodexSkillStatus({
    projectRoot: PROJECT_ROOT,
    env: process.env
  });
  const nextSteps = buildInitNextSteps(doctor, codexSkill);
  return {
    ok: doctor.ok && codexSkill.sourceExists,
    packageRoot: PROJECT_ROOT,
    workDir: DEFAULT_WORK_ROOT,
    dbPath,
    outDir,
    coralConfig: path.join(PROJECT_ROOT, "coral-config.toml"),
    doctor,
    codexSkill,
    nextSteps
  };
}

function buildInitNextSteps(doctor: DoctorReport, codexSkill: CodexSkillStatus): string[] {
  const steps: string[] = [];
  if (!codexSkill.installed || !codexSkill.matchesPackagedSkill) {
    steps.push("delve codex install-skill");
  }
  if (!doctor.env.EXA_API_KEY.present) {
    steps.push("export EXA_API_KEY=...");
  }
  if (!doctor.env.CORAL_API_KEY.present && !doctor.env.OPENROUTER_API_KEY.present) {
    steps.push("export CORAL_API_KEY=... # or export OPENROUTER_API_KEY=...");
  }
  steps.push("delve --json doctor");
  steps.push("delve --json research run --topic \"your topic\" --format markdown --db .delve/blackboard.db --out artifacts");
  return steps;
}

function formatInitReport(report: InitReport): string {
  const lines = [
    "Delve setup",
    "",
    `Package root: ${report.packageRoot}`,
    `Working directory: ${report.workDir}`,
    `Blackboard DB: ${report.dbPath}`,
    `Artifacts: ${report.outDir}`,
    `Coral config: ${report.coralConfig}`,
    "",
    "Required credentials:",
    `  ${statusMark(report.doctor.env.EXA_API_KEY.present)} EXA_API_KEY`,
    `  ${statusMark(report.doctor.env.CORAL_API_KEY.present || report.doctor.env.OPENROUTER_API_KEY.present)} CORAL_API_KEY or OPENROUTER_API_KEY`,
    "",
    "Optional tooling:",
    `  ${statusMark(report.doctor.tooling.latex.available)} LaTeX compiler (tectonic, pdflatex, or latexmk)`,
    "",
    "Codex skill:",
    `  ${statusMark(report.codexSkill.installed && report.codexSkill.matchesPackagedSkill)} ${report.codexSkill.targetPath}`,
    report.codexSkill.installed && !report.codexSkill.matchesPackagedSkill
      ? "  Existing skill differs from the packaged skill; run `delve codex install-skill --force` to replace it."
      : "",
    "",
    "Coral:",
    `  ${report.doctor.coral.reachable ? "[reachable]" : "[auto-start]"} ${report.doctor.coral.url}`,
    "  Live research runs auto-start local loopback Coral URLs when needed.",
    "",
    "Next steps:",
    ...report.nextSteps.map((step, index) => `  ${index + 1}. ${step}`)
  ].filter((line) => line !== "");
  return lines.join("\n");
}

function formatSkillStatus(status: CodexSkillStatus): string {
  return [
    "Delve Codex skill",
    `Source: ${status.sourcePath}`,
    `Target: ${status.targetPath}`,
    `Source exists: ${status.sourceExists ? "yes" : "no"}`,
    `Installed: ${status.installed ? "yes" : "no"}`,
    `Matches package: ${status.matchesPackagedSkill ? "yes" : "no"}`
  ].join("\n");
}

function formatInstallSkillResult(result: InstallCodexSkillResult): string {
  return [
    "Delve Codex skill",
    `Action: ${result.action}`,
    `Source: ${result.sourcePath}`,
    `Target: ${result.targetPath}`,
    `Files: ${result.files.join(", ")}`,
    result.dryRun ? "No files were written because --dry-run was set." : "Done."
  ].join("\n");
}

function statusMark(ok: boolean): string {
  return ok ? "[ok]" : "[missing]";
}

function readPackageVersion(projectRoot: string): string {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolveProjectRoot(moduleDir: string): string {
  if (path.basename(moduleDir) === "src" && path.basename(path.dirname(moduleDir)) === "dist") {
    return path.resolve(moduleDir, "../..");
  }
  return path.resolve(moduleDir, "..");
}
