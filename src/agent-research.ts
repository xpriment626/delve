import type { ClaimRecord, NoteRecord, SourceRef, VerdictStance } from "./blackboard.js";
import { collectExaSources } from "./exa-research.js";
import { generateJsonWithModel, resolveAgentModelRoute, type AgentModelRoute, type ChatMessage } from "./llm-client.js";
import { OPENROUTER_BASE_URL, OPENROUTER_FALLBACK_MODEL } from "./model-routing.js";

export interface AgentResearchClaim {
  claim: string;
  confidence: number;
  caveats: string[];
  sourceUrls: string[];
}

export interface AgentResearchOutput {
  angle: string;
  content: string;
  sources: SourceRef[];
  claims: AgentResearchClaim[];
  searchQuery: string;
  modelRoute: AgentModelRoute;
  modelUsed: boolean;
  sourceError?: string;
  modelError?: string;
}

export interface AgentNegotiationOutput {
  stance: VerdictStance;
  rationale: string;
  transcript: string;
  modelRoute: AgentModelRoute;
  modelUsed: boolean;
  modelError?: string;
}

export interface AgentRevisionOutput extends AgentResearchOutput {
  revisionTaskId: string;
  revisionRationale: string;
}

interface RoleProfile {
  angle: string;
  lens: string;
  queryTerms: string;
  negotiationBias: VerdictStance;
}

const ROLE_PROFILES: Record<string, RoleProfile> = {
  "latency-researcher": {
    angle: "performance and timing constraints",
    lens:
      "Find the highest-leverage performance, latency, sequencing, throughput, and time-to-value techniques. Treat speed claims as useful only when evidence explains where the bottleneck lives.",
    queryTerms: "performance latency bottlenecks optimisation techniques benchmarks best practices",
    negotiationBias: "accept"
  },
  "systems-researcher": {
    angle: "systems architecture and implementation tradeoffs",
    lens:
      "Find architecture, integration, deployment, data-flow, reliability, observability, and operational tradeoffs. Challenge claims that ignore production constraints.",
    queryTerms: "architecture implementation systems tradeoffs reliability observability deployment",
    negotiationBias: "revise"
  },
  "quality-researcher": {
    angle: "quality evaluation and user impact",
    lens:
      "Find evaluation criteria, robustness concerns, UX or stakeholder impact, safety/compliance risks, and evidence gaps. Challenge claims that over-optimize one metric while degrading quality.",
    queryTerms: "evaluation quality user impact robustness risks measurement caveats",
    negotiationBias: "dissent"
  }
};

export function buildRoleResearchQuery(role: string, topic: string): string {
  const profile = profileFor(role);
  return `${topic} ${profile.queryTerms}. Prefer primary sources, technical reports, benchmarks, documentation, case studies, and recent credible analysis.`;
}

export async function researchRole(input: {
  role: string;
  topic: string;
  env: NodeJS.ProcessEnv;
}): Promise<AgentResearchOutput> {
  const profile = profileFor(input.role);
  const searchQuery = buildRoleResearchQuery(input.role, input.topic);
  const sourceResult = await collectExaSources({
    query: searchQuery,
    exaApiKey: input.env.EXA_API_KEY,
    numResults: 5,
    fetchMaxCharacters: 3500
  });
  const modelRoute = resolveAgentModelRoute(input.env);
  const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a specialist research agent inside Delve. Produce compact valid JSON only, with no markdown, comments, or trailing commas. Ground every claim in the supplied sources. Do not invent citations."
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "Create a blackboard research note and claims for this specialist angle.",
          topic: input.topic,
          role: input.role,
          angle: profile.angle,
          lens: profile.lens,
          outputSchema: {
            angle: "short angle label",
            content: "2-4 concise paragraphs with source-grounded findings and caveats",
            claims: [
              {
                claim: "specific evidence-backed claim",
                confidence: "number from 0.1 to 0.95",
                caveats: ["specific caveat or uncertainty"],
                sourceUrls: ["URLs from supplied sources only"]
              }
            ]
          },
          sources: sourceResult.sources.map(sourceForPrompt)
        })
      }
    ];
  const modelResult = await generateJsonWithFallback({
    primaryRoute: modelRoute,
    apiKey: input.env.OPENROUTER_API_KEY,
    maxTokens: 3200,
    messages
  });

  if (modelResult.ok) {
    const normalized = normalizeResearchOutput(modelResult.data, profile, sourceResult.sources);
    if (normalized) {
      return {
        ...normalized,
        searchQuery,
        sources: sourceResult.sources,
        modelRoute,
        modelUsed: true,
        ...(sourceResult.error ? { sourceError: sourceResult.error } : {})
      };
    }
  }

  return {
    ...buildExtractiveResearchOutput(input.topic, profile, sourceResult.sources),
    searchQuery,
    modelRoute,
    modelUsed: false,
    ...(sourceResult.error ? { sourceError: sourceResult.error } : {}),
    ...(modelResult.error ? { modelError: modelResult.error } : {})
  };
}

export async function negotiateRole(input: {
  role: string;
  topic: string;
  notes: NoteRecord[];
  claims: ClaimRecord[];
  env: NodeJS.ProcessEnv;
}): Promise<AgentNegotiationOutput> {
  const profile = profileFor(input.role);
  const modelRoute = resolveAgentModelRoute(input.env);
  const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a debate agent in Delve's blocking negotiation phase. Return compact valid JSON only, with no markdown, comments, or trailing commas. Be specific about source quality, weak claims, missing caveats, and consensus or dissent."
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "Review the blackboard and record this role's verdict before finalization.",
          topic: input.topic,
          role: input.role,
          angle: profile.angle,
          lens: profile.lens,
          allowedStances: ["accept", "revise", "dissent"],
          outputSchema: {
            stance: "accept | revise | dissent",
            rationale: "specific rationale for this verdict",
            transcript: "substantive debate summary referencing notes, claims, source quality, gaps, and caveats"
          },
          notes: input.notes.map((note) => ({
            id: note.id,
            agentName: note.agentName,
            angle: note.angle,
            content: note.content.slice(0, 1800),
            sources: note.sources.map(sourceForPrompt)
          })),
          claims: input.claims.map((claim) => ({
            id: claim.id,
            agentName: claim.agentName,
            claim: claim.claim,
            confidence: claim.confidence,
            caveats: claim.caveats,
            sourceUrls: claim.sourceUrls
          }))
        })
      }
    ];
  const modelResult = await generateJsonWithFallback({
    primaryRoute: modelRoute,
    apiKey: input.env.OPENROUTER_API_KEY,
    maxTokens: 2200,
    messages
  });

  if (modelResult.ok) {
    const normalized = normalizeNegotiationOutput(modelResult.data, profile);
    if (normalized) {
      return {
        ...normalized,
        modelRoute,
        modelUsed: true
      };
    }
  }

  return {
    ...buildHeuristicNegotiation(input.topic, profile, input.notes, input.claims),
    modelRoute,
    modelUsed: false,
    ...(modelResult.error ? { modelError: modelResult.error } : {})
  };
}

export async function reviseRole(input: {
  role: string;
  topic: string;
  revisionTaskId: string;
  revisionRationale: string;
  notes: NoteRecord[];
  claims: ClaimRecord[];
  env: NodeJS.ProcessEnv;
}): Promise<AgentRevisionOutput> {
  const revisionTopic = `${input.topic}. Targeted revision request: ${input.revisionRationale}`;
  const research = await researchRole({
    role: input.role,
    topic: revisionTopic,
    env: input.env
  });
  const priorContext = [
    `${input.notes.length} prior notes`,
    `${input.claims.length} prior claims`
  ].join(", ");
  return {
    ...research,
    revisionTaskId: input.revisionTaskId,
    revisionRationale: input.revisionRationale,
    angle: `revision follow-up: ${research.angle}`,
    content:
      `Revision task ${input.revisionTaskId}: ${input.revisionRationale}\n\n` +
      `Context reviewed: ${priorContext}.\n\n` +
      research.content
  };
}

async function generateJsonWithFallback(input: {
  primaryRoute: AgentModelRoute;
  apiKey?: string;
  maxTokens: number;
  messages: Parameters<typeof generateJsonWithModel>[0]["messages"];
}) {
  const primary = await generateJsonWithModel({
    route: input.primaryRoute,
    apiKey: input.apiKey,
    maxTokens: input.maxTokens,
    messages: input.messages
  });
  if (primary.ok || input.primaryRoute.provider !== "coral" || !input.apiKey) return primary;
  return generateJsonWithModel({
    route: {
      provider: "openrouter",
      model: OPENROUTER_FALLBACK_MODEL,
      baseUrl: OPENROUTER_BASE_URL,
      reason: `fallback_after_${input.primaryRoute.reason}`
    },
    apiKey: input.apiKey,
    maxTokens: input.maxTokens,
    messages: input.messages
  });
}

function normalizeResearchOutput(
  value: unknown,
  profile: RoleProfile,
  sources: SourceRef[]
): Pick<AgentResearchOutput, "angle" | "content" | "claims"> | undefined {
  const data = value as {
    angle?: unknown;
    content?: unknown;
    claims?: unknown;
  };
  if (typeof data.content !== "string" || !Array.isArray(data.claims)) return undefined;
  const allowedUrls = new Set(sources.map((source) => source.url));
  const claims = data.claims
    .map((claim): AgentResearchClaim | undefined => {
      const c = claim as {
        claim?: unknown;
        confidence?: unknown;
        caveats?: unknown;
        sourceUrls?: unknown;
      };
      if (typeof c.claim !== "string") return undefined;
      const sourceUrls = Array.isArray(c.sourceUrls)
        ? c.sourceUrls.filter((url): url is string => typeof url === "string" && allowedUrls.has(url))
        : [];
      return {
        claim: c.claim.trim(),
        confidence: clampConfidence(typeof c.confidence === "number" ? c.confidence : Number(c.confidence)),
        caveats: Array.isArray(c.caveats)
          ? c.caveats.filter((item): item is string => typeof item === "string").slice(0, 5)
          : [],
        sourceUrls
      };
    })
    .filter((claim): claim is AgentResearchClaim => Boolean(claim))
    .slice(0, 3);
  if (claims.length === 0) return undefined;
  return {
    angle: typeof data.angle === "string" && data.angle.trim() ? data.angle.trim() : profile.angle,
    content: data.content.trim(),
    claims
  };
}

function buildExtractiveResearchOutput(
  topic: string,
  profile: RoleProfile,
  sources: SourceRef[]
): Pick<AgentResearchOutput, "angle" | "content" | "sources" | "claims"> {
  const usefulSources = sources.slice(0, 4);
  const evidenceLines = usefulSources
    .map((source) => {
      const excerpt = source.excerpt || source.summary || "No excerpt was available.";
      return `${source.title} (${source.domain ?? source.url}) reports: ${excerpt}`;
    })
    .join("\n\n");
  const content =
    usefulSources.length > 0
      ? `From the ${profile.angle} angle, ${topic} should be evaluated through this lens: ${profile.lens}\n\n${evidenceLines}`
      : `From the ${profile.angle} angle, ${topic} could not be grounded in live Exa sources in this run. Treat this note as a degraded fallback and rerun before producing a user-facing artifact.`;
  return {
    angle: profile.angle,
    content,
    sources: usefulSources,
    claims: [
      {
        claim:
          usefulSources.length > 0
            ? `${topic} has support for ${profile.angle} recommendations, but those recommendations should stay tied to the cited evidence and caveats.`
            : `${topic} needs a live-source rerun before strong recommendations are made.`,
        confidence: usefulSources.length > 0 ? 0.62 : 0.2,
        caveats:
          usefulSources.length > 0
            ? ["Extractive fallback was used because the model synthesis route failed or was unavailable."]
            : ["No live sources were available to this agent."],
        sourceUrls: usefulSources.map((source) => source.url)
      }
    ]
  };
}

function normalizeNegotiationOutput(
  value: unknown,
  profile: RoleProfile
): Pick<AgentNegotiationOutput, "stance" | "rationale" | "transcript"> | undefined {
  const data = value as { stance?: unknown; rationale?: unknown; transcript?: unknown };
  if (typeof data.rationale !== "string" || typeof data.transcript !== "string") return undefined;
  const stance = data.stance === "accept" || data.stance === "revise" || data.stance === "dissent"
    ? data.stance
    : profile.negotiationBias;
  return {
    stance,
    rationale: data.rationale.trim(),
    transcript: data.transcript.trim()
  };
}

function buildHeuristicNegotiation(
  topic: string,
  profile: RoleProfile,
  notes: NoteRecord[],
  claims: ClaimRecord[]
): Pick<AgentNegotiationOutput, "stance" | "rationale" | "transcript"> {
  const sourcedClaimCount = claims.filter((claim) => claim.sourceUrls.length > 0).length;
  const averageConfidence =
    claims.length === 0 ? 0 : claims.reduce((sum, claim) => sum + claim.confidence, 0) / claims.length;
  const caveatCount = claims.reduce((sum, claim) => sum + claim.caveats.length, 0);
  const sourceCount = new Set(notes.flatMap((note) => note.sources.map((source) => source.url))).size;
  let stance = profile.negotiationBias;
  if (sourceCount < notes.length || sourcedClaimCount < claims.length) stance = "revise";
  if (averageConfidence < 0.5) stance = "dissent";
  if (profile.negotiationBias === "dissent" && caveatCount === 0) stance = "dissent";

  return {
    stance,
    rationale:
      stance === "accept"
        ? "The blackboard has enough source-grounded claims to support synthesis, with caveats retained."
        : stance === "revise"
          ? "The final artifact should revise claims that lack direct source URLs or operational caveats."
          : "The blackboard still contains quality or evidence risks that should be explicit in the final artifact.",
    transcript:
      `${profile.angle} reviewed ${notes.length} notes, ${claims.length} claims, and ${sourceCount} unique sources for ${topic}. ` +
      `The review checked source grounding (${sourcedClaimCount}/${claims.length} sourced claims), average confidence (${averageConfidence.toFixed(2)}), and caveat coverage (${caveatCount} caveats).`
  };
}

function sourceForPrompt(source: SourceRef): Record<string, unknown> {
  return {
    title: source.title,
    url: source.url,
    domain: source.domain,
    publisher: source.publisher,
    publishedAt: source.publishedAt,
    excerpt: (source.excerpt ?? source.summary ?? "").slice(0, 900),
    reliability: source.reliability
  };
}

function profileFor(role: string): RoleProfile {
  return ROLE_PROFILES[role] ?? {
    angle: role.replace(/-/g, " "),
    lens: "Find source-grounded findings, tradeoffs, and caveats for the assigned research angle.",
    queryTerms: "evidence research analysis tradeoffs caveats",
    negotiationBias: "revise"
  };
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.55;
  return Math.max(0.1, Math.min(0.95, value));
}
