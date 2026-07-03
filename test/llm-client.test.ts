import assert from "node:assert/strict";
import test from "node:test";

import { generateJsonWithModel, resolveAgentModelRoute } from "../src/llm-client.ts";

test("resolveAgentModelRoute prefers Coral Cloud proxy when a Coral API key is available", () => {
  assert.deepEqual(
    resolveAgentModelRoute({
      CORAL_API_KEY: "coral-secret",
      DELVE_MODEL: "deepseek-v4-pro",
      CORAL_PROXY_URL_CORAL_MAIN: "http://localhost:5555/llm-proxy/secret/openai/v1"
    }),
    {
      provider: "coral",
      model: "deepseek-v4-pro",
      baseUrl: "https://llm.coralcloud.ai/deepseek/v1",
      reason: "coral_cloud_llm_proxy"
    }
  );
});

test("generateJsonWithModel streams Coral proxy responses and parses JSON content", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(
        [
          'data: {"choices":[{"delta":{"reasoning_content":"hidden"},"finish_reason":null}]}',
          "",
          'data: {"choices":[{"delta":{"content":"{\\"ok\\":"},"finish_reason":null}]}',
          "",
          'data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      ));
      controller.close();
    },
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  try {
    const result = await generateJsonWithModel({
      route: {
        provider: "coral",
        model: "deepseek-v4-pro",
        baseUrl: "http://localhost:5555/llm-proxy/secret/openai/v1",
        reason: "test",
      },
      apiKey: "coral-secret",
      messages: [{ role: "user", content: "Return JSON." }],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { ok: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://localhost:5555/llm-proxy/secret/openai/v1/chat/completions");
    assert.equal((requests[0].init.headers as Record<string, string>).Authorization, "Bearer coral-secret");
    const body = JSON.parse(String(requests[0].init.body)) as { stream: boolean; response_format?: unknown };
    assert.equal(body.stream, true);
    assert.deepEqual(body.response_format, { type: "json_object" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
