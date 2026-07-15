import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "./server.js";
import { parseRunLog } from "./parser.js";
import { ReadApiConfig } from "./types.js";

function config(root: string): ReadApiConfig {
  return {
    host: "127.0.0.1",
    port: 8080,
    bearerToken: "secret-token",
    runLogDir: join(root, "logs"),
    sessionDir: join(root, "sessions"),
    artifactDir: join(root, "artifacts"),
    apiVersion: "0.1.0-test",
  };
}

async function setupWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fabee-log-read-api-"));
  await mkdir(join(root, "logs"), { recursive: true });
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "artifacts"), { recursive: true });

  const webSession = "fabee-pi-agent:web:user-1:session-a";
  const otherUserSession = "fabee-pi-agent:web:user-2:session-b";
  const slackSession = "fabee-pi-agent:slack:user-1:session-c";

  await mkdir(join(root, "sessions", webSession), { recursive: true });
  await mkdir(join(root, "sessions", otherUserSession), { recursive: true });
  await mkdir(join(root, "sessions", slackSession), { recursive: true });

  await writeFile(join(root, "sessions", webSession, "context.jsonl"), `${JSON.stringify({ type: "message", role: "user" })}\n`, "utf8");
  await writeFile(join(root, "sessions", webSession, "last_prompt.json"), JSON.stringify({ prompt: "hello" }), "utf8");
  await writeFile(join(root, "sessions", otherUserSession, "context.jsonl"), `${JSON.stringify({ type: "message", role: "user" })}\n`, "utf8");
  await writeFile(join(root, "sessions", slackSession, "context.jsonl"), `${JSON.stringify({ type: "message", role: "user" })}\n`, "utf8");

  const runFile = join(root, "logs", "run-1.jsonl");
  await writeFile(
    runFile,
    [
      JSON.stringify({ type: "run.requested", runId: "run-1", sessionId: webSession, timestamp: "2026-07-05T10:00:00.000Z" }),
      JSON.stringify({ type: "run.completed", runId: "run-1", sessionId: webSession, timestamp: "2026-07-05T10:01:00.000Z", usage: { contextTokens: 25481, contextWindow: 372000 }, model: { provider: "openai-codex", id: "gpt-5.6-sol" }, thinkingLevel: "medium" }),
      "",
    ].join("\n"),
    "utf8",
  );
  await utimes(runFile, new Date("2026-07-05T10:01:00.000Z"), new Date("2026-07-05T10:01:00.000Z"));

  const otherRunFile = join(root, "logs", "run-2.jsonl");
  await writeFile(
    otherRunFile,
    [
      JSON.stringify({ type: "run.requested", runId: "run-2", sessionId: otherUserSession, timestamp: "2026-07-05T11:00:00.000Z" }),
      JSON.stringify({ type: "run.completed", runId: "run-2", sessionId: otherUserSession, timestamp: "2026-07-05T11:01:00.000Z" }),
      "",
    ].join("\n"),
    "utf8",
  );

  return root;
}

async function requestJson(app: ReturnType<typeof createApp>, path: string, token?: string, method = "GET", body?: unknown): Promise<{ statusCode: number; body: any; headers: Record<string, string> }> {
  let payload = "";
  let statusCode = 0;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (body) headers["content-type"] = "application/json";
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(chunk?: string) {
      if (typeof chunk === "string") payload += chunk;
      statusCode = this.statusCode;
    },
  } as any;

  await app(
    {
      method,
      url: path,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body) yield JSON.stringify(body);
      },
    } as any,
    response,
  );

  let parsed: any;
  try {
    parsed = payload ? JSON.parse(payload) : undefined;
  } catch {
    parsed = undefined;
  }
  return { statusCode, body: parsed, headers: response.headers };
}

test("health is public and auth protects session endpoints", async () => {
  const root = await setupWorkspace();
  const app = createApp(config(root));

  const health = await requestJson(app, "/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.ok, true);

  const unauthorized = await requestJson(app, "/sessions?agentId=fabee-pi-agent&userKey=user-1");
  assert.equal(unauthorized.statusCode, 401);
});

test("session listing filters by web agent/user prefix and returns runs", async () => {
  const root = await setupWorkspace();
  const app = createApp(config(root));

  const response = await requestJson(app, "/sessions?agentId=fabee-pi-agent&userKey=user-1&limit=50", "secret-token");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.sessions.length, 1);
  assert.equal(response.body.sessions[0].sessionId, "fabee-pi-agent:web:user-1:session-a");
  assert.equal(response.body.sessions[0].runCount, 1);

  const detail = await requestJson(app, "/sessions/fabee-pi-agent%3Aweb%3Auser-1%3Asession-a?userKey=user-1", "secret-token");
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.session.context.length, 1);
  assert.deepEqual(detail.body.session.latestRun.usage, { contextTokens: 25481, contextWindow: 372000 });
  assert.deepEqual(detail.body.session.latestRun.model, { provider: "openai-codex", id: "gpt-5.6-sol" });
  assert.equal(detail.body.session.latestRun.thinkingLevel, "medium");

  const runs = await requestJson(app, "/sessions/fabee-pi-agent%3Aweb%3Auser-1%3Asession-a/runs?userKey=user-1", "secret-token");
  assert.equal(runs.statusCode, 200);
  assert.equal(runs.body.runs.length, 1);
  assert.equal(runs.body.runs[0].runId, "run-1");
});

test("shared session metadata supports owned/shared lists, ACLs, audit, and archive", async () => {
  const root = await setupWorkspace();
  const app = createApp(config(root));

  const created = await requestJson(app, "/sessions", "secret-token", "POST", { owner: "Alice@JobMatch.Me" });
  assert.equal(created.statusCode, 201);
  const sessionId = created.body.session.sessionId;
  assert.match(sessionId, /^ses_/);
  assert.equal(created.body.session.owner, "alice@jobmatch.me");
  assert.equal(created.body.session.permissions.canShare, true);

  const shared = await requestJson(app, `/sessions/${sessionId}/collaborators`, "secret-token", "PUT", {
    actorEmail: "alice@jobmatch.me",
    collaborators: ["bob@jobmatch.me"],
  });
  assert.equal(shared.statusCode, 200);

  const bobLists = await requestJson(app, "/sessions?actorEmail=bob@jobmatch.me", "secret-token");
  assert.equal(bobLists.statusCode, 200);
  assert.equal(bobLists.body.owned.length, 0);
  assert.equal(bobLists.body.shared.length, 1);
  assert.equal(bobLists.body.shared[0].role, "collaborator");
  assert.equal(bobLists.body.shared[0].permissions.canShare, false);

  const denied = await requestJson(app, `/sessions/${sessionId}?actorEmail=mallory@jobmatch.me`, "secret-token");
  assert.equal(denied.statusCode, 404);

  const removed = await requestJson(app, `/sessions/${sessionId}/collaborators`, "secret-token", "PUT", {
    actorEmail: "alice@jobmatch.me",
    collaborators: [],
  });
  assert.equal(removed.statusCode, 200);
  const bobAfterRemove = await requestJson(app, `/sessions/${sessionId}?actorEmail=bob@jobmatch.me`, "secret-token");
  assert.equal(bobAfterRemove.statusCode, 404);

  const archived = await requestJson(app, `/sessions/${sessionId}/archive`, "secret-token", "POST", { actorEmail: "alice@jobmatch.me" });
  assert.equal(archived.statusCode, 200);
  const ownerLists = await requestJson(app, "/sessions?actorEmail=alice@jobmatch.me", "secret-token");
  assert.equal(ownerLists.body.owned.length, 0);

  const audit = await readFile(join(root, "sessions", sessionId, "audit.jsonl"), "utf8");
  assert.match(audit, /collaborator_added/);
  assert.match(audit, /collaborator_removed/);
  assert.match(audit, /archived/);
});

test("artifact metadata is listed and downloads are path-safe", async () => {
  const root = await setupWorkspace();
  const app = createApp(config(root));
  const sessionId = "ses_artifact";
  await mkdir(join(root, "sessions", sessionId), { recursive: true });
  await writeFile(join(root, "sessions", sessionId, "session.json"), JSON.stringify({
    sessionId,
    agentId: "fabee-pi-agent",
    routeId: "fabee",
    transport: "web",
    owner: "alice@jobmatch.me",
    collaborators: ["bob@jobmatch.me"],
    createdAt: "2026-07-05T10:00:00.000Z",
    archivedAt: null,
  }), "utf8");
  await mkdir(join(root, "artifacts", sessionId, "run-a"), { recursive: true });
  await writeFile(join(root, "artifacts", sessionId, "run-a", "report.txt"), "ok", "utf8");
  await writeFile(join(root, "logs", "run-a.jsonl"), [
    JSON.stringify({ type: "run.requested", runId: "run-a", sessionId, actor: { email: "alice@jobmatch.me" }, prompt: "hello", timestamp: "2026-07-05T10:00:00.000Z" }),
    JSON.stringify({ type: "artifact.created", runId: "run-a", sessionId, artifactId: "art-1", blobKey: `${sessionId}/run-a/report.txt`, name: "report.txt", mimeType: "text/plain", sizeBytes: 2 }),
    JSON.stringify({ type: "artifact.created", runId: "run-a", sessionId, artifactId: "bad", blobKey: "../secret.txt", name: "bad.txt" }),
    "",
  ].join("\n"), "utf8");

  const detail = await requestJson(app, `/sessions/${sessionId}?actorEmail=bob@jobmatch.me`, "secret-token");
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.session.runs[0].actor.email, "alice@jobmatch.me");
  assert.equal(detail.body.session.runs[0].prompt, "hello");
  assert.equal(detail.body.session.artifacts.length, 2);
  assert.equal(detail.body.session.artifacts[0].sizeBytes, 2);

  const artifact = await requestJson(app, `/sessions/${sessionId}/artifacts/art-1?actorEmail=bob@jobmatch.me`, "secret-token");
  assert.equal(artifact.statusCode, 200);
  assert.equal(artifact.body, undefined);

  const traversal = await requestJson(app, `/sessions/${sessionId}/artifacts/bad?actorEmail=bob@jobmatch.me`, "secret-token");
  assert.equal(traversal.statusCode, 404);
});

test("parseRunLog tolerates malformed lines and keeps sessionId", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabee-log-read-api-parse-"));
  const filePath = join(root, "run-bad.jsonl");
  await writeFile(
    filePath,
    [
      JSON.stringify({ type: "run.requested", sessionId: "fabee-pi-agent:web:user-1:session-a", timestamp: 1770000000000 }),
      "{bad json",
      JSON.stringify({ type: "run.failed", timestamp: "2026-07-05T10:02:00.000Z" }),
      "",
    ].join("\n"),
    "utf8",
  );

  const summary = await parseRunLog(filePath);
  assert.equal(summary.sessionId, "fabee-pi-agent:web:user-1:session-a");
  assert.equal(summary.status, "failed");
  assert.equal(summary.parseWarnings.length, 1);
});
