import { readFileSync } from "node:fs";
import { ReadApiConfig } from "./types.js";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function intEnv(name: string, fallback: string): number {
  const raw = env(name, fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid integer value for ${name}: ${raw}`);
  }
  return value;
}

function packageVersion(): string {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return process.env.READ_API_VERSION ?? "0.0.0";
  }
}

export function loadConfig(): ReadApiConfig {
  return {
    host: env("READ_API_HOST", "0.0.0.0"),
    port: intEnv("READ_API_PORT", "8080"),
    bearerToken: env("READ_API_BEARER_TOKEN"),
    runLogDir: env("READ_API_RUN_LOG_DIR", "/workspace/.fabee-pi-agent/logs"),
    sessionDir: env("READ_API_SESSION_DIR", "/workspace/.fabee-pi-agent/sessions"),
    artifactDir: env("READ_API_ARTIFACT_DIR", "/workspace/.bee-blob-store"),
    apiVersion: process.env.READ_API_VERSION ?? packageVersion(),
  };
}
