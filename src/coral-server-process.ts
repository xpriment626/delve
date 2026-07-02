import { spawn, type ChildProcessByStdio } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

type CoralServerChild = ChildProcessByStdio<null, Readable, Readable>;

export interface ManagedCoralServer {
  started: boolean;
  stop(): Promise<void>;
}

export interface EnsureCoralServerOptions {
  coralUrl: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
  log?: (message: string) => void;
}

const SPECIALIST_AGENT_NAMES = ["latency-researcher", "systems-researcher", "quality-researcher"] as const;

export async function ensureCoralServerReady(options: EnsureCoralServerOptions): Promise<ManagedCoralServer> {
  if (await probeCoralServer(options.coralUrl)) {
    return { started: false, stop: async () => {} };
  }

  if (!canAutoStartCoralUrl(options.coralUrl)) {
    throw new Error(`Coral server is not reachable at ${options.coralUrl}; auto-start only supports explicit local HTTP ports`);
  }

  const configPath = await writeRuntimeCoralConfig(options.projectRoot, options.env);
  const child = spawn("npx", buildCoralServerStartArgs(options.coralUrl), {
    cwd: options.projectRoot,
    env: buildCoralServerEnv(options.projectRoot, options.env, configPath),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const log = options.log ?? (() => {});
  let startupFailure: Error | undefined;

  child.stdout.on("data", (chunk: Buffer) => log(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => log(chunk.toString()));
  child.once("error", (error) => {
    startupFailure = error;
  });
  child.once("exit", (code, signal) => {
    if (!startupFailure) {
      startupFailure = new Error(`Coral server exited before readiness (code ${code ?? "null"}, signal ${signal ?? "null"})`);
    }
  });

  try {
    await waitForCoralServer(options.coralUrl, options.startTimeoutMs ?? 120000, () => startupFailure);
    return { started: true, stop: () => stopCoralServer(child) };
  } catch (error) {
    await stopCoralServer(child);
    throw error;
  }
}

export function buildCoralServerEnv(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  configPath = path.join(projectRoot, "coral-config.toml")
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    CONFIG_FILE_PATH: configPath
  };
  if (!nextEnv.CLOUD_API_KEY && nextEnv.CORAL_API_KEY) {
    nextEnv.CLOUD_API_KEY = nextEnv.CORAL_API_KEY;
  }
  return nextEnv;
}

export function buildRuntimeCoralConfig(projectRoot: string): string {
  const agentPaths = SPECIALIST_AGENT_NAMES.map((agentName) => path.resolve(projectRoot, "agents", agentName));
  return [
    "[auth]",
    'keys = ["dev"]',
    "",
    "[registry]",
    "includeCoralHomeAgents = false",
    "localAgents = [",
    ...agentPaths.map((agentPath) => `  ${JSON.stringify(agentPath)},`),
    "]",
    ""
  ].join("\n");
}

export async function writeRuntimeCoralConfig(projectRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
  const delveHome = resolveDelveHome(env);
  const configPath = path.join(delveHome, "coral-config.runtime.toml");
  await mkdir(delveHome, { recursive: true, mode: 0o700 });
  await chmod(delveHome, 0o700);
  await writeFile(configPath, buildRuntimeCoralConfig(projectRoot), { mode: 0o600 });
  await chmod(configPath, 0o600);
  return configPath;
}

export function canAutoStartCoralUrl(coralUrl: string): boolean {
  return coralBindPort(coralUrl) !== undefined;
}

export function buildCoralServerStartArgs(coralUrl: string): string[] {
  const port = coralBindPort(coralUrl);
  if (!port) throw new Error(`Unsupported Coral auto-start URL: ${coralUrl}`);
  const args = ["-y", "coralos-dev@latest", "server", "start"];
  if (port !== "5555") args.push("--", `--network.bind-port=${port}`);
  return args;
}

function coralBindPort(coralUrl: string): string | undefined {
  try {
    const url = new URL(coralUrl);
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (!isLoopback || url.protocol !== "http:" || !url.port) return undefined;
    return url.port;
  } catch {
    return undefined;
  }
}

export async function probeCoralServer(coralUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/api_v1.json", ensureTrailingSlash(coralUrl)), {
      signal: controller.signal
    });
    if (!response.ok) return false;
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForCoralServer(
  coralUrl: string,
  timeoutMs: number,
  startupFailure: () => Error | undefined
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const failure = startupFailure();
    if (failure) throw failure;
    if (await probeCoralServer(coralUrl, 1000)) return;
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for Coral server at ${coralUrl}`);
}

async function stopCoralServer(child: CoralServerChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGINT");
  const stopped = await Promise.race([closed.then(() => true), sleep(5000).then(() => false)]);
  if (stopped) return;
  child.kill("SIGTERM");
  const terminated = await Promise.race([closed.then(() => true), sleep(3000).then(() => false)]);
  if (!terminated) child.kill("SIGKILL");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function resolveDelveHome(env: NodeJS.ProcessEnv): string {
  return env.DELVE_HOME && env.DELVE_HOME.length > 0 ? env.DELVE_HOME : path.join(homedir(), ".delve");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
