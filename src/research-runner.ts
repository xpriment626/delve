import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  Blackboard,
  FinalizationBlockedError,
  type ArtifactFormat,
  type FinalPackage,
  type RevisionTaskRecord,
  type TopologyMode
} from "./blackboard.js";
import { CoralClient, type CoralSessionIdentifier } from "./coral-client.js";
import { ensureCoralServerReady, type ManagedCoralServer } from "./coral-server-process.js";
import { resolveConfiguredModel } from "./model-routing.js";

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
  topologyMode?: TopologyMode;
}

export interface RunResearchResult {
  ok: true;
  runId: string;
  topic: string;
  agentsCount: number;
  finalizationBlockedBeforeNegotiation: boolean;
  usableFinal: boolean;
  qualityGate: FinalPackage["qualityGate"];
  runQuality: FinalPackage["runQuality"];
  markdownPath: string;
  finalPackagePath: string;
  negotiation: FinalPackage["negotiation"];
  topology: FinalPackage["topologyTrace"];
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
    agents: [...SPECIALIST_AGENTS],
    topologyMode: options.topologyMode ?? "fixed"
  });
  recordTopologySelected(db, run.id, run.topologyMode, run.topologyRationale);

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

  if (run.topologyMode === "dynamic-revision") {
    runOfflineDynamicRevisionLoop(db, run.id);
  } else {
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
  }

  const finalPackage = db.finalizeRun(run.id, { finalizationBlockedBeforeNegotiation });
  const { markdownPath, finalPackagePath } = await writeFinalArtifacts(options.outDir, run.id, finalPackage);

  return {
    ok: true,
    runId: run.id,
    topic: run.topic,
    agentsCount: SPECIALIST_AGENTS.length,
    finalizationBlockedBeforeNegotiation,
    usableFinal: finalPackage.usableFinal,
    qualityGate: finalPackage.qualityGate,
    runQuality: finalPackage.runQuality,
    markdownPath,
    finalPackagePath,
    negotiation: finalPackage.negotiation,
    topology: finalPackage.topologyTrace
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
    agents: [...SPECIALIST_AGENTS],
    topologyMode: options.topologyMode ?? "fixed"
  });
  recordTopologySelected(db, run.id, run.topologyMode, run.topologyRationale);
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
      modelName: resolveConfiguredModel(process.env),
      secrets: {
        coralApiKey: process.env.CORAL_API_KEY,
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

    if (run.topologyMode === "dynamic-revision") {
      await runLiveDynamicRevisionLoop({
        db,
        runId: run.id,
        topic: run.topic,
        dbPath: options.dbPath,
        client,
        session,
        timeoutMs
      });
    }

    const finalPackage = db.finalizeRun(run.id, { finalizationBlockedBeforeNegotiation });
    const { markdownPath, finalPackagePath } = await writeFinalArtifacts(options.outDir, run.id, finalPackage);
    return {
      ok: true,
      runId: run.id,
      topic: run.topic,
      agentsCount: SPECIALIST_AGENTS.length,
      finalizationBlockedBeforeNegotiation,
      usableFinal: finalPackage.usableFinal,
      qualityGate: finalPackage.qualityGate,
      runQuality: finalPackage.runQuality,
      markdownPath,
      finalPackagePath,
      negotiation: finalPackage.negotiation,
      topology: finalPackage.topologyTrace,
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

function recordTopologySelected(db: Blackboard, runId: string, mode: TopologyMode, rationale: string): void {
  db.recordTopologyEvent({
    runId,
    eventType: "topology_selected",
    actor: "delve",
    rationale,
    details: { mode }
  });
}

function createRevisionTasksFromVerdicts(db: Blackboard, runId: string): RevisionTaskRecord[] {
  const tasks: RevisionTaskRecord[] = [];
  for (const verdict of db.summarizeRunQuality(runId).revisionRequests) {
    const task = db.createRevisionTask({
      runId,
      sourceRoundId: verdict.roundId,
      sourceAgentName: verdict.agentName,
      rationale: verdict.rationale,
      assignedAgents: [verdict.agentName],
      topic: `Revision: ${verdict.topic}`
    });
    db.recordTopologyEvent({
      runId,
      eventType: "revision_task_created",
      taskId: task.id,
      actor: "delve",
      targetAgents: task.assignedAgents,
      rationale: task.rationale,
      details: {
        sourceRoundId: verdict.roundId,
        sourceAgentName: verdict.agentName,
        stance: verdict.stance
      }
    });
    tasks.push(task);
  }
  if (tasks.length === 0) {
    db.recordTopologyEvent({
      runId,
      eventType: "revision_scan_completed",
      actor: "delve",
      rationale: "No revise verdicts were recorded, so dynamic-revision had no follow-up tasks.",
      details: { revisionTaskCount: 0 }
    });
  }
  return tasks;
}

function runOfflineDynamicRevisionLoop(db: Blackboard, runId: string): void {
  const tasks = createRevisionTasksFromVerdicts(db, runId);
  for (const task of tasks) {
    const note = db.addNote({
      runId,
      agentName: task.assignedAgents[0] ?? task.sourceAgentName,
      angle: "revision follow-up",
      content:
        `Dynamic-revision follow-up for ${task.topic}. The revision request was: ${task.rationale} ` +
        "The final artifact should carry this request as inspected follow-up work rather than burying it as a caveat.",
      sources: [],
      revisionTaskId: task.id
    });
    db.addClaim({
      runId,
      agentName: note.agentName,
      claim: "Dynamic revision requests should become inspectable follow-up work before Delve finalizes a research package.",
      evidenceNoteIds: [note.id],
      confidence: 0.72,
      caveats: ["Offline fixture follow-up is deterministic and should not be treated as live research."],
      revisionTaskId: task.id
    });
    db.recordTopologyEvent({
      runId,
      eventType: "revision_followup_recorded",
      taskId: task.id,
      actor: note.agentName,
      targetAgents: task.assignedAgents,
      rationale: "Offline fixture wrote deterministic follow-up evidence for the revision task.",
      details: { noteId: note.id }
    });
    const resolved = db.resolveRevisionTask({
      runId,
      taskId: task.id,
      status: "resolved",
      resolutionNote: `${note.agentName} wrote deterministic offline follow-up note ${note.id}.`,
      evidenceNoteIds: [note.id]
    });
    db.recordTopologyEvent({
      runId,
      eventType: "revision_task_resolved",
      taskId: task.id,
      actor: "delve",
      targetAgents: resolved.assignedAgents,
      rationale: resolved.resolutionNote ?? "Revision task resolved.",
      details: { evidenceNoteIds: resolved.evidenceNoteIds }
    });
  }
  if (tasks.length > 0) {
    db.recordNegotiationRound({
      runId,
      phase: "consensus",
      topic: "Post-revision review",
      transcript: "Offline dynamic-revision fixture re-reviewed the follow-up work and accepted the revised package.",
      verdicts: SPECIALIST_AGENTS.map((agentName) => ({
        agentName,
        stance: "accept" as const,
        rationale: "Revision follow-up was recorded and no active blocker remains in the offline fixture."
      }))
    });
    db.recordTopologyEvent({
      runId,
      eventType: "post_revision_review_recorded",
      actor: "delve",
      targetAgents: [...SPECIALIST_AGENTS],
      rationale: "Recorded offline post-revision acceptance so resolved follow-up tasks are re-reviewed before finalization.",
      details: { revisionTaskCount: tasks.length }
    });
  }
}

async function runLiveDynamicRevisionLoop(input: {
  db: Blackboard;
  runId: string;
  topic: string;
  dbPath: string;
  client: CoralClient;
  session: CoralSessionIdentifier;
  timeoutMs: number;
}): Promise<void> {
  const tasks = createRevisionTasksFromVerdicts(input.db, input.runId);
  for (const task of tasks) {
    const actor = puppetActorForTargets(task.assignedAgents);
    const thread = await input.client.createThread({
      ...input.session,
      actor,
      threadName: task.topic,
      participantNames: task.assignedAgents
    });
    const taskWithThread = input.db.attachRevisionTaskThread({
      runId: input.runId,
      taskId: task.id,
      threadId: thread.id
    });
    input.db.recordTopologyEvent({
      runId: input.runId,
      eventType: "revision_thread_created",
      taskId: task.id,
      actor,
      targetAgents: taskWithThread.assignedAgents,
      threadId: thread.id,
      rationale: `Opened topic-specific Coral thread for ${task.topic}.`,
      details: { threadName: task.topic }
    });
    await sendPhaseToAgents(input.client, input.session, thread.id, {
      phase: "revise",
      topic: input.topic,
      runId: input.runId,
      dbPath: input.dbPath,
      revisionTaskId: task.id,
      revisionRationale: task.rationale
    }, task.assignedAgents);
    input.db.recordTopologyEvent({
      runId: input.runId,
      eventType: "revision_agents_mentioned",
      taskId: task.id,
      actor,
      targetAgents: taskWithThread.assignedAgents,
      threadId: thread.id,
      rationale: "Mentioned assigned agent(s) with targeted revision prompt.",
      details: { revisionTaskId: task.id }
    });
    await waitForBlackboard(
      () => input.db.listNotes(input.runId).some((note) => note.revisionTaskId === task.id),
      `revision follow-up for ${task.topic}`,
      input.timeoutMs
    );
    const evidenceNoteIds = input.db.listNotes(input.runId)
      .filter((note) => note.revisionTaskId === task.id)
      .map((note) => note.id);
    const resolved = input.db.resolveRevisionTask({
      runId: input.runId,
      taskId: task.id,
      status: "resolved",
      resolutionNote: `Assigned agent(s) wrote ${evidenceNoteIds.length} follow-up note(s).`,
      evidenceNoteIds,
      threadId: thread.id
    });
    input.db.recordTopologyEvent({
      runId: input.runId,
      eventType: "revision_task_resolved",
      taskId: task.id,
      actor: "delve",
      targetAgents: resolved.assignedAgents,
      threadId: thread.id,
      rationale: resolved.resolutionNote ?? "Revision task resolved.",
      details: { evidenceNoteIds }
    });
  }
  if (tasks.length > 0) {
    await runLivePostRevisionReview(input, tasks);
  }
}

async function runLivePostRevisionReview(
  input: {
    db: Blackboard;
    runId: string;
    topic: string;
    dbPath: string;
    client: CoralClient;
    session: CoralSessionIdentifier;
    timeoutMs: number;
  },
  tasks: RevisionTaskRecord[]
): Promise<void> {
  const previousMaxRoundId = Math.max(0, ...input.db.listNegotiationRounds(input.runId).map((round) => round.id));
  const actor = SPECIALIST_AGENTS[0];
  const thread = await input.client.createThread({
    ...input.session,
    actor,
    threadName: "post-revision review",
    participantNames: SPECIALIST_AGENTS.slice(1)
  });
  input.db.recordTopologyEvent({
    runId: input.runId,
    eventType: "post_revision_review_thread_created",
    actor,
    targetAgents: [...SPECIALIST_AGENTS],
    threadId: thread.id,
    rationale: "Opened a post-revision Coral thread to re-review follow-up notes before finalization.",
    details: { revisionTaskIds: tasks.map((task) => task.id) }
  });
  await sendPhaseToAgents(input.client, input.session, thread.id, {
    phase: "negotiate",
    topic: input.topic,
    runId: input.runId,
    dbPath: input.dbPath
  });
  input.db.recordTopologyEvent({
    runId: input.runId,
    eventType: "post_revision_review_requested",
    actor,
    targetAgents: [...SPECIALIST_AGENTS],
    threadId: thread.id,
    rationale: "Mentioned all specialists for a post-revision verdict pass.",
    details: { previousMaxRoundId }
  });
  await waitForBlackboard(
    () => {
      const reviewerNames = new Set(
        input.db
          .listNegotiationRounds(input.runId)
          .filter((round) => round.id > previousMaxRoundId)
          .flatMap((round) => round.verdicts.map((verdict) => verdict.agentName))
      );
      return SPECIALIST_AGENTS.every((agentName) => reviewerNames.has(agentName));
    },
    "post-revision negotiation verdicts",
    input.timeoutMs
  );
  input.db.recordTopologyEvent({
    runId: input.runId,
    eventType: "post_revision_review_completed",
    actor: "delve",
    targetAgents: [...SPECIALIST_AGENTS],
    threadId: thread.id,
    rationale: "All specialists recorded post-revision verdicts.",
    details: { revisionTaskIds: tasks.map((task) => task.id) }
  });
}

function puppetActorForTargets(targetAgents: readonly string[]): string {
  return SPECIALIST_AGENTS.find((agent) => !targetAgents.includes(agent)) ?? SPECIALIST_AGENTS[0];
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
  payload: {
    phase: "research" | "negotiate" | "revise";
    topic: string;
    runId: string;
    dbPath: string;
    revisionTaskId?: string;
    revisionRationale?: string;
  },
  agents: readonly string[] = SPECIALIST_AGENTS
): Promise<void> {
  await Promise.all(
    agents.map((agentName) =>
      client.sendMessage({
        ...session,
        actor: puppetActorForTargets([agentName]),
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
