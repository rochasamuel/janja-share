import type { IceConfig } from "./ice-servers.js";

export interface AppConfig {
  port: number;
  host: string;
  maxViewers: number;
  ice: IceConfig;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    // Railway, Render, Fly and Heroku all inject PORT and expect the process
    // to obey it. Ignoring it means the platform's health check never passes
    // and the deploy is rolled back with no useful error.
    port: integer("PORT", integer("SIGNALING_PORT", 8787)),
    host: process.env["SIGNALING_HOST"] ?? "0.0.0.0",
    maxViewers: integer("MAX_VIEWERS", 6),
    ice: {
      stunUrl: optional("STUN_URL") ?? "stun:stun.l.google.com:19302",
      turnUrl: optional("TURN_URL"),
      turnTlsUrl: optional("TURN_TLS_URL"),
      turnSecret: optional("TURN_SECRET"),
      ttlSeconds: integer("TURN_TTL_SECONDS", 3600),
    },
  };

  // Half a TURN configuration is worse than none: the client gets relay
  // candidates it can never authenticate against, and ICE fails opaquely.
  const hasTurnUrl = Boolean(config.ice.turnUrl ?? config.ice.turnTlsUrl);
  if (hasTurnUrl !== Boolean(config.ice.turnSecret)) {
    throw new Error(
      "TURN is half configured: set both a TURN url and TURN_SECRET, or neither.",
    );
  }

  return config;
}
