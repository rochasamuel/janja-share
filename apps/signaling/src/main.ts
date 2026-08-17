import { loadConfig } from "./config.js";
import { consoleLogger } from "./logger.js";
import { createSignalingServer } from "./server.js";

const config = loadConfig();

const server = await createSignalingServer({
  port: config.port,
  host: config.host,
  maxViewers: config.maxViewers,
  ice: config.ice,
  logger: consoleLogger,
});

consoleLogger.info("APP", "ready", {
  ws: `ws://${config.host}:${server.port}`,
  turn: config.ice.turnUrl ? "configured" : "not configured (LAN / STUN only)",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    consoleLogger.info("APP", "shutting down", { signal });
    void server.close().then(() => process.exit(0));
  });
}
