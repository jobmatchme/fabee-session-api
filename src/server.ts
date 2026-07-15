import { readFile } from "node:fs/promises";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { URL } from "node:url";
import { LogReadRepository } from "./repository.js";
import { isBearerTokenAuthorized, normalizeEmail, validateAgentId, validateArtifactId, validateLimit, validateSessionId, validateUserKey } from "./security.js";
import { ReadApiConfig } from "./types.js";

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function routeUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}

async function readJson(request: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function actorFrom(url: URL, body?: any): string {
  return normalizeEmail(url.searchParams.get("actorEmail") ?? body?.actorEmail ?? body?.owner);
}

export function createApp(config: ReadApiConfig, repository = new LogReadRepository(config.sessionDir, config.runLogDir, config.artifactDir)) {
  return async function app(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = routeUrl(request);
      const path = url.pathname;
      const method = request.method ?? "GET";

      if (path === "/health" && method === "GET") {
        sendJson(response, 200, { ok: true, version: config.apiVersion });
        return;
      }

      if (!isBearerTokenAuthorized(request.headers.authorization, config.bearerToken)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (path === "/sessions" && method === "POST") {
        const body = await readJson(request);
        const session = await repository.createSession(actorFrom(url, body));
        sendJson(response, 201, { session });
        return;
      }

      if (path === "/sessions" && method === "GET") {
        const limit = validateLimit(url.searchParams.get("limit"));
        const actorEmail = url.searchParams.get("actorEmail");
        if (actorEmail) {
          sendJson(response, 200, await repository.listAccessibleSessions(actorEmail, limit));
          return;
        }
        const agentId = validateAgentId(url.searchParams.get("agentId"));
        const userKey = validateUserKey(url.searchParams.get("userKey"));
        const sessions = await repository.listSessions(agentId, userKey, limit);
        sendJson(response, 200, { sessions });
        return;
      }

      const artifactMatch = path.match(/^\/sessions\/([^/]+)\/artifacts\/([^/]+)$/);
      if (artifactMatch && method === "GET") {
        const sessionId = validateSessionId(decodeURIComponent(artifactMatch[1] ?? ""));
        const artifactId = validateArtifactId(decodeURIComponent(artifactMatch[2] ?? ""));
        const result = await repository.getArtifact(sessionId, actorFrom(url), artifactId);
        if (!result) {
          sendJson(response, 404, { error: "Artifact not found" });
          return;
        }
        response.statusCode = 200;
        if (result.artifact.mimeType) response.setHeader("content-type", result.artifact.mimeType);
        if (result.artifact.name) response.setHeader("content-disposition", `attachment; filename="${result.artifact.name.replace(/["\\]/g, "")}"`);
        response.end(await readFile(result.filePath));
        return;
      }

      const capabilitiesMatch = path.match(/^\/sessions\/([^/]+)\/capabilities$/);
      if (capabilitiesMatch && method === "GET") {
        const sessionId = validateSessionId(decodeURIComponent(capabilitiesMatch[1] ?? ""));
        const capabilities = await repository.capabilities(sessionId, actorFrom(url), url.searchParams.get("runActorEmail") ?? undefined);
        if (!capabilities) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        sendJson(response, 200, { sessionId, ...capabilities });
        return;
      }

      const collaboratorsMatch = path.match(/^\/sessions\/([^/]+)\/collaborators$/);
      if (collaboratorsMatch && (method === "PUT" || method === "PATCH")) {
        const sessionId = validateSessionId(decodeURIComponent(collaboratorsMatch[1] ?? ""));
        const body = await readJson(request);
        const actorEmail = actorFrom(url, body);
        const metadata = await repository.updateCollaborators(sessionId, actorEmail, body.collaborators);
        if (!metadata) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        sendJson(response, 200, { session: await repository.getSession(sessionId, actorEmail) });
        return;
      }

      const archiveMatch = path.match(/^\/sessions\/([^/]+)\/archive$/);
      if (archiveMatch && method === "POST") {
        const sessionId = validateSessionId(decodeURIComponent(archiveMatch[1] ?? ""));
        const body = await readJson(request);
        const metadata = await repository.archiveSession(sessionId, actorFrom(url, body));
        if (!metadata) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        sendJson(response, 200, { metadata });
        return;
      }

      const runsMatch = path.match(/^\/sessions\/([^/]+)\/runs$/);
      if (runsMatch && method === "GET") {
        const actorEmail = url.searchParams.get("actorEmail");
        const userKey = url.searchParams.get("userKey");
        const sessionId = validateSessionId(decodeURIComponent(runsMatch[1] ?? ""), userKey ?? undefined);
        if (
          (actorEmail && !(await repository.capabilities(sessionId, actorEmail))) ||
          (!actorEmail && (!userKey || sessionId.startsWith("ses_")))
        ) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        const runs = await repository.getSessionRuns(sessionId);
        if (!runs) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        sendJson(response, 200, { sessionId, runs });
        return;
      }

      const detailMatch = path.match(/^\/sessions\/([^/]+)$/);
      if (detailMatch && method === "GET") {
        const actorEmail = url.searchParams.get("actorEmail");
        const userKey = url.searchParams.get("userKey");
        const sessionId = validateSessionId(decodeURIComponent(detailMatch[1] ?? ""), userKey ?? undefined);
        const session = await repository.getSession(sessionId, actorEmail ?? validateUserKey(userKey));
        if (!session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        sendJson(response, 200, { session });
        return;
      }

      sendJson(response, method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" ? 404 : 405, { error: method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" ? "Not found" : "Method not allowed" });
    } catch (error) {
      sendJson(response, 400, { error: (error as Error).message });
    }
  };
}

export function startServer(config: ReadApiConfig, repository?: LogReadRepository): Promise<Server> {
  const app = createApp(config, repository);
  const server = createServer((request, response) => {
    void app(request, response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve(server));
  });
}
