export interface CoralClientOptions {
  baseUrl: string;
  authKey: string;
  fetchImpl?: typeof fetch;
}

export interface CoralSessionIdentifier {
  namespace: string;
  sessionId: string;
}

export interface CoralAgentState {
  name: string;
  status?: {
    type?: string;
    connectionStatus?: {
      type?: string;
      communicationStatus?: {
        type?: string;
      };
    };
  };
}

export interface CoralThread {
  id: string;
  name: string;
  creatorName: string;
  participants: string[];
}

export interface CoralExtendedState {
  agents: CoralAgentState[];
  threads: CoralThread[];
}

export interface BuildSessionRequestOptions {
  namespace: string;
  topic: string;
  dbPath: string;
  agents: readonly string[];
  modelName: string;
  secrets?: {
    coralApiKey?: string;
    exaApiKey?: string;
  };
  ttlMs?: number;
  holdAfterExitMs?: number;
}

export interface CreateSessionOptions extends BuildSessionRequestOptions {}

export interface CreateThreadOptions extends CoralSessionIdentifier {
  actor: string;
  threadName: string;
  participantNames: readonly string[];
}

export interface SendMessageOptions extends CoralSessionIdentifier {
  actor: string;
  threadId: string;
  content: string;
  mentions: readonly string[];
}

export interface WaitForAgentsOptions extends CoralSessionIdentifier {
  agents: readonly string[];
  timeoutMs: number;
  pollMs?: number;
}

type FetchLike = typeof fetch;

export class CoralClient {
  private readonly baseUrl: string;
  private readonly authKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: CoralClientOptions) {
    this.baseUrl = ensureTrailingSlash(options.baseUrl);
    this.authKey = options.authKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createSession(options: CreateSessionOptions): Promise<CoralSessionIdentifier> {
    return this.request<CoralSessionIdentifier>("/api/v1/local/session", {
      method: "POST",
      body: buildLocalSessionRequest(options)
    });
  }

  async getExtendedState(session: CoralSessionIdentifier): Promise<CoralExtendedState> {
    return this.request<CoralExtendedState>(
      `/api/v1/local/session/${encodeURIComponent(session.namespace)}/${encodeURIComponent(session.sessionId)}/extended`
    );
  }

  async waitForAgentsReady(options: WaitForAgentsOptions): Promise<CoralExtendedState> {
    const deadline = Date.now() + options.timeoutMs;
    let lastState: CoralExtendedState | undefined;
    while (Date.now() <= deadline) {
      lastState = await this.getExtendedState(options);
      if (agentsReady(lastState.agents, options.agents)) return lastState;
      const stopped = lastState.agents.filter((agent) => agent.status?.type === "stopped").map((agent) => agent.name);
      if (stopped.length > 0) throw new Error(`Coral agents stopped before readiness: ${stopped.join(", ")}`);
      await sleep(options.pollMs ?? 750);
    }
    throw new Error(`Timed out waiting for Coral agents: ${agentStatusSummary(lastState?.agents ?? [])}`);
  }

  async createThread(options: CreateThreadOptions): Promise<CoralThread> {
    const response = await this.request<{ thread: CoralThread }>(
      `/api/v1/puppet/${encodeURIComponent(options.namespace)}/${encodeURIComponent(options.sessionId)}/${encodeURIComponent(
        options.actor
      )}/thread`,
      {
        method: "POST",
        body: {
          threadName: options.threadName,
          participantNames: [...options.participantNames]
        }
      }
    );
    return response.thread;
  }

  async sendMessage(options: SendMessageOptions): Promise<void> {
    await this.request(
      `/api/v1/puppet/${encodeURIComponent(options.namespace)}/${encodeURIComponent(options.sessionId)}/${encodeURIComponent(
        options.actor
      )}/thread/message`,
      {
        method: "POST",
        body: {
          threadId: options.threadId,
          content: options.content,
          mentions: [...options.mentions]
        }
      }
    );
  }

  async closeSession(session: CoralSessionIdentifier): Promise<void> {
    await this.request(`/api/v1/local/session/${encodeURIComponent(session.namespace)}/${encodeURIComponent(session.sessionId)}`, {
      method: "DELETE"
    });
  }

  private async request<T = unknown>(
    requestPath: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const response = await this.fetchImpl(new URL(requestPath, this.baseUrl), {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.authKey}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    const body = parseMaybeJson(text);
    if (!response.ok) {
      throw new Error(`Coral HTTP ${response.status} for ${requestPath}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    }
    return body as T;
  }
}

export function buildLocalSessionRequest(options: BuildSessionRequestOptions): Record<string, unknown> {
  return {
    agentGraphRequest: {
      agents: options.agents.map((agentName) => ({
        id: {
          name: agentName,
          version: "0.1.0",
          registrySourceId: { type: "local" }
        },
        name: agentName,
        provider: {
          type: "local",
          runtime: "executable"
        },
        blocking: true,
        options: {
          BLACKBOARD_DB_PATH: { type: "string", value: options.dbPath },
          RESEARCH_ROLE: { type: "string", value: agentName },
          MODEL_NAME: { type: "string", value: options.modelName },
          ...secretOptions(options.secrets)
        }
      })),
      groups: [options.agents]
    },
    namespaceProvider: {
      type: "create_if_not_exists",
      namespaceRequest: {
        name: options.namespace,
        deleteOnLastSessionExit: true,
        annotations: {
          app: "delve",
          topic: options.topic
        }
      }
    },
    execution: {
      mode: "immediate",
      runtimeSettings: {
        ttl: options.ttlMs ?? 180000,
        extendedEndReport: true,
        persistenceMode: {
          mode: "hold_after_exit",
          duration: options.holdAfterExitMs ?? 60000
        }
      }
    },
    annotations: {
      app: "delve",
      topic: options.topic
    }
  };
}

function secretOptions(secrets: BuildSessionRequestOptions["secrets"]): Record<string, { type: "string"; value: string }> {
  const entries: Record<string, { type: "string"; value: string }> = {};
  if (secrets?.coralApiKey) entries.CORAL_API_KEY = { type: "string", value: secrets.coralApiKey };
  if (secrets?.exaApiKey) entries.EXA_API_KEY = { type: "string", value: secrets.exaApiKey };
  return entries;
}

export function agentsReady(states: readonly CoralAgentState[], expected: readonly string[]): boolean {
  const byName = new Map(states.map((state) => [state.name, state]));
  return expected.every((name) => {
    const status = byName.get(name)?.status;
    const connection = status?.connectionStatus;
    const communication = connection?.communicationStatus;
    return (
      status?.type === "running" &&
      connection?.type === "connected" &&
      communication?.type === "waiting_message"
    );
  });
}

export function agentStatusSummary(states: readonly CoralAgentState[]): string {
  if (states.length === 0) return "no_agents";
  return states
    .map((agent) => {
      const status = agent.status;
      const connection = status?.connectionStatus;
      const communication = connection?.communicationStatus;
      return [agent.name, status?.type, connection?.type, communication?.type].filter(Boolean).join(":");
    })
    .join(", ");
}

function parseMaybeJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
