import { describe, expect, it } from "vitest";
import {
  addTimelineValue,
  finalizeDistinctTimeline,
  finalizeTimeline,
  recordDistinctTimelineKey,
} from "./timeline";

describe("achievement timeline helpers", () => {
  it("merges values at the same timestamp and sorts the result", () => {
    const values = new Map<string, number>();
    addTimelineValue(values, "2026-04-02T00:00:00.000Z", 3);
    addTimelineValue(values, "2026-04-01T00:00:00.000Z", 2);
    addTimelineValue(values, "2026-04-02T00:00:00.000Z", 4);

    expect(finalizeTimeline(values)).toEqual([
      { at: "2026-04-01T00:00:00.000Z", value: 2 },
      { at: "2026-04-02T00:00:00.000Z", value: 7 },
    ]);
  });

  it("keeps each distinct key's earliest timestamp and sorts by first use", () => {
    const firstTimestampByKey = new Map<string, string>();
    recordDistinctTimelineKey(
      firstTimestampByKey,
      "codex",
      "2026-04-03T00:00:00.000Z",
    );
    recordDistinctTimelineKey(
      firstTimestampByKey,
      "claude",
      "2026-04-02T00:00:00.000Z",
    );
    recordDistinctTimelineKey(
      firstTimestampByKey,
      "codex",
      "2026-04-01T00:00:00.000Z",
    );

    expect(finalizeDistinctTimeline(firstTimestampByKey)).toEqual([
      { at: "2026-04-01T00:00:00.000Z", key: "codex" },
      { at: "2026-04-02T00:00:00.000Z", key: "claude" },
    ]);
  });
});
