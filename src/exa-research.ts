import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { SourceRef } from "./blackboard.js";

export interface ExaResearchResult {
  ok: boolean;
  query: string;
  sources: SourceRef[];
  error?: string;
}

export interface CollectExaSourcesOptions {
  query: string;
  exaApiKey?: string;
  numResults?: number;
  fetchMaxCharacters?: number;
}

export async function collectExaSources(options: CollectExaSourcesOptions): Promise<ExaResearchResult> {
  if (!options.exaApiKey) {
    return {
      ok: false,
      query: options.query,
      sources: [],
      error: "missing_exa_api_key"
    };
  }

  const params = new URLSearchParams({
    tools: "web_search_exa,web_fetch_exa,web_search_advanced_exa",
    exaApiKey: options.exaApiKey
  });
  const client = new Client({ name: "delve-exa-research", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`https://mcp.exa.ai/mcp?${params.toString()}`));

  try {
    await client.connect(transport);
    const searchResult = await client.callTool({
      name: "web_search_exa",
      arguments: {
        query: options.query,
        numResults: options.numResults ?? 5
      }
    });
    const searchText = extractToolText(searchResult);
    const searchSources = parseExaTextResults(searchText);
    const urls = searchSources.slice(0, 4).map((source) => source.url);
    if (urls.length === 0) {
      return { ok: true, query: options.query, sources: [] };
    }

    const fetchResult = await client.callTool({
      name: "web_fetch_exa",
      arguments: {
        urls,
        maxCharacters: options.fetchMaxCharacters ?? 3000
      }
    });
    const fetchedSources = parseExaTextResults(extractToolText(fetchResult));
    return {
      ok: true,
      query: options.query,
      sources: mergeSources(searchSources, fetchedSources)
    };
  } catch (error) {
    return {
      ok: false,
      query: options.query,
      sources: [],
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export function parseExaTextResults(text: string, retrievedAt = new Date().toISOString()): SourceRef[] {
  const blocks = text
    .split(/\n\s*---\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  const sources: SourceRef[] = [];
  for (const block of blocks) {
    const title = matchLine(block, "Title");
    const url = matchLine(block, "URL");
    if (!title || !url) continue;
    const publishedAt = matchLine(block, "Published");
    const author = matchLine(block, "Author");
    const excerpt = extractExcerpt(block);
    sources.push({
      title,
      url,
      domain: domainFromUrl(url),
      publisher: author && author !== "N/A" ? author : domainFromUrl(url),
      publishedAt: publishedAt && publishedAt !== "N/A" ? publishedAt : undefined,
      retrievedAt,
      excerpt,
      summary: excerpt,
      relevance: "Matched the agent's role-specific research query.",
      reliability: classifyReliability(url)
    });
  }
  return sources;
}

function mergeSources(primary: SourceRef[], fetched: SourceRef[]): SourceRef[] {
  const byUrl = new Map(primary.map((source) => [source.url, source]));
  for (const source of fetched) {
    const existing = byUrl.get(source.url);
    if (!existing) {
      byUrl.set(source.url, source);
      continue;
    }
    byUrl.set(source.url, {
      ...existing,
      excerpt: source.excerpt ?? existing.excerpt,
      summary: source.summary ?? existing.summary,
      publisher: existing.publisher ?? source.publisher,
      publishedAt: existing.publishedAt ?? source.publishedAt,
      retrievedAt: source.retrievedAt ?? existing.retrievedAt
    });
  }
  return [...byUrl.values()];
}

function extractToolText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content
    .map((item) => (item.type === "text" && item.text ? item.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function matchLine(block: string, label: string): string | undefined {
  const match = block.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function extractExcerpt(block: string): string {
  const withoutHeaders = block
    .split("\n")
    .filter((line) => !/^(Title|URL|Published|Author):/i.test(line.trim()))
    .join("\n")
    .replace(/^Highlights:\s*/im, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return withoutHeaders.slice(0, 1800);
}

function domainFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function classifyReliability(url: string): string {
  const domain = domainFromUrl(url) ?? "";
  if (domain.endsWith("arxiv.org") || domain.endsWith("doi.org")) return "research paper or scholarly index";
  if (domain.includes("github.com")) return "source repository";
  if (domain.includes("docs.") || domain.includes("developer.") || domain.includes("api.")) return "official technical documentation";
  if (domain.includes("wikipedia.org")) return "tertiary overview; verify important claims elsewhere";
  return "web source; use alongside corroborating evidence";
}
