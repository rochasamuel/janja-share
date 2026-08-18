import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const KEYS = [
  "PORT",
  "SIGNALING_PORT",
  "MAX_MEMBERS",
  "MAX_VIEWERS",
  "TURN_URL",
  "TURN_TLS_URL",
  "TURN_SECRET",
  "TURN_REALM",
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("loadConfig", () => {
  it("defaults maxMembers to 8 and reads it from the environment", () => {
    delete process.env["MAX_MEMBERS"];
    expect(loadConfig().maxMembers).toBe(8);
    process.env["MAX_MEMBERS"] = "4";
    expect(loadConfig().maxMembers).toBe(4);
  });

  it("defaults to 8787", () => {
    expect(loadConfig().port).toBe(8787);
  });

  it("honours SIGNALING_PORT", () => {
    process.env["SIGNALING_PORT"] = "9000";
    expect(loadConfig().port).toBe(9000);
  });

  it("lets a platform-injected PORT win", () => {
    // Railway, Render and Fly assign the port and expect the process to use
    // it; ignoring it fails the health check with no useful error.
    process.env["SIGNALING_PORT"] = "8787";
    process.env["PORT"] = "4321";
    expect(loadConfig().port).toBe(4321);
  });

  it("rejects a port that is not a positive integer", () => {
    process.env["PORT"] = "not-a-port";
    expect(() => loadConfig()).toThrow(/positive integer/);
  });

  it("reads the viewer limit", () => {
    process.env["MAX_VIEWERS"] = "3";
    expect(loadConfig().maxViewers).toBe(3);
  });

  it("refuses a half-configured TURN setup", () => {
    // A TURN url with no secret produces relay candidates the client can
    // never authenticate, and ICE then fails opaquely at call time.
    process.env["TURN_URL"] = "turn:turn.example.com:3478";
    expect(() => loadConfig()).toThrow(/half configured/);

    delete process.env["TURN_URL"];
    process.env["TURN_SECRET"] = "secret";
    expect(() => loadConfig()).toThrow(/half configured/);
  });

  it("accepts a complete TURN setup", () => {
    process.env["TURN_URL"] = "turn:turn.example.com:3478";
    process.env["TURN_SECRET"] = "secret";
    expect(loadConfig().ice.turnUrl).toBe("turn:turn.example.com:3478");
  });

  it("accepts no TURN at all, for LAN and tunnel testing", () => {
    expect(loadConfig().ice.turnUrl).toBeUndefined();
    expect(loadConfig().ice.stunUrl).toContain("stun:");
  });
});
