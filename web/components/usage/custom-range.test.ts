import { describe, expect, it } from "vitest";

import { isCustomRangeValid, toCustomRangeInputValue } from "./custom-range";

describe("toCustomRangeInputValue", () => {
  it("rounds an exclusive end back up to the minute the user picked", () => {
    expect(
      toCustomRangeInputValue(
        "2026-03-27T15:59:59.999Z",
        "Asia/Shanghai",
        "end",
      ),
    ).toBe("2026-03-28T00:00");
  });

  it("leaves a minute-aligned end alone", () => {
    expect(
      toCustomRangeInputValue(
        "2026-03-26T10:00:00.000Z",
        "Asia/Shanghai",
        "end",
      ),
    ).toBe("2026-03-26T18:00");
  });

  it("truncates a start to the minute", () => {
    expect(
      toCustomRangeInputValue(
        "2026-03-25T16:00:00.000Z",
        "Asia/Shanghai",
        "start",
      ),
    ).toBe("2026-03-26T00:00");
    expect(
      toCustomRangeInputValue(
        "2026-03-26T02:00:30.000Z",
        "Asia/Shanghai",
        "start",
      ),
    ).toBe("2026-03-26T10:00");
  });
});

describe("isCustomRangeValid", () => {
  it("requires both edges", () => {
    expect(isCustomRangeValid("", "2026-03-26T18:00")).toBe(false);
    expect(isCustomRangeValid("2026-03-26T10:00", "")).toBe(false);
  });

  it("requires the start to come before the end", () => {
    expect(isCustomRangeValid("2026-03-26T10:00", "2026-03-26T10:00")).toBe(
      false,
    );
    expect(isCustomRangeValid("2026-03-26T18:00", "2026-03-26T10:00")).toBe(
      false,
    );
    expect(isCustomRangeValid("2026-03-26T10:00", "2026-03-26T18:00")).toBe(
      true,
    );
    expect(isCustomRangeValid("2026-03-26T23:00", "2026-03-27T01:00")).toBe(
      true,
    );
  });
});
