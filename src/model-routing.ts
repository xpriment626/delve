export type ModelProvider = "coral";

export interface ModelRoute {
  provider: ModelProvider;
  model: string;
  baseUrl: string;
  reason: string;
}

export interface ModelRouteInput {
  coralProxyReady: boolean;
  coralApiKeyPresent: boolean;
  configuredModel?: string;
}

export interface SecretStatus {
  present: boolean;
  source: "env" | "missing";
}

export const DEFAULT_CORAL_PROXY_MODEL = "deepseek-v4-pro";
export const DEFAULT_CORAL_PROXY_MODELS = ["deepseek-v4-flash", DEFAULT_CORAL_PROXY_MODEL] as const;
export const CORAL_MAIN_PROXY_NAME = "CORAL_MAIN";
export const CORAL_CLOUD_DEEPSEEK_CONFIGURATION = "coral-cloud-deepseek";
export const CORAL_CLOUD_OPENAI_CONFIGURATION = "coral-cloud-openai";
export const CORAL_CLOUD_DEEPSEEK_BASE_URL = "https://llm.coralcloud.ai/deepseek/v1";
export const CORAL_CLOUD_OPENAI_BASE_URL = "https://llm.coralcloud.ai/openai/v1";

export function chooseModelRoute(input: ModelRouteInput): ModelRoute {
  const model = input.configuredModel ?? DEFAULT_CORAL_PROXY_MODEL;
  if (input.coralApiKeyPresent) {
    return {
      provider: "coral",
      model,
      baseUrl: coralCloudBaseUrlForModel(model),
      reason: "coral_cloud_llm_proxy"
    };
  }

  return {
    provider: "coral",
    model,
    baseUrl: "coral-cloud-llm-proxy",
    reason: "coral_api_key_missing"
  };
}

export function resolveConfiguredModel(env: NodeJS.ProcessEnv): string {
  return firstNonEmpty(env.DELVE_MODEL, env.MODEL_NAME) ?? DEFAULT_CORAL_PROXY_MODEL;
}

export function coralCloudConfigurationForModel(model: string): string {
  return model.trim().toLowerCase().startsWith("deepseek")
    ? CORAL_CLOUD_DEEPSEEK_CONFIGURATION
    : CORAL_CLOUD_OPENAI_CONFIGURATION;
}

export function coralCloudBaseUrlForModel(model: string): string {
  return coralCloudConfigurationForModel(model) === CORAL_CLOUD_DEEPSEEK_CONFIGURATION
    ? CORAL_CLOUD_DEEPSEEK_BASE_URL
    : CORAL_CLOUD_OPENAI_BASE_URL;
}

export function redactSecretStatus(value: string | undefined): SecretStatus {
  return value && value.length > 0 ? { present: true, source: "env" } : { present: false, source: "missing" };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}
