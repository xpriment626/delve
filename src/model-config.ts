import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseEnv } from "dotenv";

import { authConfigPath } from "./auth-config.js";
import { DEFAULT_CORAL_PROXY_MODELS, resolveConfiguredModel } from "./model-routing.js";

export interface ModelStatus {
  configPath: string;
  model: string;
  source: "env" | "config" | "default";
}

export interface SetModelResult extends ModelStatus {
  ok: true;
}

export interface ModelListResult {
  ok: true;
  configPath: string;
  selectedModel: string;
  source: "cloud" | "proxy" | "configured";
  models: string[];
  proxyUrl?: string;
}

const CORAL_CLOUD_MODEL_ENDPOINTS = [
  "https://llm.coralcloud.ai/deepseek/v1/models",
  "https://llm.coralcloud.ai/openai/v1/models"
] as const;

export async function getModelStatus(env: NodeJS.ProcessEnv, configPath?: string): Promise<ModelStatus> {
  const resolvedPath = authConfigPath(env, configPath);
  const config = await readLocalConfig(resolvedPath);
  if (hasValue(config.DELVE_MODEL) && env.DELVE_MODEL === config.DELVE_MODEL) {
    return {
      configPath: resolvedPath,
      model: config.DELVE_MODEL.trim(),
      source: "config"
    };
  }
  if (hasValue(env.DELVE_MODEL) || hasValue(env.MODEL_NAME)) {
    return {
      configPath: resolvedPath,
      model: resolveConfiguredModel(env),
      source: "env"
    };
  }
  if (hasValue(config.DELVE_MODEL)) {
    return {
      configPath: resolvedPath,
      model: config.DELVE_MODEL.trim(),
      source: "config"
    };
  }
  return {
    configPath: resolvedPath,
    model: resolveConfiguredModel({}),
    source: "default"
  };
}

export async function setConfiguredModel(input: {
  model: string;
  env: NodeJS.ProcessEnv;
  configPath?: string;
}): Promise<SetModelResult> {
  const model = normalizeModelName(input.model);
  const configPath = authConfigPath(input.env, input.configPath);
  const config = await readLocalConfig(configPath);
  config.DELVE_MODEL = model;
  await writeLocalConfig(configPath, config);
  return {
    ok: true,
    configPath,
    model,
    source: "config"
  };
}

export async function listModels(input: {
  env: NodeJS.ProcessEnv;
  configPath?: string;
  proxyUrl?: string;
}): Promise<ModelListResult> {
  const status = await getModelStatus(input.env, input.configPath);
  const proxyUrl = firstNonEmpty(input.proxyUrl, input.env.CORAL_PROXY_URL_CORAL_MAIN, input.env.CORAL_PROXY_URL_MAIN);
  if (proxyUrl) {
    const models = await fetchModels(openAiEndpoint(proxyUrl, "models"));
    return {
      ok: true,
      configPath: status.configPath,
      selectedModel: status.model,
      source: "proxy",
      proxyUrl,
      models: ensureSelectedModel(models, status.model)
    };
  }
  const apiKey = firstNonEmpty(input.env.CORAL_API_KEY, (await readLocalConfig(status.configPath)).CORAL_API_KEY);
  if (apiKey) {
    const models = await fetchCoralCloudModels(apiKey);
    if (models.length > 0) {
      return {
        ok: true,
        configPath: status.configPath,
        selectedModel: status.model,
        source: "cloud",
        models: ensureSelectedModel(models, status.model)
      };
    }
  }
  return {
    ok: true,
    configPath: status.configPath,
    selectedModel: status.model,
    source: "configured",
    models: ensureSelectedModel([...DEFAULT_CORAL_PROXY_MODELS], status.model)
  };
}

export async function readLocalConfig(configPath: string): Promise<Record<string, string>> {
  try {
    return parseEnv(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeLocalConfig(configPath: string, values: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(configPath), 0o700).catch(() => undefined);
  await writeFile(configPath, serializeLocalConfig(values), { mode: 0o600 });
  await chmod(configPath, 0o600);
}

export function normalizeModelName(value: string): string {
  const model = value.trim();
  if (!model) throw new Error("model cannot be empty");
  if (model.length > 128) throw new Error("model cannot be longer than 128 characters");
  return model;
}

async function fetchCoralCloudModels(apiKey: string): Promise<string[]> {
  const settled = await Promise.allSettled(
    CORAL_CLOUD_MODEL_ENDPOINTS.map((endpoint) => fetchModels(endpoint, { Authorization: `Bearer ${apiKey}` }))
  );
  return [
    ...new Set(
      settled.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    )
  ].sort();
}

async function fetchModels(url: string, headers: Record<string, string> = {}): Promise<string[]> {
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`model_list_http_${response.status}:${text.slice(0, 500)}`);
  const data = JSON.parse(text) as { data?: Array<{ id?: unknown }> };
  const models = (data.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return [...new Set(models)].sort();
}

function ensureSelectedModel(models: string[], selectedModel: string): string[] {
  const values = new Set(models);
  values.add(selectedModel);
  return [...values].sort();
}

function serializeLocalConfig(values: Record<string, string>): string {
  const lines = Object.keys(values)
    .filter((key) => hasValue(values[key]))
    .sort()
    .map((key) => `${key}=${JSON.stringify(values[key])}`);
  return `${lines.join("\n")}\n`;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function openAiEndpoint(baseUrl: string, path: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const openAiBase = normalized.endsWith("/v1") ? `${normalized}/` : `${normalized}/v1/`;
  return new URL(path, openAiBase).toString();
}
