import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Blackboard, FinalizationBlockedError, type ArtifactFormat, type FinalPackage } from "./blackboard.js";
import { CoralClient, type CoralSessionIdentifier } from "./coral-client.js";
import { ensureCoralServerReady, type ManagedCoralServer } from "./coral-server-process.js";
import { CORAL_PROXY_MODEL, OPENROUTER_FALLBACK_MODEL } from "./model-routing.js";

export const SPECIALIST_AGENTS = ["latency-researcher", "systems-researcher", "quality-researcher"] as const;
const PROJECT_ROOT = resolveProjectRoot(import.meta.dirname);

export interface RunResearchOptions {
  topic: string;
  format: ArtifactFormat;
  dbPath: string;
  outDir: string;
  offlineFixture: boolean;
  coralUrl?: string;
  coralAuthKey?: string;
  liveTimeoutMs?: number;
  coralStartTimeoutMs?: number;
}

export interface RunResearchResult {
  ok: true;
  runId: string;
  topic: string;
  agentsCount: number;
  finalizationBlockedBeforeNegotiation: boolean;
  markdownPath: string;
  finalPackagePath: string;
  negotiation: FinalPackage["negotiation"];
  coralSession?: CoralSessionIdentifier;
  coralServer?: {
    autoStarted: boolean;
  };
}

export async function runResearch(options: RunResearchOptions): Promise<RunResearchResult> {
  if (!options.offlineFixture) {
    return runLiveResearch(options);
  }

  await mkdir(path.dirname(options.dbPath), { recursive: true });
  const db = new Blackboard(options.dbPath);
  const run = db.createRun({
    topic: options.topic,
    format: options.format,
    agents: [...SPECIALIST_AGENTS]
  });

  seedOfflineFixture(db, run.id);

  let finalizationBlockedBeforeNegotiation = false;
  try {
    db.finalizeRun(run.id);
  } catch (error) {
    if (error instanceof FinalizationBlockedError) finalizationBlockedBeforeNegotiation = true;
    else throw error;
  }

  db.recordNegotiationRound({
    runId: run.id,
    phase: "debate",
    topic: "Latency versus quality tradeoffs",
    transcript:
      "Latency and systems agents argued for aggressive endpointing; the quality agent challenged this because premature cutoff can harm turn-taking.",
    verdicts: [
      {
        agentName: "latency-researcher",
        stance: "accept",
        rationale: "Streaming and endpointing claims are supported by blackboard notes."
      },
      {
        agentName: "systems-researcher",
        stance: "revise",
        rationale: "Operational caveats about observability and fallback paths must be included."
      },
      {
        agentName: "quality-researcher",
        stance: "dissent",
        rationale: "Latency optimizations should be framed as measurable tradeoffs, not unconditional wins."
      }
    ]
  });
  db.recordNegotiationRound({
    runId: run.id,
    phase: "consensus",
    topic: "Final framing",
    transcript:
      "Agents agreed to present optimization techniques as a layered latency, architecture, and quality playbook with explicit measurement caveats.",
    verdicts: [
      {
        agentName: "latency-researcher",
        stance: "accept",
        rationale: "Core latency levers are retained."
      },
      {
        agentName: "systems-researcher",
        stance: "accept",
        rationale: "The final artifact includes runtime and observability caveats."
      },
      {
        agentName: "quality-researcher",
        stance: "dissent",
        rationale: "The artifact should still warn that subjective UX can lag numeric latency metrics."
      }
    ]
  });

  const finalPackage = db.finalizeRun(run.id);
  const { markdownPath, finalPackagePath } = await writeFinalArtifacts(options.outDir, run.id, finalPackage);

  return {
    ok: true,
    runId: run.id,
    topic: run.topic,
    agentsCount: SPECIALIST_AGENTS.length,
    finalizationBlockedBeforeNegotiation,
    markdownPath,
    finalPackagePath,
    negotiation: finalPackage.negotiation
  };
}

async function runLiveResearch(options: RunResearchOptions): Promise<RunResearchResult> {
  await mkdir(path.dirname(options.dbPath), { recursive: true });
  const coralUrl = options.coralUrl ?? "http://localhost:5555";
  const timeoutMs = options.liveTimeoutMs ?? 600000;
  const coralServer = await ensureCoralServerReady({
    coralUrl,
    projectRoot: PROJECT_ROOT,
    env: process.env,
    startTimeoutMs: options.coralStartTimeoutMs,
    log: (message) => process.stderr.write(message)
  });
  const db = new Blackboard(options.dbPath);
  const run = db.createRun({
    topic: options.topic,
    format: options.format,
    agents: [...SPECIALIST_AGENTS]
  });
  const session: CoralSessionIdentifier = {
    namespace: `delve-${run.id.slice(0, 8)}`,
    sessionId: ""
  };
  const client = new CoralClient({
    baseUrl: coralUrl,
    authKey: options.coralAuthKey ?? "dev"
  });

  let finalizationBlockedBeforeNegotiation = false;
  try {
    const created = await client.createSession({
      namespace: session.namespace,
      topic: options.topic,
      dbPath: options.dbPath,
      agents: SPECIALIST_AGENTS,
      modelName: CORAL_PROXY_MODEL,
      fallbackModel: OPENROUTER_FALLBACK_MODEL,
      secrets: {
        openRouterApiKey: process.env.OPENROUTER_API_KEY,
        exaApiKey: process.env.EXA_API_KEY
      },
      ttlMs: timeoutMs + 60000,
      holdAfterExitMs: 60000
    });
    session.namespace = created.namespace;
    session.sessionId = created.sessionId;

    await client.waitForAgentsReady({
      ...session,
      agents: SPECIALIST_AGENTS,
      timeoutMs,
      pollMs: 500
    });

    const researchThread = await client.createThread({
      ...session,
      actor: SPECIALIST_AGENTS[0],
      threadName: "research blackboard",
      participantNames: SPECIALIST_AGENTS.slice(1)
    });
    await sendPhaseToAgents(client, session, researchThread.id, {
      phase: "research",
      topic: options.topic,
      runId: run.id,
      dbPath: options.dbPath
    });

    await waitForBlackboard(
      () => db.listNotes(run.id).length >= SPECIALIST_AGENTS.length && db.listClaims(run.id).length >= SPECIALIST_AGENTS.length,
      "research notes and claims",
      timeoutMs
    );

    try {
      db.finalizeRun(run.id);
    } catch (error) {
      if (error instanceof FinalizationBlockedError) finalizationBlockedBeforeNegotiation = true;
      else throw error;
    }

    await client.waitForAgentsReady({
      ...session,
      agents: SPECIALIST_AGENTS,
      timeoutMs,
      pollMs: 500
    });

    const negotiationThread = await client.createThread({
      ...session,
      actor: SPECIALIST_AGENTS[0],
      threadName: "blackboard negotiation",
      participantNames: SPECIALIST_AGENTS.slice(1)
    });
    await sendPhaseToAgents(client, session, negotiationThread.id, {
      phase: "negotiate",
      topic: options.topic,
      runId: run.id,
      dbPath: options.dbPath
    });

    await waitForBlackboard(
      () => new Set(db.listNegotiationRounds(run.id).flatMap((round) => round.verdicts.map((verdict) => verdict.agentName))).size >= SPECIALIST_AGENTS.length,
      "agent negotiation verdicts",
      timeoutMs
    );

    const finalPackage = db.finalizeRun(run.id);
    const { markdownPath, finalPackagePath } = await writeFinalArtifacts(options.outDir, run.id, finalPackage);
    return {
      ok: true,
      runId: run.id,
      topic: run.topic,
      agentsCount: SPECIALIST_AGENTS.length,
      finalizationBlockedBeforeNegotiation,
      markdownPath,
      finalPackagePath,
      negotiation: finalPackage.negotiation,
      coralSession: session,
      coralServer: {
        autoStarted: coralServer.started
      }
    };
  } finally {
    if (session.sessionId) {
      try {
        await client.closeSession(session);
      } catch {
        // The session may already be gone if Coral collected it after agent exit.
      }
    }
    await stopStartedCoralServer(coralServer);
  }
}

async function stopStartedCoralServer(coralServer: ManagedCoralServer): Promise<void> {
  if (!coralServer.started) return;
  try {
    await coralServer.stop();
  } catch {
    // Research artifacts are already written or the original error is more useful.
  }
}

function resolveProjectRoot(moduleDir: string): string {
  if (path.basename(moduleDir) === "src" && path.basename(path.dirname(moduleDir)) === "dist") {
    return path.resolve(moduleDir, "../..");
  }
  return path.resolve(moduleDir, "..");
}

function seedOfflineFixture(db: Blackboard, runId: string): void {
  const latencyNote = db.addNote({
    runId,
    agentName: "latency-researcher",
    angle: "latency",
    content:
      "Real-time voice agents need the model, speech recognizer, and synthesizer to operate incrementally. Endpointing, barge-in detection, partial ASR, and streaming TTS reduce perceived turn latency.",
    sources: [
      {
        title: "Realtime voice latency architecture notes",
        url: "https://example.com/realtime-voice-latency"
      }
    ]
  });
  db.addClaim({
    runId,
    agentName: "latency-researcher",
    claim: "Endpointing, barge-in handling, partial ASR, and streaming TTS are primary perceived-latency levers.",
    evidenceNoteIds: [latencyNote.id],
    confidence: 0.88
  });

  const systemsNote = db.addNote({
    runId,
    agentName: "systems-researcher",
    angle: "systems",
    content:
      "Production systems should separate hot-path audio streaming from slower context retrieval. Cache stable prompts, pre-warm sessions, keep small routing models close to the edge, and emit latency spans per pipeline stage.",
    sources: [
      {
        title: "Voice agent systems playbook",
        url: "https://example.com/voice-agent-systems"
      }
    ]
  });
  db.addClaim({
    runId,
    agentName: "systems-researcher",
    claim: "The hot audio path should be isolated from slow retrieval and instrumented with per-stage latency spans.",
    evidenceNoteIds: [systemsNote.id],
    confidence: 0.82
  });

  const qualityNote = db.addNote({
    runId,
    agentName: "quality-researcher",
    angle: "quality",
    content:
      "Aggressive turn cutting can make agents feel fast but rude or brittle. The final artifact should pair latency metrics with interruption recovery, transcript repair, MOS-style audio quality checks, and task success measures.",
    sources: [
      {
        title: "Voice UX measurement guidance",
        url: "https://example.com/voice-ux-measurement"
      }
    ]
  });
  db.addClaim({
    runId,
    agentName: "quality-researcher",
    claim: "Latency optimization must be evaluated alongside interruption recovery, transcript repair, audio quality, and task success.",
    evidenceNoteIds: [qualityNote.id],
    confidence: 0.8
  });
}

async function writeFinalArtifacts(
  outDir: string,
  runId: string,
  finalPackage: FinalPackage
): Promise<{ markdownPath: string; finalPackagePath: string }> {
  const runDir = path.join(outDir, runId);
  await mkdir(runDir, { recursive: true });
  const markdownPath = path.join(runDir, "research.md");
  const finalPackagePath = path.join(runDir, "final-package.json");
  await writeFile(markdownPath, finalPackage.markdown, "utf8");
  await writeFile(finalPackagePath, `${JSON.stringify(finalPackage, null, 2)}\n`, "utf8");
  return { markdownPath, finalPackagePath };
}

async function sendPhaseToAgents(
  client: CoralClient,
  session: CoralSessionIdentifier,
  threadId: string,
  payload: { phase: "research" | "negotiate"; topic: string; runId: string; dbPath: string }
): Promise<void> {
  await Promise.all(
    SPECIALIST_AGENTS.map((agentName, index) =>
      client.sendMessage({
        ...session,
        actor: SPECIALIST_AGENTS[(index + SPECIALIST_AGENTS.length - 1) % SPECIALIST_AGENTS.length],
        threadId,
        content: JSON.stringify(payload),
        mentions: [agentName]
      })
    )
  );
}

async function waitForBlackboard(predicate: () => boolean, description: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
