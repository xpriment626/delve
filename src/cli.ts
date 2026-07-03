#!/usr/bin/env node
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { config as loadEnv } from "dotenv";

import { authConfigPath, getAuthStatus, parseAuthProvider, resolveDelveHome, setAuthToken, AUTH_ENV_BY_PROVIDER, type SetAuthTokenResult, type AuthStatus } from "./auth-config.js";
import { getCodexSkillStatus, installCodexSkill, type CodexSkillStatus, type InstallCodexSkillResult } from "./codex-skill.js";
import { createDoctorReport } from "./doctor.js";
import { getModelStatus, listModels, setConfiguredModel, type ModelListResult, type ModelStatus, type SetModelResult } from "./model-config.js";
import type { DoctorReport } from "./doctor.js";
import type { TopologyMode } from "./blackboard.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolveProjectRoot(MODULE_DIR);
loadEnv({ quiet: true });
loadEnv({ path: authConfigPath(process.env), quiet: true });
loadEnv({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
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
  .description("Prepare local output directories and print setup expectations.")
  .option("--db <path>", "SQLite blackboard path", DEFAULT_DB)
  .option("--out <path>", "artifact output directory", DEFAULT_OUT)
  .option("--coral-url <url>", "Coral server base URL", DEFAULT_CORAL_URL)
  .action(async (options: { db: string; out: string; coralUrl: string }) => {
    const report = await createInitReport(options);
    outputWithHuman(report, formatInitReport(report));
  });

program
  .command("uninstall")
  .description("Remove Delve-owned local state before uninstalling the npm package.")
  .option("--dry-run", "show what would be removed without deleting files")
  .option("--force", "remove the Codex skill even if it differs from the packaged skill")
  .action(async (options: { dryRun?: boolean; force?: boolean }) => {
    const report = await createUninstallReport({
      dryRun: Boolean(options.dryRun),
      force: Boolean(options.force)
    });
    outputWithHuman(report, formatUninstallReport(report));
    if (!report.ok) process.exitCode = 1;
  });

const auth = program.command("auth").description("Manage Delve credentials in a private local config file.");

auth
  .command("set")
  .description("Store a credential without putting the secret in shell history.")
  .argument("<provider>", "credential provider: coral or exa")
  .option("--stdin", "read the token from stdin instead of a hidden prompt")
  .option("--config <path>", "credential config path; defaults to ${DELVE_HOME:-~/.delve}/config.env")
  .action(async (providerValue: string, options: { stdin?: boolean; config?: string }) => {
    await handleAuthSet(providerValue, options);
  });

auth
  .command("status")
  .description("Show which Delve credentials are configured without printing values.")
  .option("--config <path>", "credential config path; defaults to ${DELVE_HOME:-~/.delve}/config.env")
  .action(async (options: { config?: string }) => {
    const status = await getAuthStatus(process.env, options.config);
    outputWithHuman(status, formatAuthStatus(status));
  });

const set = program.command("set").description("Canonical Delve configuration shortcuts.");

set
  .command("auth")
  .description("Store a credential without putting the secret in shell history.")
  .argument("<provider>", "credential provider: coral or exa")
  .option("--stdin", "read the token from stdin instead of a hidden prompt")
  .option("--config <path>", "credential config path; defaults to ${DELVE_HOME:-~/.delve}/config.env")
  .action(async (providerValue: string, options: { stdin?: boolean; config?: string }) => {
    await handleAuthSet(providerValue, options);
  });

set
  .command("model")
  .description("Set the Coral LLM proxy model used by Delve agents.")
  .argument("<model>", "model id, for example deepseek-v4-pro")
  .option("--config <path>", "local config path; defaults to ${DELVE_HOME:-~/.delve}/config.env")
  .action(async (modelName: string, options: { config?: string }) => {
    await handleModelSet(modelName, options);
  });

const model = program.command("model").description("Inspect or set the Coral LLM proxy model used by Delve agents.");

model
  .command("status")
  .description("Show the configured Delve model.")
  .option("--config <path>", "local config path; defaults to ${DELVE_HOME:-~/.delve}/config.env")
  .action(async (options: { config?: string }) => {
    const status = await getModelStatus(process.env, options.config);
    outputWithHuman(status, formatModelStatus(status));
  });

model
  .command("list")
  .description("List selectable Delve models, optionally from a Coral proxy URL.")
  .option("--config <path>", "local config path; defaults to ${DELVE_HOME:-~/.delve}/config.env")
  .option("--proxy-url <url>", "OpenAI-compatible Coral proxy URL; when set, reads <url>/v1/models")
  .action(async (options: { config?: string; proxyUrl?: string }) => {
    const result = await listModels({
      env: process.env,
      configPath: options.config,
      proxyUrl: options.proxyUrl
    });
    outputWithHuman(result, formatModelList(result));
  });

model
  .command("set")
  .description("Set the Coral LLM proxy model used by Delve agents.")
  .argument("<model>", "model id, for example deepseek-v4-pro")
  .option("--config <path>", "local config path; defaults to ${DELVE_HOME:-~/.delve}/config.env")
  .action(async (modelName: string, options: { config?: string }) => {
    await handleModelSet(modelName, options);
  });

model
  .command("select")
  .description("Select the Delve model from an arrow-key terminal menu.")
  .option("--config <path>", "local config path; defaults to ${DELVE_HOME:-~/.delve}/config.env")
  .option("--proxy-url <url>", "OpenAI-compatible Coral proxy URL; when set, reads <url>/v1/models")
  .action(async (options: { config?: string; proxyUrl?: string }) => {
    const result = await listModels({
      env: process.env,
      configPath: options.config,
      proxyUrl: options.proxyUrl
    });
    const selected = await selectModelFromMenu(result.models, result.selectedModel);
    const setResult = await setConfiguredModel({
      model: selected,
      env: process.env,
      configPath: options.config
    });
    process.env.DELVE_MODEL = setResult.model;
    outputWithHuman({ ...setResult, availableModels: result.models, listSource: result.source }, formatModelSetResult(setResult));
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
  preparedPaths: {
    blackboardDir: string;
    artifactsDir: string;
  };
  credentialConfig: string;
  coralConfig: string;
  doctor: DoctorReport;
  codexSkill: CodexSkillStatus;
  nextSteps: string[];
}

interface UninstallReport {
  ok: boolean;
  dryRun: boolean;
  force: boolean;
  paths: {
    delveHome: string;
    codexSkill: string;
  };
  removed: string[];
  wouldRemove: string[];
  missing: string[];
  skipped: Array<{
    path: string;
    reason: string;
  }>;
  nextStep: string;
}

async function createInitReport(options: { db: string; out: string; coralUrl: string }): Promise<InitReport> {
  const dbPath = path.resolve(options.db);
  const outDir = path.resolve(options.out);
  const preparedPaths = await prepareInitPaths(dbPath, outDir);
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
    preparedPaths,
    credentialConfig: authConfigPath(process.env),
    coralConfig: path.join(PROJECT_ROOT, "coral-config.toml"),
    doctor,
    codexSkill,
    nextSteps
  };
}

async function createUninstallReport(options: { dryRun: boolean; force: boolean }): Promise<UninstallReport> {
  const delveHome = path.resolve(resolveDelveHome(process.env));
  const codexSkill = await getCodexSkillStatus({
    projectRoot: PROJECT_ROOT,
    env: process.env
  });
  const report: UninstallReport = {
    ok: true,
    dryRun: options.dryRun,
    force: options.force,
    paths: {
      delveHome,
      codexSkill: codexSkill.targetPath
    },
    removed: [],
    wouldRemove: [],
    missing: [],
    skipped: [],
    nextStep: "npm uninstall -g @itsshadowai/delve"
  };

  await markOrRemovePath(report, delveHome);

  if (codexSkill.targetExists && !codexSkill.matchesPackagedSkill && !options.force) {
    report.skipped.push({
      path: codexSkill.targetPath,
      reason: "Codex skill exists but differs from the packaged Delve skill; pass --force to remove it"
    });
  } else {
    await markOrRemovePath(report, codexSkill.targetPath);
  }

  report.ok = report.skipped.length === 0;
  return report;
}

async function markOrRemovePath(report: UninstallReport, targetPath: string): Promise<void> {
  ensureSafeCleanupPath(targetPath);
  if (!(await pathExists(targetPath))) {
    report.missing.push(targetPath);
    return;
  }
  if (report.dryRun) {
    report.wouldRemove.push(targetPath);
    return;
  }
  await rm(targetPath, { recursive: true, force: true });
  report.removed.push(targetPath);
}

function ensureSafeCleanupPath(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  const unsafePaths = new Set([parsed.root, path.resolve(homedir()), path.resolve(process.cwd())]);
  if (unsafePaths.has(resolved)) {
    throw new Error(`Refusing to remove unsafe path: ${targetPath}`);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function buildInitNextSteps(doctor: DoctorReport, codexSkill: CodexSkillStatus): string[] {
  const steps: string[] = [];
  if (!codexSkill.installed || !codexSkill.matchesPackagedSkill) {
    steps.push("delve codex install-skill");
  }
  if (!doctor.env.EXA_API_KEY.present) {
    steps.push("delve set auth exa");
  }
  if (!doctor.env.CORAL_API_KEY.present) {
    steps.push("delve set auth coral");
  }
  steps.push("delve model select # or: delve model set deepseek-v4-pro");
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
    `Blackboard DB: ${report.dbPath} (directory ready)`,
    `Artifacts: ${report.outDir} (directory ready)`,
    `Credential config: ${report.credentialConfig}`,
    `Coral config: ${report.coralConfig}`,
    "",
    "Required credentials:",
    `  ${statusMark(report.doctor.env.EXA_API_KEY.present)} EXA_API_KEY`,
    `  ${statusMark(report.doctor.env.CORAL_API_KEY.present)} CORAL_API_KEY`,
    "",
    "Model:",
    `  ${report.doctor.model.model} (${report.doctor.model.reason})`,
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

function formatUninstallReport(report: UninstallReport): string {
  const lines = [
    "Delve uninstall cleanup",
    "",
    `Mode: ${report.dryRun ? "dry run" : "remove"}`,
    `Delve home: ${formatCleanupStatus(report, report.paths.delveHome)}`,
    `Codex skill: ${formatCleanupStatus(report, report.paths.codexSkill)}`,
    report.skipped.length > 0 ? "" : undefined,
    ...report.skipped.map((item) => `Skipped: ${item.path} (${item.reason})`),
    "",
    `Next step: ${report.nextStep}`
  ].filter((line): line is string => typeof line === "string");
  return lines.join("\n");
}

function formatCleanupStatus(report: UninstallReport, targetPath: string): string {
  if (report.removed.includes(targetPath)) return `[removed] ${targetPath}`;
  if (report.wouldRemove.includes(targetPath)) return `[would remove] ${targetPath}`;
  if (report.missing.includes(targetPath)) return `[missing] ${targetPath}`;
  const skipped = report.skipped.find((item) => item.path === targetPath);
  if (skipped) return `[skipped] ${targetPath}`;
  return `[unchanged] ${targetPath}`;
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

function formatModelStatus(status: ModelStatus): string {
  return [
    "Delve model",
    `Model: ${status.model}`,
    `Source: ${status.source}`,
    `Config: ${status.configPath}`
  ].join("\n");
}

function formatModelList(result: ModelListResult): string {
  return [
    "Delve models",
    `Selected: ${result.selectedModel}`,
    `Source: ${result.source}${result.proxyUrl ? ` (${result.proxyUrl})` : ""}`,
    `Config: ${result.configPath}`,
    "",
    ...result.models.map((model) => `${model === result.selectedModel ? "*" : " "} ${model}`)
  ].join("\n");
}

function formatModelSetResult(result: SetModelResult): string {
  return [
    "Delve model",
    `Stored: ${result.model}`,
    `Config: ${result.configPath}`
  ].join("\n");
}

function statusMark(ok: boolean): string {
  return ok ? "[ok]" : "[missing]";
}

async function prepareInitPaths(dbPath: string, outDir: string): Promise<InitReport["preparedPaths"]> {
  const blackboardDir = path.dirname(dbPath);
  await mkdir(blackboardDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  return {
    blackboardDir,
    artifactsDir: outDir
  };
}

async function handleAuthSet(providerValue: string, options: { stdin?: boolean; config?: string }): Promise<void> {
  const provider = parseAuthProvider(providerValue);
  const token = options.stdin
    ? await readSecretFromStdin()
    : await promptHidden(`Enter ${AUTH_ENV_BY_PROVIDER[provider]}: `);
  const result = await setAuthToken({
    provider,
    token,
    env: process.env,
    configPath: options.config
  });
  process.env[result.key] = token.trim();
  outputWithHuman(result, formatAuthSetResult(result));
}

async function handleModelSet(modelName: string, options: { config?: string }): Promise<void> {
  const result = await setConfiguredModel({
    model: modelName,
    env: process.env,
    configPath: options.config
  });
  process.env.DELVE_MODEL = result.model;
  outputWithHuman(result, formatModelSetResult(result));
}

function formatAuthSetResult(result: SetAuthTokenResult): string {
  return [
    "Delve auth",
    `Stored: ${result.key}`,
    `Config: ${result.configPath}`,
    "Secret value was not printed."
  ].join("\n");
}

function formatAuthStatus(status: AuthStatus): string {
  return [
    "Delve auth",
    `Config: ${status.configPath}`,
    `  ${statusMark(status.keys.EXA_API_KEY.present)} EXA_API_KEY`,
    `  ${statusMark(status.keys.CORAL_API_KEY.present)} CORAL_API_KEY`
  ].join("\n");
}

async function selectModelFromMenu(models: string[], selectedModel: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("No interactive TTY available; use `delve model set <model>` instead");
  }
  if (models.length === 0) throw new Error("No models available to select");

  const maxVisible = 12;
  let index = Math.max(0, models.indexOf(selectedModel));
  let offset = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), Math.max(0, models.length - maxVisible)));
  const stdin = process.stdin;
  const stderr = process.stderr;
  const wasRaw = stdin.isRaw;

  function render(): void {
    offset = Math.min(offset, Math.max(0, models.length - maxVisible));
    if (index < offset) offset = index;
    if (index >= offset + maxVisible) offset = index - maxVisible + 1;
    const visible = models.slice(offset, offset + maxVisible);
    stderr.write("\x1b[2J\x1b[H");
    stderr.write("Select Delve model\n\n");
    for (let row = 0; row < visible.length; row += 1) {
      const model = visible[row];
      const cursor = offset + row === index ? ">" : " ";
      const current = model === selectedModel ? "*" : " ";
      stderr.write(`${cursor} ${current} ${model}\n`);
    }
    stderr.write("\nUse up/down arrows, Enter to select, Ctrl-C to cancel.\n");
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stderr.write("\n");
    };
    const onKeypress = (_char: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("cancelled"));
        return;
      }
      if (key.name === "up") {
        index = Math.max(0, index - 1);
        render();
        return;
      }
      if (key.name === "down") {
        index = Math.min(models.length - 1, index + 1);
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const model = models[index];
        cleanup();
        resolve(model);
      }
    };
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

async function readSecretFromStdin(): Promise<string> {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  return value.trim();
}

async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("No interactive TTY available; pass --stdin to read the token from stdin");
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    const wasRaw = stdin.isRaw;
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const finish = () => {
      stderr.write("\n");
      cleanup();
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          stderr.write("\n");
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
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
