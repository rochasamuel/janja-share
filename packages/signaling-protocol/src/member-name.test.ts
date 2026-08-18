import { describe, expect, it } from "vitest";
import { MAX_NAME_LENGTH, sanitizeName } from "./member-name.js";

describe("sanitizeName", () => {
  it("keeps an ordinary computer name", () => {
    expect(sanitizeName("DESKTOP-4KJ2P1")).toBe("DESKTOP-4KJ2P1");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeName("  NOTEBOOK-ANA  ")).toBe("NOTEBOOK-ANA");
  });

  it("strips control characters, which is what a crafted name would carry", () => {
    expect(sanitizeName("PC\u0000\u001b[31mDA-SALA")).toBe("PC[31mDA-SALA");
  });

  it("truncates to the maximum length", () => {
    const long = "A".repeat(MAX_NAME_LENGTH + 20);
    expect(sanitizeName(long)).toHaveLength(MAX_NAME_LENGTH);
  });

  it("returns null when nothing usable is left", () => {
    expect(sanitizeName("")).toBeNull();
    expect(sanitizeName("   ")).toBeNull();
    expect(sanitizeName("\u0000\u0001")).toBeNull();
  });
});
