import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type ArtifactFormat = "markdown" | "json" | "docx" | "slides";
export type NegotiationPhase = "debate" | "consensus";
export type VerdictStance = "accept" | "revise" | "dissent";
export type NegotiationStatus = "complete" | "complete_with_revision_requests" | "complete_with_dissent";
export type TopologyMode = "fixed" | "dynamic-revision";
export type RevisionTaskStatus = "open" | "resolved" | "waived";

export interface AgentExecutionMetadata {
  modelProvider: string;
  modelReason: string;
  modelUsed: boolean;
  degraded: boolean;
  degradationReasons: string[];
}

export interface SourceRef {
  title: string;
  url: string;
  domain?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt?: string;
  excerpt?: string;
  summary?: string;
  relevance?: string;
  reliability?: string;
}

export interface RunRecord {
  id: string;
  topic: string;
  format: ArtifactFormat;
  agents: string[];
  createdAt: string;
  topologyMode: TopologyMode;
  topologyRationale: string;
}

export interface NoteRecord {
  id: number;
  runId: string;
  agentName: string;
  angle: string;
  content: string;
  sources: SourceRef[];
  execution: AgentExecutionMetadata;
  revisionTaskId?: string;
}

export interface ClaimRecord {
  id: number;
  runId: string;
  agentName: string;
  claim: string;
  evidenceNoteIds: number[];
  confidence: number;
  caveats: string[];
  sourceUrls: string[];
  revisionTaskId?: string;
}

export interface AggregatedSourceRecord extends SourceRef {
  noteIds: number[];
  agentNames: string[];
  angles: string[];
}

export interface NegotiationVerdict {
  agentName: string;
  stance: VerdictStance;
  rationale: string;
  execution: AgentExecutionMetadata;
}

export interface NegotiationVerdictInput {
  agentName: string;
  stance: VerdictStance;
  rationale: string;
  execution?: Partial<AgentExecutionMetadata>;
}

export interface NegotiationRoundRecord {
  id: number;
  runId: string;
  phase: NegotiationPhase;
  topic: string;
  transcript: string;
  verdicts: NegotiationVerdict[];
}

export interface RevisionTaskRecord {
  id: string;
  runId: string;
  sourceRoundId: number;
  sourceAgentName: string;
  rationale: string;
  assignedAgents: string[];
  topic: string;
  status: RevisionTaskStatus;
  threadId?: string;
  resolutionNote?: string;
  evidenceNoteIds: number[];
  createdAt: string;
  updatedAt: string;
}

export interface TopologyEventRecord {
  id: number;
  runId: string;
  eventType: string;
  taskId?: string;
  actor: string;
  targetAgents: string[];
  threadId?: string;
  rationale: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TopologyTrace {
  mode: TopologyMode;
  initialRationale: string;
  events: TopologyEventRecord[];
  revisionTasks: RevisionTaskRecord[];
  openRevisionTasks: RevisionTaskRecord[];
  degradedTopologyActions: TopologyEventRecord[];
}

export interface FinalPackage {
  runId: string;
  topic: string;
  format: ArtifactFormat;
  notes: NoteRecord[];
  sources: AggregatedSourceRecord[];
  claims: ClaimRecord[];
  negotiation: {
    status: NegotiationStatus;
    rounds: NegotiationRoundRecord[];
  };
  runQuality: RunQualitySummary;
  topologyTrace: TopologyTrace;
  synthesis: SynthesisHandoff;
  markdown: string;
}

export interface DegradedWorkRecord {
  phase: "research" | "negotiation";
  agentName: string;
  noteId?: number;
  roundId?: number;
  topic?: string;
  modelProvider: string;
  modelReason: string;
  modelUsed: boolean;
  degradationReasons: string[];
}

export interface VerdictQualityRecord {
  agentName: string;
  stance: VerdictStance;
  rationale: string;
  roundId: number;
  phase: NegotiationPhase;
  topic: string;
  execution: AgentExecutionMetadata;
}

export interface RunQualitySummary {
  degradedWork: DegradedWorkRecord[];
  revisionRequests: VerdictQualityRecord[];
  dissentingVerdicts: VerdictQualityRecord[];
}

export interface SynthesisHandoff {
  codexResponsibility: string;
  document: {
    title: string;
    recommendedSections: Array<{
      heading: string;
      claimIds: number[];
      sourceUrls: string[];
    }>;
  };
  slides: {
    title: string;
    recommendedSlides: Array<{
      title: string;
      bullets: string[];
      claimIds: number[];
      sourceUrls: string[];
    }>;
  };
  caveats: string[];
}

export class FinalizationBlockedError extends Error {
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(`Finalization blocked: ${blockers.join(", ")}`);
    this.name = "FinalizationBlockedError";
    this.blockers = blockers;
  }
}

export class Blackboard {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("pragma foreign_keys = on");
    this.db.exec("pragma busy_timeout = 5000");
    this.migrate();
  }

  createRun(input: {
    topic: string;
    format: ArtifactFormat;
    agents: string[];
    topologyMode?: TopologyMode;
    topologyRationale?: string;
  }): RunRecord {
    const now = new Date().toISOString();
    const topologyMode = input.topologyMode ?? "fixed";
    const run: RunRecord = {
      id: randomUUID(),
      topic: input.topic,
      format: input.format,
      agents: input.agents,
      createdAt: now,
      topologyMode,
      topologyRationale: input.topologyRationale ?? defaultTopologyRationale(topologyMode)
    };
    this.db
      .prepare(
        `insert into runs
         (id, topic, format, agents_json, created_at, topology_mode, topology_rationale)
         values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(run.id, run.topic, run.format, JSON.stringify(run.agents), run.createdAt, run.topologyMode, run.topologyRationale);
    return run;
  }

  getRun(runId: string): RunRecord {
    const row = this.db.prepare("select * from runs where id = ?").get(runId) as RunRow | undefined;
    if (!row) throw new Error(`Run not found: ${runId}`);
    return runFromRow(row);
  }

  addNote(input: {
    runId: string;
    agentName: string;
    angle: string;
    content: string;
    sources: SourceRef[];
    execution?: Partial<AgentExecutionMetadata>;
    revisionTaskId?: string;
  }): NoteRecord {
    this.assertRunExists(input.runId);
    if (input.revisionTaskId) this.assertRevisionTaskExists(input.runId, input.revisionTaskId);
    const execution = normalizeExecution(input.execution);
    const result = this.db
      .prepare(
        `insert into notes
         (run_id, agent_name, angle, content, sources_json, model_provider, model_reason, model_used, degraded, degradation_reasons_json, revision_task_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.runId,
        input.agentName,
        input.angle,
        input.content,
        JSON.stringify(input.sources),
        execution.modelProvider,
        execution.modelReason,
        execution.modelUsed ? 1 : 0,
        execution.degraded ? 1 : 0,
        JSON.stringify(execution.degradationReasons),
        input.revisionTaskId ?? null
      );
    return {
      id: Number(result.lastInsertRowid),
      runId: input.runId,
      agentName: input.agentName,
      angle: input.angle,
      content: input.content,
      sources: input.sources,
      execution,
      ...(input.revisionTaskId ? { revisionTaskId: input.revisionTaskId } : {})
    };
  }

  addClaim(input: {
    runId: string;
    agentName: string;
    claim: string;
    evidenceNoteIds: number[];
    confidence: number;
    caveats?: string[];
    sourceUrls?: string[];
    revisionTaskId?: string;
  }): ClaimRecord {
    this.assertRunExists(input.runId);
    if (input.revisionTaskId) this.assertRevisionTaskExists(input.runId, input.revisionTaskId);
    const caveats = input.caveats ?? [];
    const sourceUrls = input.sourceUrls ?? [];
    const result = this.db
      .prepare(
        `insert into claims
         (run_id, agent_name, claim, evidence_note_ids_json, confidence, caveats_json, source_urls_json, revision_task_id)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.runId,
        input.agentName,
        input.claim,
        JSON.stringify(input.evidenceNoteIds),
        input.confidence,
        JSON.stringify(caveats),
        JSON.stringify(sourceUrls),
        input.revisionTaskId ?? null
      );
    return {
      id: Number(result.lastInsertRowid),
      runId: input.runId,
      agentName: input.agentName,
      claim: input.claim,
      evidenceNoteIds: input.evidenceNoteIds,
      confidence: input.confidence,
      caveats,
      sourceUrls,
      ...(input.revisionTaskId ? { revisionTaskId: input.revisionTaskId } : {})
    };
  }

  recordNegotiationRound(input: {
    runId: string;
    phase: NegotiationPhase;
    topic: string;
    transcript: string;
    verdicts: NegotiationVerdictInput[];
  }): NegotiationRoundRecord {
    this.assertRunExists(input.runId);
    const verdicts = input.verdicts.map((verdict) => ({
      ...verdict,
      execution: normalizeExecution(verdict.execution)
    }));
    const result = this.db
      .prepare(
        "insert into negotiation_rounds (run_id, phase, topic, transcript) values (?, ?, ?, ?)"
      )
      .run(input.runId, input.phase, input.topic, input.transcript);
    const roundId = Number(result.lastInsertRowid);
    const insertVerdict = this.db.prepare(
      `insert into negotiation_verdicts
       (round_id, run_id, agent_name, stance, rationale, model_provider, model_reason, model_used, degraded, degradation_reasons_json)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const verdict of verdicts) {
      insertVerdict.run(
        roundId,
        input.runId,
        verdict.agentName,
        verdict.stance,
        verdict.rationale,
        verdict.execution.modelProvider,
        verdict.execution.modelReason,
        verdict.execution.modelUsed ? 1 : 0,
        verdict.execution.degraded ? 1 : 0,
        JSON.stringify(verdict.execution.degradationReasons)
      );
    }
    return {
      id: roundId,
      runId: input.runId,
      phase: input.phase,
      topic: input.topic,
      transcript: input.transcript,
      verdicts
    };
  }

  createRevisionTask(input: {
    runId: string;
    sourceRoundId: number;
    sourceAgentName: string;
    rationale: string;
    assignedAgents: string[];
    topic: string;
    threadId?: string;
  }): RevisionTaskRecord {
    this.assertRunExists(input.runId);
    const now = new Date().toISOString();
    const task: RevisionTaskRecord = {
      id: `rev-${randomUUID()}`,
      runId: input.runId,
      sourceRoundId: input.sourceRoundId,
      sourceAgentName: input.sourceAgentName,
      rationale: input.rationale,
      assignedAgents: uniqueStrings(input.assignedAgents),
      topic: input.topic,
      status: "open",
      ...(input.threadId ? { threadId: input.threadId } : {}),
      evidenceNoteIds: [],
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `insert into revision_tasks
         (id, run_id, source_round_id, source_agent_name, rationale, assigned_agents_json, topic, status, thread_id, resolution_note, evidence_note_ids_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.runId,
        task.sourceRoundId,
        task.sourceAgentName,
        task.rationale,
        JSON.stringify(task.assignedAgents),
        task.topic,
        task.status,
        task.threadId ?? null,
        null,
        JSON.stringify(task.evidenceNoteIds),
        task.createdAt,
        task.updatedAt
      );
    return task;
  }

  resolveRevisionTask(input: {
    runId: string;
    taskId: string;
    status: RevisionTaskStatus;
    resolutionNote: string;
    evidenceNoteIds?: number[];
    threadId?: string;
  }): RevisionTaskRecord {
    if (input.status === "open") throw new Error("resolveRevisionTask requires resolved or waived status");
    this.assertRevisionTaskExists(input.runId, input.taskId);
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `update revision_tasks
         set status = ?, resolution_note = ?, evidence_note_ids_json = ?, thread_id = coalesce(?, thread_id), updated_at = ?
         where run_id = ? and id = ?`
      )
      .run(
        input.status,
        input.resolutionNote,
        JSON.stringify(input.evidenceNoteIds ?? []),
        input.threadId ?? null,
        updatedAt,
        input.runId,
        input.taskId
      );
    return this.getRevisionTask(input.runId, input.taskId);
  }

  attachRevisionTaskThread(input: { runId: string; taskId: string; threadId: string }): RevisionTaskRecord {
    this.assertRevisionTaskExists(input.runId, input.taskId);
    this.db
      .prepare("update revision_tasks set thread_id = ?, updated_at = ? where run_id = ? and id = ?")
      .run(input.threadId, new Date().toISOString(), input.runId, input.taskId);
    return this.getRevisionTask(input.runId, input.taskId);
  }

  recordTopologyEvent(input: {
    runId: string;
    eventType: string;
    taskId?: string;
    actor: string;
    targetAgents?: string[];
    threadId?: string;
    rationale: string;
    details?: Record<string, unknown>;
  }): TopologyEventRecord {
    this.assertRunExists(input.runId);
    if (input.taskId) this.assertRevisionTaskExists(input.runId, input.taskId);
    const targetAgents = uniqueStrings(input.targetAgents ?? []);
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `insert into topology_events
         (run_id, event_type, task_id, actor, target_agents_json, thread_id, rationale, details_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.runId,
        input.eventType,
        input.taskId ?? null,
        input.actor,
        JSON.stringify(targetAgents),
        input.threadId ?? null,
        input.rationale,
        JSON.stringify(input.details ?? {}),
        createdAt
      );
    return {
      id: Number(result.lastInsertRowid),
      runId: input.runId,
      eventType: input.eventType,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      actor: input.actor,
      targetAgents,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      rationale: input.rationale,
      details: input.details ?? {},
      createdAt
    };
  }

  listNotes(runId: string): NoteRecord[] {
    return (
      this.db.prepare("select * from notes where run_id = ? order by id").all(runId) as unknown as NoteRow[]
    ).map(noteFromRow);
  }

  listClaims(runId: string): ClaimRecord[] {
    return (
      this.db.prepare("select * from claims where run_id = ? order by id").all(runId) as unknown as ClaimRow[]
    ).map(claimFromRow);
  }

  listSources(runId: string): AggregatedSourceRecord[] {
    const byUrl = new Map<string, AggregatedSourceRecord>();
    for (const note of this.listNotes(runId)) {
      for (const source of note.sources) {
        const existing = byUrl.get(source.url);
        if (existing) {
          if (!existing.noteIds.includes(note.id)) existing.noteIds.push(note.id);
          if (!existing.agentNames.includes(note.agentName)) existing.agentNames.push(note.agentName);
          if (!existing.angles.includes(note.angle)) existing.angles.push(note.angle);
          continue;
        }
        byUrl.set(source.url, {
          ...source,
          noteIds: [note.id],
          agentNames: [note.agentName],
          angles: [note.angle]
        });
      }
    }
    return [...byUrl.values()];
  }

  listNegotiationRounds(runId: string): NegotiationRoundRecord[] {
    const rounds = this.db
      .prepare("select * from negotiation_rounds where run_id = ? order by id")
      .all(runId) as unknown as NegotiationRoundRow[];
    return rounds.map((round) => ({
      id: Number(round.id),
      runId: round.run_id,
      phase: round.phase as NegotiationPhase,
      topic: round.topic,
      transcript: round.transcript,
      verdicts: this.listVerdicts(round.run_id, Number(round.id))
    }));
  }

  listRevisionTasks(runId: string): RevisionTaskRecord[] {
    this.assertRunExists(runId);
    return (
      this.db.prepare("select * from revision_tasks where run_id = ? order by created_at, id").all(runId) as unknown as RevisionTaskRow[]
    ).map(revisionTaskFromRow);
  }

  listTopologyEvents(runId: string): TopologyEventRecord[] {
    this.assertRunExists(runId);
    return (
      this.db.prepare("select * from topology_events where run_id = ? order by id").all(runId) as unknown as TopologyEventRow[]
    ).map(topologyEventFromRow);
  }

  summarizeTopology(runId: string): TopologyTrace {
    const run = this.getRun(runId);
    const events = this.listTopologyEvents(runId);
    const revisionTasks = this.listRevisionTasks(runId);
    return {
      mode: run.topologyMode,
      initialRationale: run.topologyRationale,
      events,
      revisionTasks,
      openRevisionTasks: revisionTasks.filter((task) => task.status === "open"),
      degradedTopologyActions: events.filter(
        (event) => event.eventType.includes("degraded") || event.details.degraded === true
      )
    };
  }

  summarizeRunQuality(runId: string): RunQualitySummary {
    this.assertRunExists(runId);
    return buildRunQualitySummary(this.listNotes(runId), this.listNegotiationRounds(runId));
  }

  finalizeRun(runId: string): FinalPackage {
    const blockers = this.finalizationBlockers(runId);
    if (blockers.length > 0) throw new FinalizationBlockedError(blockers);

    const run = this.getRun(runId);
    const notes = this.listNotes(runId);
    const sources = this.listSources(runId);
    const claims = this.listClaims(runId);
    const rounds = this.listNegotiationRounds(runId);
    const negotiationStatus = summarizeNegotiationStatus(rounds);
    const runQuality = buildRunQualitySummary(notes, rounds);
    const topologyTrace = this.summarizeTopology(runId);
    const synthesis = buildSynthesisHandoff(run.topic, claims, rounds);
    const finalPackage: FinalPackage = {
      runId,
      topic: run.topic,
      format: run.format,
      notes,
      sources,
      claims,
      negotiation: {
        status: negotiationStatus,
        rounds
      },
      runQuality,
      topologyTrace,
      synthesis,
      markdown: renderMarkdownArtifact(run.topic, notes, sources, claims, rounds, negotiationStatus, runQuality, topologyTrace, synthesis)
    };

    this.db
      .prepare(
        `insert into final_packages (run_id, package_json, markdown, created_at)
         values (?, ?, ?, ?)
         on conflict(run_id) do update set package_json = excluded.package_json, markdown = excluded.markdown`
      )
      .run(runId, JSON.stringify(finalPackage), finalPackage.markdown, new Date().toISOString());
    return finalPackage;
  }

  readOnlyQuery(input: { runId: string; sql: string }): Record<string, unknown>[] {
    assertSafeSelect(input.sql);
    const parameterCount = (input.sql.match(/\?/g) ?? []).length;
    const params = parameterCount === 0 ? [] : [input.runId];
    return (this.db.prepare(input.sql).all(...params) as Record<string, unknown>[]).map((row) => ({
      ...row
    }));
  }

  private finalizationBlockers(runId: string): string[] {
    const run = this.getRun(runId);
    const rounds = this.listNegotiationRounds(runId);
    const blockers: string[] = [];
    if (rounds.length === 0 || !rounds.some((round) => round.phase === "debate" || round.phase === "consensus")) {
      blockers.push("negotiation_required");
    }

    const agentsWithVerdicts = new Set(
      rounds.flatMap((round) => round.verdicts.map((verdict) => verdict.agentName))
    );
    const missing = run.agents.filter((agentName) => !agentsWithVerdicts.has(agentName));
    if (missing.length > 0) blockers.push(`missing_agent_verdicts:${missing.join(",")}`);
    return blockers;
  }

  private listVerdicts(runId: string, roundId: number): NegotiationVerdict[] {
    return (
      this.db
        .prepare(
          `select agent_name, stance, rationale, model_provider, model_reason, model_used, degraded, degradation_reasons_json
           from negotiation_verdicts where run_id = ? and round_id = ? order by id`
        )
        .all(runId, roundId) as unknown as VerdictRow[]
    ).map((row) => ({
      agentName: row.agent_name,
      stance: row.stance as VerdictStance,
      rationale: row.rationale,
      execution: executionFromRow(row)
    }));
  }

  private getRevisionTask(runId: string, taskId: string): RevisionTaskRecord {
    const row = this.db.prepare("select * from revision_tasks where run_id = ? and id = ?").get(runId, taskId) as
      | RevisionTaskRow
      | undefined;
    if (!row) throw new Error(`Revision task not found: ${taskId}`);
    return revisionTaskFromRow(row);
  }

  private assertRevisionTaskExists(runId: string, taskId: string): void {
    this.getRevisionTask(runId, taskId);
  }

  private assertRunExists(runId: string): void {
    this.getRun(runId);
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists runs (
        id text primary key,
        topic text not null,
        format text not null,
        agents_json text not null,
        created_at text not null,
        topology_mode text not null default 'fixed',
        topology_rationale text not null default 'Fixed specialist topology: research, negotiation, finalization.'
      );

      create table if not exists notes (
        id integer primary key autoincrement,
        run_id text not null references runs(id) on delete cascade,
        agent_name text not null,
        angle text not null,
        content text not null,
        sources_json text not null,
        model_provider text not null default 'not_recorded',
        model_reason text not null default 'legacy_or_manual_write',
        model_used integer not null default 1,
        degraded integer not null default 0,
        degradation_reasons_json text not null default '[]',
        revision_task_id text references revision_tasks(id) on delete set null
      );

      create table if not exists claims (
        id integer primary key autoincrement,
        run_id text not null references runs(id) on delete cascade,
        agent_name text not null,
        claim text not null,
        evidence_note_ids_json text not null,
        confidence real not null,
        caveats_json text not null default '[]',
        source_urls_json text not null default '[]',
        revision_task_id text references revision_tasks(id) on delete set null
      );

      create table if not exists negotiation_rounds (
        id integer primary key autoincrement,
        run_id text not null references runs(id) on delete cascade,
        phase text not null,
        topic text not null,
        transcript text not null
      );

      create table if not exists negotiation_verdicts (
        id integer primary key autoincrement,
        round_id integer not null references negotiation_rounds(id) on delete cascade,
        run_id text not null references runs(id) on delete cascade,
        agent_name text not null,
        stance text not null,
        rationale text not null,
        model_provider text not null default 'not_recorded',
        model_reason text not null default 'legacy_or_manual_write',
        model_used integer not null default 1,
        degraded integer not null default 0,
        degradation_reasons_json text not null default '[]'
      );

      create table if not exists revision_tasks (
        id text primary key,
        run_id text not null references runs(id) on delete cascade,
        source_round_id integer not null references negotiation_rounds(id) on delete cascade,
        source_agent_name text not null,
        rationale text not null,
        assigned_agents_json text not null,
        topic text not null,
        status text not null,
        thread_id text,
        resolution_note text,
        evidence_note_ids_json text not null default '[]',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists topology_events (
        id integer primary key autoincrement,
        run_id text not null references runs(id) on delete cascade,
        event_type text not null,
        task_id text references revision_tasks(id) on delete set null,
        actor text not null,
        target_agents_json text not null default '[]',
        thread_id text,
        rationale text not null,
        details_json text not null default '{}',
        created_at text not null
      );

      create table if not exists final_packages (
        run_id text primary key references runs(id) on delete cascade,
        package_json text not null,
        markdown text not null,
        created_at text not null
      );
    `);
    this.ensureColumn("runs", "topology_mode", "text not null default 'fixed'");
    this.ensureColumn("runs", "topology_rationale", "text not null default 'Fixed specialist topology: research, negotiation, finalization.'");
    this.ensureColumn("notes", "model_provider", "text not null default 'not_recorded'");
    this.ensureColumn("notes", "model_reason", "text not null default 'legacy_or_manual_write'");
    this.ensureColumn("notes", "model_used", "integer not null default 1");
    this.ensureColumn("notes", "degraded", "integer not null default 0");
    this.ensureColumn("notes", "degradation_reasons_json", "text not null default '[]'");
    this.ensureColumn("notes", "revision_task_id", "text references revision_tasks(id) on delete set null");
    this.ensureColumn("claims", "caveats_json", "text not null default '[]'");
    this.ensureColumn("claims", "source_urls_json", "text not null default '[]'");
    this.ensureColumn("claims", "revision_task_id", "text references revision_tasks(id) on delete set null");
    this.ensureColumn("negotiation_verdicts", "model_provider", "text not null default 'not_recorded'");
    this.ensureColumn("negotiation_verdicts", "model_reason", "text not null default 'legacy_or_manual_write'");
    this.ensureColumn("negotiation_verdicts", "model_used", "integer not null default 1");
    this.ensureColumn("negotiation_verdicts", "degraded", "integer not null default 0");
    this.ensureColumn("negotiation_verdicts", "degradation_reasons_json", "text not null default '[]'");
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`pragma table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`alter table ${tableName} add column ${columnName} ${definition}`);
    }
  }
}

export function createBlackboardTools(db: Blackboard): {
  writeNote(input: {
    runId: string;
    agentName: string;
    angle: string;
    content: string;
    sources: SourceRef[];
    execution?: Partial<AgentExecutionMetadata>;
    revisionTaskId?: string;
  }): NoteRecord;
  readOnlyQuery(input: { runId: string; sql: string }): Record<string, unknown>[];
} {
  return {
    writeNote: (input) => db.addNote(input),
    readOnlyQuery: (input) => db.readOnlyQuery(input)
  };
}

function assertSafeSelect(sql: string): void {
  const normalized = sql.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized.startsWith("select ") || normalized.includes(";")) {
    throw new Error("Only single SELECT statements are allowed");
  }
  const forbidden = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|replace)\b/;
  if (forbidden.test(normalized)) throw new Error("Only single SELECT statements are allowed");
}

function renderMarkdownArtifact(
  topic: string,
  notes: NoteRecord[],
  sources: AggregatedSourceRecord[],
  claims: ClaimRecord[],
  rounds: NegotiationRoundRecord[],
  negotiationStatus: NegotiationStatus,
  runQuality: RunQualitySummary,
  topologyTrace: TopologyTrace,
  synthesis: SynthesisHandoff
): string {
  const lines = [`# Research: ${topic}`, "", "## Key Claims", ""];
  for (const claim of claims) {
    lines.push(`- ${claim.claim} (confidence ${claim.confidence.toFixed(2)}, ${claim.agentName})`);
    for (const caveat of claim.caveats) lines.push(`  - Caveat: ${caveat}`);
  }
  lines.push("", "## Codex Synthesis Handoff", "");
  lines.push(synthesis.codexResponsibility, "");
  lines.push("### Longer-Form Document Structure", "");
  for (const section of synthesis.document.recommendedSections) {
    lines.push(`- ${section.heading}`);
  }
  lines.push("", "### Slide Structure", "");
  for (const slide of synthesis.slides.recommendedSlides) {
    lines.push(`- ${slide.title}: ${slide.bullets.join("; ")}`);
  }
  lines.push("", "## Run Quality", "");
  lines.push(`Negotiation status: ${formatNegotiationStatus(negotiationStatus)}`, "");
  if (runQuality.degradedWork.length === 0) {
    lines.push("- No degraded agent work was recorded.");
  } else {
    for (const item of runQuality.degradedWork) {
      const location = item.phase === "research" ? `note ${item.noteId}` : `round ${item.roundId}`;
      lines.push(
        `- ${item.agentName} degraded during ${item.phase} (${location}; ${item.modelProvider}/${item.modelReason}; reasons: ${item.degradationReasons.join(", ") || "unknown"})`
      );
    }
  }
  if (runQuality.revisionRequests.length > 0) {
    lines.push("", "Revision requests:");
    for (const verdict of runQuality.revisionRequests) {
      lines.push(`- ${verdict.agentName} in round ${verdict.roundId}: ${verdict.rationale}`);
    }
  }
  if (runQuality.dissentingVerdicts.length > 0) {
    lines.push("", "Dissent:");
    for (const verdict of runQuality.dissentingVerdicts) {
      lines.push(`- ${verdict.agentName} in round ${verdict.roundId}: ${verdict.rationale}`);
    }
  }
  lines.push("", "## Topology Trace", "");
  lines.push(`Mode: ${topologyTrace.mode}`, "");
  lines.push(`Initial rationale: ${topologyTrace.initialRationale}`, "");
  if (topologyTrace.revisionTasks.length === 0) {
    lines.push("- No dynamic revision tasks were recorded.");
  } else {
    lines.push("Revision tasks:");
    for (const task of topologyTrace.revisionTasks) {
      const thread = task.threadId ? `, thread ${task.threadId}` : "";
      lines.push(`- ${task.topic}: ${task.status} (${task.assignedAgents.join(", ")}${thread})`);
      lines.push(`  - Rationale: ${task.rationale}`);
      if (task.resolutionNote) lines.push(`  - Resolution: ${task.resolutionNote}`);
    }
  }
  if (topologyTrace.openRevisionTasks.length > 0) {
    lines.push("", "Open revision tasks:");
    for (const task of topologyTrace.openRevisionTasks) {
      lines.push(`- ${task.topic}: ${task.rationale}`);
    }
  }
  lines.push("", "## Blackboard Notes", "");
  for (const note of notes) {
    lines.push(`### ${note.angle} (${note.agentName})`, "", note.content, "");
    for (const source of note.sources) {
      const details = [source.domain, source.publishedAt, source.reliability].filter(Boolean).join(" | ");
      lines.push(`- [${source.title}](${source.url})${details ? ` - ${details}` : ""}`);
    }
    if (note.sources.length > 0) lines.push("");
  }
  lines.push("## Sources", "");
  for (const source of sources) {
    const details = [source.domain, source.publisher, source.publishedAt, source.reliability].filter(Boolean).join(" | ");
    lines.push(`- [${source.title}](${source.url})${details ? ` - ${details}` : ""}`);
  }
  lines.push("## Negotiation", "");
  lines.push(`Status: ${formatNegotiationStatus(negotiationStatus)}`);
  for (const round of rounds) {
    lines.push("", `### ${round.phase}: ${round.topic}`, "", round.transcript, "");
    for (const verdict of round.verdicts) {
      const label = verdict.stance === "dissent" ? "Dissent" : verdict.stance;
      lines.push(`- ${verdict.agentName}: ${label} - ${verdict.rationale}`);
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

function buildSynthesisHandoff(
  topic: string,
  claims: ClaimRecord[],
  rounds: NegotiationRoundRecord[]
): SynthesisHandoff {
  const caveats = uniqueStrings(claims.flatMap((claim) => claim.caveats));
  const sourceUrls = uniqueStrings(claims.flatMap((claim) => claim.sourceUrls));
  const claimIds = claims.map((claim) => claim.id);
  const debateSourceUrls = sourceUrls.slice(0, 8);
  const nonAccept = rounds.flatMap((round) => round.verdicts).filter((verdict) => verdict.stance !== "accept");
  const debateCaveats = uniqueStrings([
    ...caveats,
    ...nonAccept.map((verdict) => verdict.rationale)
  ]).slice(0, 8);

  return {
    codexResponsibility:
      "Delve has produced negotiated, source-grounded research notes. Codex should use this package to write the requested final artifact format; Delve agents do not emit DOCX, PPTX, or polished user-facing deliverables.",
    document: {
      title: `Research Brief: ${topic}`,
      recommendedSections: [
        { heading: "Executive Summary", claimIds, sourceUrls: debateSourceUrls },
        { heading: "Evidence-Backed Findings", claimIds, sourceUrls: debateSourceUrls },
        { heading: "Tradeoffs, Caveats, and Dissent", claimIds, sourceUrls: debateSourceUrls },
        { heading: "Recommended Next Steps", claimIds, sourceUrls: debateSourceUrls }
      ]
    },
    slides: {
      title: `Research Brief: ${topic}`,
      recommendedSlides: [
        {
          title: "Thesis",
          bullets: claims.slice(0, 2).map((claim) => claim.claim),
          claimIds: claims.slice(0, 2).map((claim) => claim.id),
          sourceUrls: debateSourceUrls.slice(0, 4)
        },
        {
          title: "Evidence",
          bullets: claims.slice(2, 5).map((claim) => claim.claim),
          claimIds: claims.slice(2, 5).map((claim) => claim.id),
          sourceUrls: debateSourceUrls.slice(0, 6)
        },
        {
          title: "Tradeoffs",
          bullets: debateCaveats.length > 0 ? debateCaveats.slice(0, 4) : ["No major caveats were recorded during negotiation."],
          claimIds,
          sourceUrls: debateSourceUrls
        },
        {
          title: "Decision Points",
          bullets: ["Where the evidence is strong", "Where more validation is needed", "How Codex should tailor the final artifact to the user's requested format"],
          claimIds,
          sourceUrls: debateSourceUrls
        }
      ]
    },
    caveats: debateCaveats
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function summarizeNegotiationStatus(rounds: NegotiationRoundRecord[]): NegotiationStatus {
  const verdicts = rounds.flatMap((round) => round.verdicts);
  if (verdicts.some((verdict) => verdict.stance === "dissent")) return "complete_with_dissent";
  if (verdicts.some((verdict) => verdict.stance === "revise")) return "complete_with_revision_requests";
  return "complete";
}

function buildRunQualitySummary(notes: NoteRecord[], rounds: NegotiationRoundRecord[]): RunQualitySummary {
  const degradedWork: DegradedWorkRecord[] = [];
  for (const note of notes) {
    if (!note.execution.degraded) continue;
    degradedWork.push({
      phase: "research",
      agentName: note.agentName,
      noteId: note.id,
      modelProvider: note.execution.modelProvider,
      modelReason: note.execution.modelReason,
      modelUsed: note.execution.modelUsed,
      degradationReasons: note.execution.degradationReasons
    });
  }

  const revisionRequests: VerdictQualityRecord[] = [];
  const dissentingVerdicts: VerdictQualityRecord[] = [];
  for (const round of rounds) {
    for (const verdict of round.verdicts) {
      const record: VerdictQualityRecord = {
        agentName: verdict.agentName,
        stance: verdict.stance,
        rationale: verdict.rationale,
        roundId: round.id,
        phase: round.phase,
        topic: round.topic,
        execution: verdict.execution
      };
      if (verdict.execution.degraded) {
        degradedWork.push({
          phase: "negotiation",
          agentName: verdict.agentName,
          roundId: round.id,
          topic: round.topic,
          modelProvider: verdict.execution.modelProvider,
          modelReason: verdict.execution.modelReason,
          modelUsed: verdict.execution.modelUsed,
          degradationReasons: verdict.execution.degradationReasons
        });
      }
      if (verdict.stance === "revise") revisionRequests.push(record);
      if (verdict.stance === "dissent") dissentingVerdicts.push(record);
    }
  }

  return { degradedWork, revisionRequests, dissentingVerdicts };
}

function normalizeExecution(input?: Partial<AgentExecutionMetadata>): AgentExecutionMetadata {
  const degraded = input?.degraded ?? false;
  const degradationReasons = uniqueStrings(input?.degradationReasons ?? []);
  return {
    modelProvider: input?.modelProvider ?? "not_recorded",
    modelReason: input?.modelReason ?? "legacy_or_manual_write",
    modelUsed: input?.modelUsed ?? true,
    degraded,
    degradationReasons: degraded && degradationReasons.length === 0 ? ["unknown"] : degradationReasons
  };
}

function executionFromRow(row: ExecutionColumns): AgentExecutionMetadata {
  return normalizeExecution({
    modelProvider: row.model_provider,
    modelReason: row.model_reason,
    modelUsed: Number(row.model_used ?? 1) === 1,
    degraded: Number(row.degraded ?? 0) === 1,
    degradationReasons: parseJsonArray(row.degradation_reasons_json)
  });
}

function formatNegotiationStatus(status: NegotiationStatus): string {
  if (status === "complete_with_dissent") return "Complete with Dissent";
  if (status === "complete_with_revision_requests") return "Complete with Revision Requests";
  return "Complete";
}

function runFromRow(row: RunRow): RunRecord {
  const topologyMode = row.topology_mode === "dynamic-revision" ? "dynamic-revision" : "fixed";
  return {
    id: row.id,
    topic: row.topic,
    format: row.format as ArtifactFormat,
    agents: JSON.parse(row.agents_json) as string[],
    createdAt: row.created_at,
    topologyMode,
    topologyRationale: row.topology_rationale || defaultTopologyRationale(topologyMode)
  };
}

function noteFromRow(row: NoteRow): NoteRecord {
  return {
    id: Number(row.id),
    runId: row.run_id,
    agentName: row.agent_name,
    angle: row.angle,
    content: row.content,
    sources: JSON.parse(row.sources_json) as SourceRef[],
    execution: executionFromRow(row),
    ...(row.revision_task_id ? { revisionTaskId: row.revision_task_id } : {})
  };
}

function claimFromRow(row: ClaimRow): ClaimRecord {
  return {
    id: Number(row.id),
    runId: row.run_id,
    agentName: row.agent_name,
    claim: row.claim,
    evidenceNoteIds: JSON.parse(row.evidence_note_ids_json) as number[],
    confidence: Number(row.confidence),
    caveats: parseJsonArray(row.caveats_json),
    sourceUrls: parseJsonArray(row.source_urls_json),
    ...(row.revision_task_id ? { revisionTaskId: row.revision_task_id } : {})
  };
}

function revisionTaskFromRow(row: RevisionTaskRow): RevisionTaskRecord {
  return {
    id: row.id,
    runId: row.run_id,
    sourceRoundId: Number(row.source_round_id),
    sourceAgentName: row.source_agent_name,
    rationale: row.rationale,
    assignedAgents: parseJsonArray(row.assigned_agents_json),
    topic: row.topic,
    status: revisionTaskStatusFromRow(row.status),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.resolution_note ? { resolutionNote: row.resolution_note } : {}),
    evidenceNoteIds: parseJsonNumberArray(row.evidence_note_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function topologyEventFromRow(row: TopologyEventRow): TopologyEventRecord {
  return {
    id: Number(row.id),
    runId: row.run_id,
    eventType: row.event_type,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    actor: row.actor,
    targetAgents: parseJsonArray(row.target_agents_json),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    rationale: row.rationale,
    details: parseJsonObject(row.details_json),
    createdAt: row.created_at
  };
}

function revisionTaskStatusFromRow(value: string): RevisionTaskStatus {
  return value === "resolved" || value === "waived" ? value : "open";
}

function defaultTopologyRationale(mode: TopologyMode): string {
  if (mode === "dynamic-revision") {
    return "Dynamic revision topology: preserve fixed specialists, then route revise verdicts into targeted follow-up tasks before final handoff.";
  }
  return "Fixed specialist topology: research, negotiation, finalization.";
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseJsonNumberArray(value: string | null | undefined): number[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map((item) => Number(item)).filter((item) => Number.isFinite(item)) : [];
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

interface RunRow {
  id: string;
  topic: string;
  format: string;
  agents_json: string;
  created_at: string;
  topology_mode?: string;
  topology_rationale?: string;
}

interface ExecutionColumns {
  model_provider?: string;
  model_reason?: string;
  model_used?: number;
  degraded?: number;
  degradation_reasons_json?: string;
}

interface NoteRow extends ExecutionColumns {
  id: number;
  run_id: string;
  agent_name: string;
  angle: string;
  content: string;
  sources_json: string;
  revision_task_id?: string | null;
}

interface ClaimRow {
  id: number;
  run_id: string;
  agent_name: string;
  claim: string;
  evidence_note_ids_json: string;
  confidence: number;
  caveats_json?: string;
  source_urls_json?: string;
  revision_task_id?: string | null;
}

interface NegotiationRoundRow {
  id: number;
  run_id: string;
  phase: string;
  topic: string;
  transcript: string;
}

interface VerdictRow extends ExecutionColumns {
  agent_name: string;
  stance: string;
  rationale: string;
}

interface RevisionTaskRow {
  id: string;
  run_id: string;
  source_round_id: number;
  source_agent_name: string;
  rationale: string;
  assigned_agents_json: string;
  topic: string;
  status: string;
  thread_id?: string | null;
  resolution_note?: string | null;
  evidence_note_ids_json?: string;
  created_at: string;
  updated_at: string;
}

interface TopologyEventRow {
  id: number;
  run_id: string;
  event_type: string;
  task_id?: string | null;
  actor: string;
  target_agents_json: string;
  thread_id?: string | null;
  rationale: string;
  details_json?: string;
  created_at: string;
}
