#!/usr/bin/env node
import "dotenv/config";

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Command } from "commander";

import { Blackboard, type AgentExecutionMetadata } from "./blackboard.js";
import { negotiateRole, researchRole, reviseRole } from "./agent-research.js";

export interface MentionPayload {
  text: string;
  threadId: string;
  senderName: string;
}

export interface ResearchTaskMessage {
  runId: string;
  topic: string;
  dbPath?: string;
  phase?: "research" | "negotiate" | "revise";
  revisionTaskId?: string;
  revisionRationale?: string;
}

export function initialReplayAfterUnixTime(now = Date.now(), lookbackMs = 30_000): number {
  return now - lookbackMs;
}

export function isWaitForMentionTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /MCP error -32001: Request timed out|Request timed out/.test(message);
}

export function parseWaitForMentionPayload(payload: string): MentionPayload {
  const parsed = JSON.parse(payload) as { message?: { text?: unknown; threadId?: unknown; senderName?: unknown } };
  const message = parsed.message;
  if (!message) throw new Error(`Missing message object in wait_for_mention payload: ${payload}`);
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const threadId = typeof message.threadId === "string" ? message.threadId.trim() : "";
  const senderName = typeof message.senderName === "string" ? message.senderName.trim() : "";
  if (!text || !threadId || !senderName) {
    throw new Error(`Missing text/threadId/senderName in wait_for_mention payload: ${payload}`);
  }
  return { text, threadId, senderName };
}

export async function runCoralEveAgent(input: {
  role: string;
  coralConnectionUrl: string;
  dbPath: string;
  maxMessages: number;
  waitMs: number;
}): Promise<void> {
  const client = new Client({ name: `delve-${input.role}`, version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(input.coralConnectionUrl));
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const waitTool = findTool(tools.tools.map((tool) => tool.name), /wait_for_mention/);
    const sendTool = findTool(tools.tools.map((tool) => tool.name), /send_message/);
    console.error(JSON.stringify({ role: input.role, event: "connected", waitTool, sendTool }));

    let replayAfterUnixTime = initialReplayAfterUnixTime();
    let handled = 0;
    while (handled < input.maxMessages) {
      let waitResult: unknown;
      try {
        waitResult = await client.callTool({
          name: waitTool,
          arguments: { currentUnixTime: replayAfterUnixTime, maxWaitMs: input.waitMs }
        });
      } catch (error) {
        if (isWaitForMentionTimeout(error)) {
          console.error(JSON.stringify({ role: input.role, event: "wait_for_mention_timeout_retry" }));
          continue;
        }
        throw error;
      }
      const mention = parseWaitForMentionPayload(extractText(waitResult));
      const task = parseResearchTaskMessage(mention.text);
      const dbPath = task.dbPath ?? input.dbPath;
      await mkdir(path.dirname(dbPath), { recursive: true });
      const db = new Blackboard(dbPath);
      const result = await handleTaskMessage(db, input.role, task);

      await client.callTool({
        name: sendTool,
        arguments: {
          threadId: mention.threadId,
          content: JSON.stringify({
            type: result.type,
            agentName: input.role,
            runId: task.runId,
            ...result.payload
          }),
          mentions: []
        }
      });
      console.error(JSON.stringify({ role: input.role, event: result.type, runId: task.runId, ...result.payload }));
      replayAfterUnixTime = Date.now();
      handled += 1;
    }
  } finally {
    await client.close();
  }
}

async function handleTaskMessage(
  db: Blackboard,
  role: string,
  task: ResearchTaskMessage
): Promise<{ type: string; payload: Record<string, unknown> }> {
  if (task.phase === "negotiate") {
    const notes = db.listNotes(task.runId);
    const claims = db.listClaims(task.runId);
    const verdict = await negotiateRole({
      role,
      topic: task.topic,
      notes,
      claims,
      env: process.env
    });
    const round = db.recordNegotiationRound({
      runId: task.runId,
      phase: "debate",
      topic: `${role} verdict on blackboard contents`,
      transcript: verdict.transcript,
      verdicts: [
        {
          agentName: role,
          stance: verdict.stance,
          rationale: verdict.rationale,
          execution: executionFromAgentOutput(verdict)
        }
      ]
    });
    return {
      type: "negotiation_verdict_written",
      payload: {
        roundId: round.id,
        stance: round.verdicts[0]?.stance,
        modelProvider: verdict.modelRoute.provider,
        modelReason: verdict.modelRoute.reason,
        modelUsed: verdict.modelUsed,
        degraded: isAgentOutputDegraded(verdict),
        degradationReasons: degradationReasonsForAgentOutput(verdict),
        ...modelDiagnosticsFromAgentOutput(verdict)
      }
    };
  }

  if (task.phase === "revise") {
    if (!task.revisionTaskId || !task.revisionRationale) {
      throw new Error(`Revision task message must include revisionTaskId and revisionRationale: ${JSON.stringify(task)}`);
    }
    const notes = db.listNotes(task.runId);
    const claims = db.listClaims(task.runId);
    const revision = await reviseRole({
      role,
      topic: task.topic,
      revisionTaskId: task.revisionTaskId,
      revisionRationale: task.revisionRationale,
      notes,
      claims,
      env: process.env
    });
    const note = db.addNote({
      runId: task.runId,
      agentName: role,
      angle: revision.angle,
      content: revision.content,
      sources: revision.sources,
      revisionTaskId: task.revisionTaskId,
      execution: executionFromAgentOutput(revision)
    });
    const revisionClaims = revision.claims.map((claim) =>
      db.addClaim({
        runId: task.runId,
        agentName: role,
        evidenceNoteIds: [note.id],
        claim: claim.claim,
        confidence: claim.confidence,
        caveats: claim.caveats,
        sourceUrls: claim.sourceUrls,
        revisionTaskId: task.revisionTaskId
      })
    );
    return {
      type: "revision_followup_written",
      payload: {
        revisionTaskId: task.revisionTaskId,
        noteId: note.id,
        claimIds: revisionClaims.map((claim) => claim.id),
        angle: note.angle,
        sourceCount: note.sources.length,
        searchQuery: revision.searchQuery,
        modelProvider: revision.modelRoute.provider,
        modelReason: revision.modelRoute.reason,
        modelUsed: revision.modelUsed,
        degraded: isAgentOutputDegraded(revision),
        degradationReasons: degradationReasonsForAgentOutput(revision),
        ...modelDiagnosticsFromAgentOutput(revision)
      }
    };
  }

  const research = await researchRole({
    role,
    topic: task.topic,
    env: process.env
  });
  const note = db.addNote({
    runId: task.runId,
    agentName: role,
    angle: research.angle,
    content: research.content,
    sources: research.sources,
    execution: executionFromAgentOutput(research)
  });
  const claims = research.claims.map((claim) =>
    db.addClaim({
      runId: task.runId,
      agentName: role,
      evidenceNoteIds: [note.id],
      claim: claim.claim,
      confidence: claim.confidence,
      caveats: claim.caveats,
      sourceUrls: claim.sourceUrls
    })
  );
  return {
    type: "research_note_written",
    payload: {
      noteId: note.id,
      claimIds: claims.map((claim) => claim.id),
      angle: note.angle,
      sourceCount: note.sources.length,
      searchQuery: research.searchQuery,
      modelProvider: research.modelRoute.provider,
      modelReason: research.modelRoute.reason,
      modelUsed: research.modelUsed,
      degraded: isAgentOutputDegraded(research),
      degradationReasons: degradationReasonsForAgentOutput(research),
      ...modelDiagnosticsFromAgentOutput(research)
    }
  };
}

function executionFromAgentOutput(input: {
  modelRoute: { provider: string; reason: string };
  modelUsed: boolean;
  sourceError?: string;
  modelError?: string;
}): AgentExecutionMetadata {
  const degradationReasons = degradationReasonsForAgentOutput(input);
  return {
    modelProvider: input.modelRoute.provider,
    modelReason: input.modelRoute.reason,
    modelUsed: input.modelUsed,
    degraded: degradationReasons.length > 0,
    degradationReasons
  };
}

function isAgentOutputDegraded(input: {
  modelUsed: boolean;
  sourceError?: string;
  modelError?: string;
}): boolean {
  return degradationReasonsForAgentOutput(input).length > 0;
}

function degradationReasonsForAgentOutput(input: {
  modelUsed: boolean;
  sourceError?: string;
  modelError?: string;
}): string[] {
  const reasons = new Set<string>();
  if (!input.modelUsed) reasons.add("model_not_used");
  if (input.sourceError) reasons.add("source_error");
  if (input.modelError) reasons.add("model_error");
  return [...reasons];
}

function modelDiagnosticsFromAgentOutput(input: {
  modelRoute: { baseUrl?: string };
  modelError?: string;
}): Record<string, string> {
  return {
    ...(input.modelRoute.baseUrl ? { modelBaseUrl: input.modelRoute.baseUrl } : {}),
    ...(input.modelError ? { modelError: input.modelError.slice(0, 500) } : {})
  };
}

function parseResearchTaskMessage(text: string): ResearchTaskMessage {
  const parsed = JSON.parse(text) as Partial<ResearchTaskMessage>;
  if (!parsed.runId || !parsed.topic) throw new Error(`Research task message must include runId and topic: ${text}`);
  return {
    runId: parsed.runId,
    topic: parsed.topic,
    dbPath: parsed.dbPath,
    phase: parsed.phase,
    revisionTaskId: parsed.revisionTaskId,
    revisionRationale: parsed.revisionRationale
  };
}

function extractText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content
    .map((item) => (item.type === "text" && item.text ? item.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function findTool(toolNames: string[], pattern: RegExp): string {
  const hit = toolNames.find((toolName) => pattern.test(toolName));
  if (!hit) throw new Error(`Missing Coral MCP tool matching ${pattern}: ${toolNames.join(", ")}`);
  return hit;
}

async function main(): Promise<void> {
  const program = new Command();
  program.requiredOption("--role <role>", "specialist role");
  program.option("--max-messages <count>", "messages to handle before exiting", "2");
  program.option("--wait-ms <ms>", "wait_for_mention timeout", "600000");
  program.parse(process.argv);

  const options = program.opts<{ role: string; maxMessages: string; waitMs: string }>();
  const coralConnectionUrl = process.env.CORAL_CONNECTION_URL;
  if (!coralConnectionUrl) {
    console.error(
      JSON.stringify({
        ok: false,
        role: options.role,
        coralConnection: "missing",
        blackboardDbPath: process.env.BLACKBOARD_DB_PATH ?? ".delve/blackboard.db"
      })
    );
    return;
  }

  await runCoralEveAgent({
    role: options.role,
    coralConnectionUrl,
    dbPath: process.env.BLACKBOARD_DB_PATH ?? ".delve/blackboard.db",
    maxMessages: Number(options.maxMessages),
    waitMs: Number(options.waitMs)
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
