import assert from "node:assert/strict";
import test from "node:test";

import { buildRoleResearchQuery, negotiateRole, reviseRole } from "../src/agent-research.ts";
import { parseExaTextResults } from "../src/exa-research.ts";
import { initialReplayAfterUnixTime, parseWaitForMentionPayload } from "../src/eve-coral-agent.ts";

test("parseWaitForMentionPayload extracts text, thread id, and sender", () => {
  const payload = JSON.stringify({
    message: {
      text: "{\"runId\":\"run-1\",\"topic\":\"voice agents\"}",
      threadId: "thread-1",
      senderName: "conductor"
    }
  });

  assert.deepEqual(parseWaitForMentionPayload(payload), {
    text: "{\"runId\":\"run-1\",\"topic\":\"voice agents\"}",
    threadId: "thread-1",
    senderName: "conductor"
  });
});

test("initial replay cursor looks back to catch startup race mentions", () => {
  assert.equal(initialReplayAfterUnixTime(100_000, 30_000), 70_000);
});

test("role research queries are topic-adaptive and differentiated", () => {
  const topic = "privacy preserving synthetic customer support data";
  const latency = buildRoleResearchQuery("latency-researcher", topic);
  const systems = buildRoleResearchQuery("systems-researcher", topic);
  const quality = buildRoleResearchQuery("quality-researcher", topic);

  assert.match(latency, /privacy preserving synthetic customer support data/);
  assert.match(systems, /architecture/);
  assert.match(quality, /evaluation/);
  assert.notEqual(latency, systems);
  assert.notEqual(systems, quality);
});

test("Exa text parser preserves source metadata and reliability notes", () => {
  const sources = parseExaTextResults(`Title: Research Paper
URL: https://doi.org/10.1234/example
Published: 2026-06-01T00:00:00.000Z
Author: Jane Doe
Highlights:
- Streaming and pipelining reduce latency.

---

Title: Vendor Guide
URL: https://example.com/guide
Published: N/A
Author: N/A
Highlights:
- Measure P95 before optimizing.`);

  assert.equal(sources.length, 2);
  assert.equal(sources[0].domain, "doi.org");
  assert.equal(sources[0].publisher, "Jane Doe");
  assert.match(sources[0].reliability ?? "", /research paper/);
  assert.match(sources[1].excerpt ?? "", /Measure P95/);
});

test("heuristic negotiation remains substantive when no model route is available", async () => {
  const verdict = await negotiateRole({
    role: "quality-researcher",
    topic: "privacy preserving synthetic customer support data",
    env: {},
    notes: [
      {
        id: 1,
        runId: "run-1",
        agentName: "latency-researcher",
        angle: "performance",
        content: "A note with limited source coverage.",
        sources: []
      }
    ],
    claims: [
      {
        id: 1,
        runId: "run-1",
        agentName: "latency-researcher",
        claim: "A weak claim.",
        evidenceNoteIds: [1],
        confidence: 0.4,
        caveats: [],
        sourceUrls: []
      }
    ]
  });

  assert.equal(verdict.modelUsed, false);
  assert.equal(verdict.stance, "dissent");
  assert.match(verdict.transcript, /reviewed 1 notes, 1 claims/);
});

test("revision follow-up research carries revision task context", async () => {
  const output = await reviseRole({
    role: "systems-researcher",
    topic: "dynamic topology for agentic deep research",
    revisionTaskId: "rev-test",
    revisionRationale: "Add CLI operational constraints before finalization.",
    env: {},
    notes: [],
    claims: []
  });

  assert.equal(output.modelUsed, false);
  assert.match(output.angle, /revision follow-up/);
  assert.match(output.content, /rev-test/);
  assert.match(output.content, /CLI operational constraints/);
});
