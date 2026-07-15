export interface ReadApiConfig {
  host: string;
  port: number;
  bearerToken: string;
  runLogDir: string;
  sessionDir: string;
  artifactDir: string;
  apiVersion: string;
}

export interface SessionMetadata {
  sessionId: string;
  agentId: "fabee-pi-agent";
  routeId: "fabee";
  transport: "web";
  owner: string;
  collaborators: string[];
  createdAt: string;
  archivedAt: string | null;
}

export type SessionRole = "owner" | "collaborator";

export interface SessionPermissions {
  canRead: boolean;
  canSend: boolean;
  canCancelOwnRun: boolean;
  canCancelAnyRun: boolean;
  canCancelRun?: boolean;
  canShare: boolean;
  canArchive: boolean;
  canReadArtifacts: boolean;
}

export interface RunSummary {
  runId: string;
  sessionId?: string;
  filePath: string;
  fileMtimeIso: string;
  status: "completed" | "failed" | "incomplete" | "unknown";
  requestedAt?: string;
  completedAt?: string;
  failedAt?: string;
  actor?: { email?: string };
  prompt?: string;
  usage?: {
    contextTokens?: number;
    contextWindow?: number;
  };
  model?: {
    provider?: string;
    id?: string;
  };
  thinkingLevel?: string;
  artifacts: ArtifactSummary[];
  parseWarnings: Array<{ line: number; message: string }>;
}

export interface ArtifactSummary {
  artifactId: string;
  runId: string;
  sessionId: string;
  blobKey: string;
  name?: string;
  title?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface SessionSummary {
  sessionId: string;
  contextUpdatedAt?: string;
  lastPromptUpdatedAt?: string;
  lastRunAt?: string;
  lastActivityAt?: string;
  runCount: number;
  metadata?: SessionMetadata;
  owner?: string;
  collaborators?: string[];
  role?: SessionRole;
  permissions?: SessionPermissions;
}

export interface SessionDetail extends SessionSummary {
  context: unknown[];
  lastPrompt?: unknown;
  latestRun?: RunSummary;
  runs?: RunSummary[];
  artifacts?: ArtifactSummary[];
}
