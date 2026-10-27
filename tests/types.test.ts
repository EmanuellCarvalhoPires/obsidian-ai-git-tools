import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/types";

describe("normalizeSettings eventTypes", () => {
  it("uses default eventTypes when undefined", () => {
    const s = normalizeSettings(undefined);
    expect(s.eventTypes).toEqual(["pr", "deploy", "branch"]);
  });

  it("filters invalid values, removes duplicates, and preserves DEV_EVENT_TYPES order", () => {
    const s = normalizeSettings({ eventTypes: ["push", "commit", "commit", "xyz"] });
    expect(s.eventTypes).toEqual(["commit", "push"]);
  });

  it("allows empty array", () => {
    const s = normalizeSettings({ eventTypes: [] });
    expect(s.eventTypes).toEqual([]);
  });

  it("falls back to default if eventTypes is a string", () => {
    const s = normalizeSettings({ eventTypes: "pr" });
    expect(s.eventTypes).toEqual(["pr", "deploy", "branch"]);
  });

  it("creates distinct arrays and preserves DEFAULT_SETTINGS", () => {
    const s1 = normalizeSettings(undefined);
    const s2 = normalizeSettings(undefined);
    expect(s1.eventTypes).not.toBe(s2.eventTypes);
    expect(s1.eventTypes).not.toBe(DEFAULT_SETTINGS.eventTypes);

    s1.eventTypes.push("commit");
    expect(DEFAULT_SETTINGS.eventTypes).toEqual(["pr", "deploy", "branch"]);
  });
});
