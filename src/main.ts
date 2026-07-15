#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = await startServer(config);
  process.stdout.write(`fabee-session-api listening on http://${config.host}:${config.port}\n`);

  const close = () => {
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
