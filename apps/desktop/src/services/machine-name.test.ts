import { describe, expect, it } from "vitest";
import { resolveMachineName } from "./machine-name.js";

describe("resolveMachineName", () => {
  it("uses what the platform reports", async () => {
    expect(await resolveMachineName(async () => "DESKTOP-4KJ2P1")).toBe("DESKTOP-4KJ2P1");
  });

  it("cleans a name the platform reports with padding", async () => {
    expect(await resolveMachineName(async () => "  PC-DA-SALA \n")).toBe("PC-DA-SALA");
  });

  it("falls back when the platform has no name", async () => {
    expect(await resolveMachineName(async () => "")).toBe("PC");
  });

  it("falls back when there is no platform at all", async () => {
    expect(
      await resolveMachineName(async () => {
        throw new Error("not running inside Tauri");
      }),
    ).toBe("PC");
  });
});
