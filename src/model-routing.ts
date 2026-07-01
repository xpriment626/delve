export type ModelProvider = "coral" | "openrouter";

export interface ModelRoute {
  provider: ModelProvider;
  model: string;
  baseUrl: string;
  reason: string;
}

export interface ModelRouteInput {
  coralProxyReady: boolean;
  coralApiKeyPresent: boolean;
  openRouterApiKeyPresent: boolean;
}

export interface SecretStatus {
  present: boolean;
  source: "env" | "missing";
}

export const CORAL_PROXY_MODEL = "gpt-5.4-nano";
export const OPENROUTER_FALLBACK_MODEL = "deepseek/deepseek-v4-pro";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function chooseModelRoute(input: ModelRouteInput): ModelRoute {
  if (input.coralProxyReady && input.coralApiKeyPresent) {
    return {
      provider: "coral",
      model: CORAL_PROXY_MODEL,
      baseUrl: "coral-llm-proxy",
      reason: "coral_proxy_ready"
    };
  }

  if (input.openRouterApiKeyPresent) {
    return {
      provider: "openrouter",
      model: OPENROUTER_FALLBACK_MODEL,
      baseUrl: OPENROUTER_BASE_URL,
      reason: input.coralProxyReady ? "coral_api_key_missing" : "coral_proxy_unavailable"
    };
  }

  return {
    provider: "coral",
    model: CORAL_PROXY_MODEL,
    baseUrl: "coral-llm-proxy",
    reason: "no_usable_model_credentials"
  };
}

export function redactSecretStatus(value: string | undefined): SecretStatus {
  return value && value.length > 0 ? { present: true, source: "env" } : { present: false, source: "missing" };
}
