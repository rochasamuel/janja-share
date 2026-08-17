import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildIceServers } from "./ice-servers.js";

const NOW = 1_700_000_000_000;

describe("buildIceServers", () => {
  it("returns only STUN when no TURN secret is configured", () => {
    const servers = buildIceServers(
      { stunUrl: "stun:stun.example.com:3478", ttlSeconds: 3600 },
      "s1",
      NOW,
    );
    expect(servers).toEqual([{ urls: ["stun:stun.example.com:3478"] }]);
  });

  it("derives a coturn REST credential that expires", () => {
    const servers = buildIceServers(
      {
        stunUrl: "stun:stun.example.com:3478",
        turnUrl: "turn:turn.example.com:3478",
        turnSecret: "s3cr3t",
        ttlSeconds: 3600,
      },
      "session-abc",
      NOW,
    );

    const turn = servers.find((s) => s.username !== undefined);
    expect(turn).toBeDefined();

    const expiry = Math.floor(NOW / 1000) + 3600;
    expect(turn!.username).toBe(`${expiry}:session-abc`);
    expect(turn!.credential).toBe(
      createHmac("sha1", "s3cr3t").update(turn!.username!).digest("base64"),
    );
  });

  it("includes the TLS url in the same credential entry", () => {
    const servers = buildIceServers(
      {
        turnUrl: "turn:turn.example.com:3478",
        turnTlsUrl: "turns:turn.example.com:5349",
        turnSecret: "s3cr3t",
        ttlSeconds: 60,
      },
      "s1",
      NOW,
    );
    const turn = servers.find((s) => s.username !== undefined);
    expect(turn!.urls).toEqual([
      "turn:turn.example.com:3478",
      "turns:turn.example.com:5349",
    ]);
  });

  it("omits TURN entirely when a url is set but the secret is missing", () => {
    const servers = buildIceServers(
      { turnUrl: "turn:turn.example.com:3478", ttlSeconds: 60 },
      "s1",
      NOW,
    );
    expect(servers.every((s) => s.username === undefined)).toBe(true);
  });

  it("omits TURN when a secret is set but no url is", () => {
    const servers = buildIceServers({ turnSecret: "s3cr3t", ttlSeconds: 60 }, "s1", NOW);
    expect(servers).toEqual([]);
  });

  it("gives different sessions different credentials", () => {
    const config = {
      turnUrl: "turn:turn.example.com:3478",
      turnSecret: "s3cr3t",
      ttlSeconds: 60,
    };
    const a = buildIceServers(config, "session-a", NOW)[0]!;
    const b = buildIceServers(config, "session-b", NOW)[0]!;
    expect(a.credential).not.toBe(b.credential);
  });
});
