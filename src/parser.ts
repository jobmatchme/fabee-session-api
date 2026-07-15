import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { ArtifactSummary, RunSummary } from "./types.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function artifactFromEvent(object: JsonObject, runId: string, sessionId?: string): ArtifactSummary | undefined {
  const artifactId = stringValue(object.artifactId);
  const blobKey = stringValue(object.blobKey);
  const resolvedSessionId = stringValue(object.sessionId) ?? sessionId;
  const resolvedRunId = stringValue(object.runId) ?? runId;
  if (!artifactId || !blobKey || !resolvedSessionId) return undefined;
  return {
    artifactId,
    runId: resolvedRunId,
    sessionId: resolvedSessionId,
    blobKey,
    name: stringValue(object.name),
    title: stringValue(object.title),
    mimeType: stringValue(object.mimeType),
    sizeBytes: numberValue(object.sizeBytes),
  };
}

function getPath(obj: JsonObject, path: string[]): unknown {
  let current: unknown = obj;
  for (const segment of path) {
    const currentObject = asObject(current);
    if (!currentObject) return undefined;
    current = currentObject[segment];
  }
  return current;
}

function firstStringPath(obj: JsonObject, paths: string[][]): string | undefined {
  for (const path of paths) {
    const value = stringValue(getPath(obj, path));
    if (value) return value;
  }
  return undefined;
}

export function eventName(obj: JsonObject): string | undefined {
  return firstStringPath(obj, [
    ["event"],
    ["type"],
    ["name"],
    ["eventName"],
    ["kind"],
    ["payload", "event"],
    ["payload", "type"],
    ["data", "event"],
    ["data", "type"],
  ]);
}

export function eventTimestamp(obj: JsonObject): string | undefined {
  return firstStringPath(obj, [
    ["timestamp"],
    ["time"],
    ["ts"],
    ["createdAt"],
    ["payload", "timestamp"],
    ["payload", "time"],
    ["payload", "createdAt"],
    ["data", "timestamp"],
    ["data", "time"],
    ["data", "createdAt"],
  ]);
}

function findStringByKey(obj: unknown, keys: Set<string>, maxDepth = 6): string | undefined {
  if (maxDepth < 0) return undefined;
  const object = asObject(obj);
  if (!object) return undefined;
  for (const [key, value] of Object.entries(object)) {
    if (keys.has(key) && typeof value === "string" && value.length > 0) return value;
  }
  for (const value of Object.values(object)) {
    const found = findStringByKey(value, keys, maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

export function sessionIdFromEvent(obj: JsonObject): string | undefined {
  return firstStringPath(obj, [
    ["sessionId"],
    ["session", "id"],
    ["payload", "sessionId"],
    ["payload", "session", "id"],
    ["data", "sessionId"],
    ["data", "session", "id"],
  ]) ?? findStringByKey(obj, new Set(["sessionId"]));
}

export async function parseRunLog(filePath: string): Promise<RunSummary> {
  const fileStat = await stat(filePath);
  const runId = basename(filePath).replace(/\.jsonl$/i, "");
  const content = await readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const summary: RunSummary = {
    runId,
    filePath,
    fileMtimeIso: fileStat.mtime.toISOString(),
    status: "unknown",
    artifacts: [],
    parseWarnings: [],
  };

  let sawRequested = false;
  let sawCompleted = false;
  let sawFailed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      summary.parseWarnings.push({ line: index + 1, message: `Malformed JSONL line: ${(error as Error).message}` });
      continue;
    }

    const object = asObject(parsed);
    if (!object) {
      summary.parseWarnings.push({ line: index + 1, message: "JSONL line is not an object" });
      continue;
    }

    const name = eventName(object);
    const timestamp = eventTimestamp(object);
    summary.sessionId ??= sessionIdFromEvent(object);

    if (name === "run.requested") {
      sawRequested = true;
      if (timestamp) summary.requestedAt = timestamp;
      const actor = asObject(object.actor);
      if (actor) summary.actor = { email: stringValue(actor.email) };
      summary.prompt = stringValue(object.prompt);
    } else if (name === "run.completed") {
      sawCompleted = true;
      if (timestamp) summary.completedAt = timestamp;
      const usage = asObject(object.usage);
      if (usage) {
        summary.usage = {
          contextTokens: numberValue(usage.contextTokens),
          contextWindow: numberValue(usage.contextWindow),
        };
      }
      const model = asObject(object.model);
      if (model) {
        summary.model = {
          provider: stringValue(model.provider),
          id: stringValue(model.id),
        };
      }
      summary.thinkingLevel = stringValue(object.thinkingLevel);
    } else if (name === "run.failed") {
      sawFailed = true;
      if (timestamp) summary.failedAt = timestamp;
    } else if (name === "artifact.created") {
      const artifact = artifactFromEvent(object, runId, summary.sessionId);
      if (artifact) summary.artifacts.push(artifact);
    }
  }

  if (sawCompleted) {
    summary.status = "completed";
  } else if (sawFailed) {
    summary.status = "failed";
  } else if (sawRequested) {
    summary.status = "incomplete";
  }

  return summary;
}

export async function parseJsonLines(filePath: string): Promise<unknown[]> {
  const content = await readFile(filePath, "utf8");
  const items: unknown[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      items.push({ type: "parse.error", raw: line });
    }
  }
  return items;
}
