import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { listDirectories, listFiles, pathExists } from "./fs-utils.js";
import { parseJsonLines, parseRunLog } from "./parser.js";
import { isAuthorizedSessionId, normalizeEmail, validateCollaborators } from "./security.js";
import { ArtifactSummary, RunSummary, SessionDetail, SessionMetadata, SessionPermissions, SessionRole, SessionSummary } from "./types.js";

interface SessionFiles {
  sessionId: string;
  contextPath: string;
  lastPromptPath: string;
}

interface ScanData {
  runsBySessionId: Map<string, RunSummary[]>;
  runActivityBySessionId: Map<string, string>;
  artifactsBySessionId: Map<string, ArtifactSummary[]>;
}

export class LogReadRepository {
  constructor(
    private readonly sessionDir: string,
    private readonly runLogDir: string,
    private readonly artifactDir = "",
  ) {}

  async createSession(ownerEmail: string): Promise<SessionDetail> {
    const now = new Date().toISOString();
    const metadata: SessionMetadata = {
      sessionId: `ses_${randomUUID()}`,
      agentId: "fabee-pi-agent",
      routeId: "fabee",
      transport: "web",
      owner: normalizeEmail(ownerEmail),
      collaborators: [],
      createdAt: now,
      archivedAt: null,
    };
    await this.writeMetadata(metadata);
    return (await this.getSession(metadata.sessionId, metadata.owner))!;
  }

  async listSessions(agentId: string, userKey: string, limit: number): Promise<SessionSummary[]> {
    const scan = await this.scanRuns();
    const sessions = await this.findAuthorizedSessionFiles(agentId, userKey);
    const summaries = await Promise.all(
      sessions.map(async (session) => this.buildSessionSummary(session, scan.runsBySessionId.get(session.sessionId) ?? [], scan.runActivityBySessionId.get(session.sessionId))),
    );
    return summaries
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.sessionId.localeCompare(b.sessionId))
      .slice(0, limit);
  }

  async listAccessibleSessions(actorEmail: string, limit: number): Promise<{ owned: SessionSummary[]; shared: SessionSummary[] }> {
    const actor = normalizeEmail(actorEmail);
    const scan = await this.scanRuns();
    const files = await this.findMetadataSessionFiles();
    const summaries = (await Promise.all(files.map(async (file) => this.summaryIfAccessible(file, actor, scan)))).filter((value): value is SessionSummary => Boolean(value));
    const sorted = summaries.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.sessionId.localeCompare(b.sessionId));
    return {
      owned: sorted.filter((session) => session.role === "owner").slice(0, limit),
      shared: sorted.filter((session) => session.role === "collaborator").slice(0, limit),
    };
  }

  async getSession(sessionId: string, actorOrUserKey: string): Promise<SessionDetail | null> {
    const files = await this.getSessionFiles(sessionId);
    if (!files) return null;
    const metadata = await this.readMetadata(sessionId);
    const actorEmail = actorOrUserKey.includes("@") ? normalizeEmail(actorOrUserKey) : undefined;
    if (metadata && (!actorEmail || !this.role(metadata, actorEmail) || metadata.archivedAt)) return null;

    const scan = await this.scanRuns();
    const runs = (scan.runsBySessionId.get(sessionId) ?? []).sort((a, b) => b.fileMtimeIso.localeCompare(a.fileMtimeIso));
    const summary = await this.buildSessionSummary(files, runs, scan.runActivityBySessionId.get(sessionId), metadata ?? undefined, actorEmail);
    const rawContext = (await pathExists(files.contextPath)) ? await parseJsonLines(files.contextPath) : [];
    const context = this.addStructuredAuthors(rawContext, runs);
    const lastPrompt = (await pathExists(files.lastPromptPath)) ? JSON.parse(await readFile(files.lastPromptPath, "utf8")) : undefined;
    return { ...summary, context, lastPrompt, latestRun: runs[0], runs, artifacts: scan.artifactsBySessionId.get(sessionId) ?? [] };
  }

  async getSessionRuns(sessionId: string): Promise<RunSummary[] | null> {
    const files = await this.getSessionFiles(sessionId);
    if (!files) return null;
    const scan = await this.scanRuns();
    return (scan.runsBySessionId.get(sessionId) ?? []).sort((a, b) => b.fileMtimeIso.localeCompare(a.fileMtimeIso));
  }

  async capabilities(sessionId: string, actorEmail: string, runActorEmail?: string): Promise<{ role: SessionRole; permissions: SessionPermissions } | null> {
    const metadata = await this.readMetadata(sessionId);
    if (!metadata || metadata.archivedAt) return null;
    const actor = normalizeEmail(actorEmail);
    const role = this.role(metadata, actor);
    if (!role) return null;
    const permissions = this.permissions(role);
    if (runActorEmail) permissions.canCancelRun = role === "owner" || normalizeEmail(runActorEmail) === actor;
    return { role, permissions };
  }

  async updateCollaborators(sessionId: string, actorEmail: string, collaboratorsValue: unknown): Promise<SessionMetadata | null> {
    const metadata = await this.readMetadata(sessionId);
    const actor = normalizeEmail(actorEmail);
    if (!metadata || metadata.archivedAt || metadata.owner !== actor) return null;
    const previous = new Set(metadata.collaborators);
    metadata.collaborators = validateCollaborators(collaboratorsValue, metadata.owner);
    await this.writeMetadata(metadata);
    const next = new Set(metadata.collaborators);
    for (const email of metadata.collaborators) if (!previous.has(email)) await this.appendAudit(sessionId, { type: "collaborator_added", actor, target: email });
    for (const email of previous) if (!next.has(email)) await this.appendAudit(sessionId, { type: "collaborator_removed", actor, target: email });
    return metadata;
  }

  async archiveSession(sessionId: string, actorEmail: string): Promise<SessionMetadata | null> {
    const metadata = await this.readMetadata(sessionId);
    const actor = normalizeEmail(actorEmail);
    if (!metadata || metadata.archivedAt || metadata.owner !== actor) return null;
    metadata.archivedAt = new Date().toISOString();
    await this.writeMetadata(metadata);
    await this.appendAudit(sessionId, { type: "archived", actor });
    return metadata;
  }

  async getArtifact(sessionId: string, actorEmail: string, artifactId: string): Promise<{ artifact: ArtifactSummary; filePath: string } | null> {
    if (!(await this.capabilities(sessionId, actorEmail))) return null;
    const scan = await this.scanRuns();
    const artifact = (scan.artifactsBySessionId.get(sessionId) ?? []).find((item) => item.artifactId === artifactId);
    if (!artifact) return null;
    const root = resolve(this.artifactDir);
    const filePath = resolve(join(root, artifact.blobKey));
    if (!this.artifactDir || (!filePath.startsWith(`${root}/`) && filePath !== root) || !(await pathExists(filePath))) return null;
    return { artifact, filePath };
  }

  private async findAuthorizedSessionFiles(agentId: string, userKey: string): Promise<SessionFiles[]> {
    const names = await listDirectories(this.sessionDir);
    const sessions = names.filter((name) => isAuthorizedSessionId(name, agentId, userKey));
    return (await Promise.all(sessions.map(async (sessionId) => this.getSessionFiles(sessionId)))).filter((value): value is SessionFiles => Boolean(value));
  }

  private async findMetadataSessionFiles(): Promise<SessionFiles[]> {
    const names = await listDirectories(this.sessionDir);
    return (await Promise.all(names.filter((name) => name.startsWith("ses_")).map(async (sessionId) => this.getSessionFiles(sessionId)))).filter((value): value is SessionFiles => Boolean(value));
  }

  private async getSessionFiles(sessionId: string): Promise<SessionFiles | null> {
    const metadataPath = join(this.sessionDir, sessionId, "session.json");
    const contextPath = join(this.sessionDir, sessionId, "context.jsonl");
    if (!(await pathExists(metadataPath)) && !(await pathExists(contextPath))) return null;
    return { sessionId, contextPath, lastPromptPath: join(this.sessionDir, sessionId, "last_prompt.json") };
  }

  private async summaryIfAccessible(files: SessionFiles, actor: string, scan: ScanData): Promise<SessionSummary | null> {
    const metadata = await this.readMetadata(files.sessionId);
    if (!metadata || metadata.archivedAt || !this.role(metadata, actor)) return null;
    return this.buildSessionSummary(files, scan.runsBySessionId.get(files.sessionId) ?? [], scan.runActivityBySessionId.get(files.sessionId), metadata, actor);
  }

  private async buildSessionSummary(session: SessionFiles, runs: RunSummary[], runActivityAt?: string, metadata?: SessionMetadata, actor?: string): Promise<SessionSummary> {
    const contextUpdatedAt = await this.safeMtimeIso(session.contextPath);
    const lastPromptUpdatedAt = await this.safeMtimeIso(session.lastPromptPath);
    const lastActivityAt = [contextUpdatedAt, lastPromptUpdatedAt, runActivityAt].filter((value): value is string => Boolean(value)).sort().at(-1);
    const role = metadata && actor ? this.role(metadata, actor) : undefined;
    return {
      sessionId: session.sessionId,
      contextUpdatedAt,
      lastPromptUpdatedAt,
      lastRunAt: runActivityAt,
      lastActivityAt,
      runCount: runs.length,
      metadata,
      owner: metadata?.owner,
      collaborators: metadata?.collaborators,
      role,
      permissions: role ? this.permissions(role) : undefined,
    };
  }

  private permissions(role: SessionRole): SessionPermissions {
    return {
      canRead: true,
      canSend: true,
      canCancelOwnRun: true,
      canCancelAnyRun: role === "owner",
      canShare: role === "owner",
      canArchive: role === "owner",
      canReadArtifacts: true,
    };
  }

  private role(metadata: SessionMetadata, actor: string): SessionRole | undefined {
    if (metadata.owner === actor) return "owner";
    if (metadata.collaborators.includes(actor)) return "collaborator";
    return undefined;
  }

  private async readMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const path = join(this.sessionDir, sessionId, "session.json");
    if (!(await pathExists(path))) return null;
    const parsed = JSON.parse(await readFile(path, "utf8")) as SessionMetadata;
    parsed.owner = normalizeEmail(parsed.owner);
    parsed.collaborators = validateCollaborators(parsed.collaborators ?? [], parsed.owner);
    return parsed;
  }

  private async writeMetadata(metadata: SessionMetadata): Promise<void> {
    const path = join(this.sessionDir, metadata.sessionId, "session.json");
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private async appendAudit(sessionId: string, event: { type: string; actor: string; target?: string }): Promise<void> {
    await writeFile(join(this.sessionDir, sessionId, "audit.jsonl"), `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "a" });
  }

  private addStructuredAuthors(context: unknown[], runs: RunSummary[]): unknown[] {
    const actors = [...runs]
      .sort((a, b) => (a.requestedAt ?? "").localeCompare(b.requestedAt ?? ""))
      .map((run) => run.actor?.email)
      .filter((email): email is string => Boolean(email));
    let userMessageIndex = 0;
    return context.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const record = entry as Record<string, unknown>;
      const message = record.message;
      if (!message || typeof message !== "object" || Array.isArray(message) || (message as Record<string, unknown>).role !== "user") return entry;
      const actorEmail = actors[userMessageIndex++];
      if (!actorEmail) return entry;
      return { ...record, message: { ...(message as Record<string, unknown>), authorId: actorEmail, authorName: actorEmail, actor: { email: actorEmail } } };
    });
  }

  private async safeMtimeIso(filePath: string): Promise<string | undefined> {
    try {
      return (await stat(filePath)).mtime.toISOString();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async scanRuns(): Promise<ScanData> {
    const runFiles = await listFiles(this.runLogDir, ".jsonl");
    const runsBySessionId = new Map<string, RunSummary[]>();
    const runActivityBySessionId = new Map<string, string>();
    const artifactsBySessionId = new Map<string, ArtifactSummary[]>();

    for (const filePath of runFiles) {
      const summary = await parseRunLog(filePath);
      if (!summary.sessionId) continue;
      const runs = runsBySessionId.get(summary.sessionId) ?? [];
      runs.push(summary);
      runsBySessionId.set(summary.sessionId, runs);
      const artifacts = artifactsBySessionId.get(summary.sessionId) ?? [];
      artifacts.push(...summary.artifacts);
      artifactsBySessionId.set(summary.sessionId, artifacts);
      const activityAt = [summary.requestedAt, summary.completedAt, summary.failedAt]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      const previous = runActivityBySessionId.get(summary.sessionId);
      if (activityAt && (!previous || previous < activityAt)) runActivityBySessionId.set(summary.sessionId, activityAt);
    }

    return { runsBySessionId, runActivityBySessionId, artifactsBySessionId };
  }
}
