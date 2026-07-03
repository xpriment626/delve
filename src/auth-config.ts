import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseEnv } from "dotenv";

export type AuthProvider = "coral" | "exa";

export const AUTH_ENV_BY_PROVIDER: Record<AuthProvider, "CORAL_API_KEY" | "EXA_API_KEY"> = {
  coral: "CORAL_API_KEY",
  exa: "EXA_API_KEY"
};

const AUTH_KEYS = ["EXA_API_KEY", "CORAL_API_KEY"] as const;
const LOCAL_CONFIG_KEYS = ["CORAL_API_KEY", "DELVE_MODEL", "EXA_API_KEY"] as const;

export interface SetAuthTokenResult {
  ok: true;
  provider: AuthProvider;
  key: (typeof AUTH_KEYS)[number];
  configPath: string;
}

export interface AuthStatus {
  configPath: string;
  keys: Record<(typeof AUTH_KEYS)[number], { present: boolean }>;
}

export function parseAuthProvider(value: string): AuthProvider {
  if (value === "coral" || value === "exa") return value;
  throw new Error("provider must be one of: coral, exa");
}

export function resolveDelveHome(env: NodeJS.ProcessEnv): string {
  return env.DELVE_HOME && env.DELVE_HOME.length > 0 ? env.DELVE_HOME : path.join(homedir(), ".delve");
}

export function authConfigPath(env: NodeJS.ProcessEnv, configPath?: string): string {
  return path.resolve(configPath ?? path.join(resolveDelveHome(env), "config.env"));
}

export async function setAuthToken(input: {
  provider: AuthProvider;
  token: string;
  env: NodeJS.ProcessEnv;
  configPath?: string;
}): Promise<SetAuthTokenResult> {
  const token = input.token.trim();
  if (token.length === 0) throw new Error("token cannot be empty");

  const configPath = authConfigPath(input.env, input.configPath);
  const existing = await readAuthConfig(configPath);
  const key = AUTH_ENV_BY_PROVIDER[input.provider];
  existing[key] = token;

  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(configPath), 0o700).catch(() => undefined);
  await writeFile(configPath, serializeAuthConfig(existing), { mode: 0o600 });
  await chmod(configPath, 0o600);

  return {
    ok: true,
    provider: input.provider,
    key,
    configPath
  };
}

export async function getAuthStatus(env: NodeJS.ProcessEnv, configPath?: string): Promise<AuthStatus> {
  const resolvedPath = authConfigPath(env, configPath);
  const config = await readAuthConfig(resolvedPath);
  return {
    configPath: resolvedPath,
    keys: {
      EXA_API_KEY: { present: hasValue(env.EXA_API_KEY) || hasValue(config.EXA_API_KEY) },
      CORAL_API_KEY: { present: hasValue(env.CORAL_API_KEY) || hasValue(config.CORAL_API_KEY) }
    }
  };
}

async function readAuthConfig(configPath: string): Promise<Record<string, string>> {
  try {
    return parseEnv(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

function serializeAuthConfig(values: Record<string, string>): string {
  const lines = LOCAL_CONFIG_KEYS.filter((key) => hasValue(values[key])).map((key) => `${key}=${quoteEnvValue(values[key])}`);
  return `${lines.join("\n")}\n`;
}

function quoteEnvValue(value: string): string {
  return JSON.stringify(value);
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}
