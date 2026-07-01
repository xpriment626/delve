import { spawn, type ChildProcessByStdio } from "node:child_process";
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

export async function ensureCoralServerReady(options: EnsureCoralServerOptions): Promise<ManagedCoralServer> {
  if (await probeCoralServer(options.coralUrl)) {
    return { started: false, stop: async () => {} };
  }

  if (!canAutoStartCoralUrl(options.coralUrl)) {
    throw new Error(`Coral server is not reachable at ${options.coralUrl}; auto-start only supports explicit local HTTP ports`);
  }

  const child = spawn("npx", buildCoralServerStartArgs(options.coralUrl), {
    cwd: options.projectRoot,
    env: buildCoralServerEnv(options.projectRoot, options.env),
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

export function buildCoralServerEnv(projectRoot: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    CONFIG_FILE_PATH: path.join(projectRoot, "coral-config.toml")
  };
  if (!nextEnv.CLOUD_API_KEY && nextEnv.CORAL_API_KEY) {
    nextEnv.CLOUD_API_KEY = nextEnv.CORAL_API_KEY;
  }
  return nextEnv;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
