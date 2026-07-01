import { defineMcpClientConnection } from "eve/connections";

const params = new URLSearchParams({
  tools: "web_search_exa,web_fetch_exa,web_search_advanced_exa"
});

if (process.env.EXA_API_KEY) params.set("exaApiKey", process.env.EXA_API_KEY);

export default defineMcpClientConnection({
  url: `https://mcp.exa.ai/mcp?${params.toString()}`,
  description:
    "Exa web research MCP connection for finding sources, fetching pages, and grounding deep research claims.",
  tools: { allow: ["web_search_exa", "web_fetch_exa", "web_search_advanced_exa"] }
});
