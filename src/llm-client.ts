import { coralCloudBaseUrlForModel, DEFAULT_CORAL_PROXY_MODEL, resolveConfiguredModel } from "./model-routing.js";

export type AgentModelProvider = "coral" | "none";

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
  const model = resolveConfiguredModel(env);
  if (env.CORAL_API_KEY) {
    return {
      provider: "coral",
      model,
      baseUrl: coralCloudBaseUrlForModel(model),
      reason: "coral_cloud_llm_proxy"
    };
  }

  const coralProxyUrl = env.CORAL_PROXY_URL_CORAL_MAIN;
  if (coralProxyUrl) {
    return {
      provider: "coral",
      model: env.CORAL_PROXY_MODEL_CORAL_MAIN ?? model,
      baseUrl: coralProxyUrl,
      reason: "coral_runtime_proxy_url"
    };
  }

  return {
    provider: "none",
    model: model ?? DEFAULT_CORAL_PROXY_MODEL,
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
  const endpoint = openAiEndpoint(input.route.baseUrl, "chat/completions");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
  };

  try {
    const requestBody: Record<string, unknown> = {
      model: input.route.model,
      messages: input.messages,
      temperature: input.temperature ?? 0.1,
      max_tokens: input.maxTokens ?? 1600,
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: "json_object" }
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      const responseBody = await response.text();
      return {
        ok: false,
        route: input.route,
        error: `model_http_${response.status}:${responseBody.slice(0, 500)}`
      };
    }

    const content = (await readStreamingContent(response)).trim();
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

async function readStreamingContent(response: Response): Promise<string> {
  if (!response.body) throw new Error("model_stream_missing_body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex >= 0) {
        content += contentFromStreamEvent(buffer.slice(0, separatorIndex));
        buffer = buffer.slice(separatorIndex + 2);
        separatorIndex = buffer.indexOf("\n\n");
      }
    }
    if (done) break;
  }
  buffer += decoder.decode().replace(/\r\n/g, "\n");
  if (buffer.trim()) content += contentFromStreamEvent(buffer);
  return content;
}

function contentFromStreamEvent(rawEvent: string): string {
  let content = "";
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (const data of dataLines) {
    if (data === "[DONE]") continue;
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    for (const choice of parsed.choices ?? []) {
      if (typeof choice.delta?.content === "string") content += choice.delta.content;
    }
  }
  return content;
}

export function extractJsonObject(text: string): string {
  const withoutFence = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("No JSON object found in model response");
  return withoutFence.slice(start, end + 1);
}

function openAiEndpoint(baseUrl: string, path: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const openAiBase = normalized.endsWith("/v1") ? `${normalized}/` : `${normalized}/v1/`;
  return new URL(path, openAiBase).toString();
}
