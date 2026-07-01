import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  Blackboard,
  createBlackboardTools,
  FinalizationBlockedError
} from "../src/blackboard.ts";

test("final output is blocked until all specialist agents record a negotiation verdict", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-blackboard-"));
  try {
    const db = new Blackboard(path.join(dir, "runs.db"));
    const run = db.createRun({
      topic: "optimisation techniques for real-time voice agents",
      format: "markdown",
      agents: ["latency-researcher", "systems-researcher", "quality-researcher"]
    });

    db.addNote({
      runId: run.id,
      agentName: "latency-researcher",
      angle: "latency",
      content: "Streaming partial ASR and early endpointing reduce turn latency.",
      sources: [{ title: "Voice latency study", url: "https://example.com/latency" }]
    });
    db.addClaim({
      runId: run.id,
      agentName: "latency-researcher",
      claim: "Endpointing and barge-in handling are core latency levers.",
      evidenceNoteIds: [1],
      confidence: 0.86
    });

    assert.throws(
      () => db.finalizeRun(run.id),
      (error) =>
        error instanceof FinalizationBlockedError &&
        error.blockers.includes("negotiation_required") &&
        error.blockers.includes("missing_agent_verdicts:latency-researcher,systems-researcher,quality-researcher")
    );

    db.recordNegotiationRound({
      runId: run.id,
      phase: "debate",
      topic: "Which claims are safe enough for the final artifact?",
      transcript: "Agents challenged unsupported latency and quality claims.",
      verdicts: [
        { agentName: "latency-researcher", stance: "accept", rationale: "Latency claim is sourced." },
        { agentName: "systems-researcher", stance: "revise", rationale: "Need operational caveats." }
      ]
    });

    assert.throws(
      () => db.finalizeRun(run.id),
      (error) =>
        error instanceof FinalizationBlockedError &&
        error.blockers.includes("missing_agent_verdicts:quality-researcher")
    );

    db.recordNegotiationRound({
      runId: run.id,
      phase: "consensus",
      topic: "Consensus after caveats",
      transcript: "Agents agreed to keep the claim with a systems caveat.",
      verdicts: [
        { agentName: "latency-researcher", stance: "accept", rationale: "Still accurate." },
        { agentName: "systems-researcher", stance: "accept", rationale: "Caveat accepted." },
        { agentName: "quality-researcher", stance: "dissent", rationale: "Needs UX measurement caveat." }
      ]
    });

    const finalPackage = db.finalizeRun(run.id);
    assert.equal(finalPackage.runId, run.id);
    assert.equal(finalPackage.negotiation.status, "complete_with_dissent");
    assert.equal(finalPackage.notes.length, 1);
    assert.equal(finalPackage.claims.length, 1);
    assert.match(finalPackage.markdown, /Endpointing and barge-in handling/);
    assert.match(finalPackage.markdown, /Dissent/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("final package preserves revise status and degraded agent metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-quality-"));
  try {
    const db = new Blackboard(path.join(dir, "runs.db"));
    const run = db.createRun({
      topic: "multi-agent research topology",
      format: "markdown",
      agents: ["systems-researcher", "quality-researcher"]
    });

    const note = db.addNote({
      runId: run.id,
      agentName: "systems-researcher",
      angle: "systems",
      content: "Research should preserve claims, gaps, and finalization state in an app-owned blackboard.",
      sources: [{ title: "Architecture note", url: "https://example.com/topology" }],
      execution: {
        modelProvider: "coral",
        modelReason: "coral_runtime_proxy_url",
        modelUsed: false,
        degraded: true,
        degradationReasons: ["model_not_used"]
      }
    });
    db.addClaim({
      runId: run.id,
      agentName: "systems-researcher",
      claim: "A blackboard gives Codex an inspectable handoff for research state.",
      evidenceNoteIds: [note.id],
      confidence: 0.74,
      sourceUrls: ["https://example.com/topology"]
    });

    db.recordNegotiationRound({
      runId: run.id,
      phase: "debate",
      topic: "Whether synthesis is ready",
      transcript: "The quality agent requested revision before final use.",
      verdicts: [
        { agentName: "systems-researcher", stance: "accept", rationale: "The claim is sufficiently grounded." },
        {
          agentName: "quality-researcher",
          stance: "revise",
          rationale: "The final package should expose degraded agent work before user-facing synthesis.",
          execution: {
            modelProvider: "openrouter",
            modelReason: "fallback_after_coral_runtime_proxy_url",
            modelUsed: true,
            degraded: false,
            degradationReasons: []
          }
        }
      ]
    });

    const quality = db.summarizeRunQuality(run.id);
    assert.equal(quality.degradedWork.length, 1);
    assert.equal(quality.degradedWork[0]?.agentName, "systems-researcher");
    assert.equal(quality.revisionRequests.length, 1);
    assert.equal(quality.dissentingVerdicts.length, 0);

    const finalPackage = db.finalizeRun(run.id);
    assert.equal(finalPackage.negotiation.status, "complete_with_revision_requests");
    assert.equal(finalPackage.runQuality.degradedWork.length, 1);
    assert.equal(finalPackage.runQuality.revisionRequests.length, 1);
    assert.match(finalPackage.markdown, /Complete with Revision Requests/);
    assert.match(finalPackage.markdown, /model_not_used/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent SQL tools expose bounded blackboard operations and reject unsafe SQL", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-tools-"));
  try {
    const db = new Blackboard(path.join(dir, "runs.db"));
    const run = db.createRun({
      topic: "voice agents",
      format: "markdown",
      agents: ["latency-researcher"]
    });
    const tools = createBlackboardTools(db);

    const note = tools.writeNote({
      runId: run.id,
      agentName: "latency-researcher",
      angle: "latency",
      content: "Use incremental TTS playback when responses can be chunked.",
      sources: []
    });
    assert.equal(note.agentName, "latency-researcher");

    const rows = tools.readOnlyQuery({
      runId: run.id,
      sql: "select agent_name, angle from notes where run_id = ?"
    });
    assert.deepEqual(rows, [{ agent_name: "latency-researcher", angle: "latency" }]);

    assert.throws(
      () => tools.readOnlyQuery({ runId: run.id, sql: "delete from notes" }),
      /Only single SELECT statements/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
