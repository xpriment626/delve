import { CORAL_PROXY_MODEL, OPENROUTER_BASE_URL, OPENROUTER_FALLBACK_MODEL } from "./model-routing.js";

export type AgentModelProvider = "coral" | "openrouter" | "none";

export interface AgentModelRoute {
  provider: AgentModelProvider;
  model: string;
  baseUrl: string;
  reason: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JsonModelResult {
  ok: boolean;
  route: AgentModelRoute;
  data?: unknown;
  text?: string;
  error?: string;
}

export function resolveAgentModelRoute(env: NodeJS.ProcessEnv): AgentModelRoute {
  const coralProxyUrl = env.CORAL_PROXY_URL_CORAL_MAIN;
  if (coralProxyUrl) {
    return {
      provider: "coral",
      model: env.CORAL_PROXY_MODEL_CORAL_MAIN ?? env.MODEL_NAME ?? CORAL_PROXY_MODEL,
      baseUrl: coralProxyUrl,
      reason: "coral_runtime_proxy_url"
    };
  }

  if (env.OPENROUTER_API_KEY) {
    return {
      provider: "openrouter",
      model: env.OPENROUTER_FALLBACK_MODEL ?? OPENROUTER_FALLBACK_MODEL,
      baseUrl: OPENROUTER_BASE_URL,
      reason: "coral_proxy_url_missing"
    };
  }

  return {
    provider: "none",
    model: env.MODEL_NAME ?? CORAL_PROXY_MODEL,
    baseUrl: "",
    reason: "no_model_route_available"
  };
}

export async function generateJsonWithModel(input: {
  route: AgentModelRoute;
  messages: ChatMessage[];
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<JsonModelResult> {
  if (input.route.provider === "none") {
    return { ok: false, route: input.route, error: "no_model_route_available" };
  }
  if (input.route.provider === "openrouter" && !input.apiKey) {
    return { ok: false, route: input.route, error: "missing_openrouter_api_key" };
  }

  const endpoint =
    input.route.provider === "coral"
      ? new URL("v1/chat/completions", ensureTrailingSlash(input.route.baseUrl)).toString()
      : new URL("chat/completions", ensureTrailingSlash(input.route.baseUrl)).toString();
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (input.route.provider === "openrouter") {
    headers.Authorization = `Bearer ${input.apiKey}`;
    headers["HTTP-Referer"] = "http://localhost/delve";
    headers["X-Title"] = "delve";
  }

  try {
    const requestBody: Record<string, unknown> = {
      model: input.route.model,
      messages: input.messages,
      temperature: input.temperature ?? 0.1,
      max_tokens: input.maxTokens ?? 1600,
      response_format: { type: "json_object" }
    };
    if (input.route.provider === "openrouter") {
      requestBody.reasoning = { effort: "minimal", exclude: true };
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });
    const responseBody = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        route: input.route,
        error: `model_http_${response.status}:${responseBody.slice(0, 500)}`
      };
    }

    const parsed = JSON.parse(responseBody) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = parsed.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: false, route: input.route, error: "model_empty_content" };
    try {
      const data = JSON.parse(extractJsonObject(content)) as unknown;
      return { ok: true, route: input.route, data, text: content };
    } catch (error) {
      return {
        ok: false,
        route: input.route,
        text: content,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  } catch (error) {
    return {
      ok: false,
      route: input.route,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function extractJsonObject(text: string): string {
  const withoutFence = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("No JSON object found in model response");
  return withoutFence.slice(start, end + 1);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
