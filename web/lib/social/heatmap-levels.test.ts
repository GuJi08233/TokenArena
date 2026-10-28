import { describe, expect, it } from "vitest";
import {
  getHeatmapLevel,
  getHeatmapLevelLabel,
  getHeatmapLevelThresholds,
} from "./heatmap-levels";

const MINIMUMS = [100_000, 1_000_000, 10_000_000, 50_000_000];

function levelsOf(dailyTokens: number[]) {
  const thresholds = getHeatmapLevelThresholds(dailyTokens);
  return dailyTokens.map((tokens) => getHeatmapLevel(tokens, thresholds));
}

describe("getHeatmapLevelThresholds", () => {
  it("falls back to the absolute minimums without any counted day", () => {
    expect(getHeatmapLevelThresholds([])).toEqual(MINIMUMS);
    // 只有零星调用的人不应因此抬出一个相对峰值。
    expect(getHeatmapLevelThresholds([0, 2_000, 99_999])).toEqual(MINIMUMS);
  });

  it("spaces heavy users' levels by powers of the peak", () => {
    const thresholds = getHeatmapLevelThresholds([
      0, 5_000, 1_000_000_000, 300_000_000, 20_000_000,
    ]);

    expect(thresholds[0]).toBe(100_000);
    expect(thresholds[1]).toBeCloseTo(1e9 * 10 ** -1.5);
    expect(thresholds[2]).toBeCloseTo(1e8);
    expect(thresholds[3]).toBeCloseTo(1e9 * 10 ** -0.5);
  });

  it("keeps the absolute minimums for light users", () => {
    expect(getHeatmapLevelThresholds([150_000, 2_000_000])).toEqual(MINIMUMS);
  });

  it("ignores a day far above the 95th percentile when picking the peak", () => {
    const steady = Array.from({ length: 40 }, () => 1_000_000_000);
    const thresholds = getHeatmapLevelThresholds([...steady, 50_000_000_000]);

    expect(thresholds[3]).toBeCloseTo(1e9 * 10 ** -0.5);
  });

  it("does not treat the peak of a short history as an outlier", () => {
    // 不足 20 个有效日时 p95 就是最大值，最大值不可能超过它的 4 倍。
    const thresholds = getHeatmapLevelThresholds([200_000, 2_000_000_000]);

    expect(thresholds[3]).toBeCloseTo(2e9 * 10 ** -0.5);
  });

  it("returns strictly increasing thresholds", () => {
    for (const peak of [0, 150_000, 3_000_000, 80_000_000, 5e9]) {
      const thresholds = getHeatmapLevelThresholds([peak]);
      for (let index = 1; index < thresholds.length; index += 1) {
        expect(thresholds[index]).toBeGreaterThan(thresholds[index - 1]);
      }
    }
  });
});

describe("getHeatmapLevel", () => {
  it("leaves trace usage uncoloured", () => {
    expect(levelsOf([0, 3_000, 99_999, 100_000])).toEqual([0, 0, 0, 1]);
  });

  it("separates a busy day from a peak day", () => {
    const days = [5_000, 2_000_000, 60_000_000, 300_000_000, 1_200_000_000];

    expect(levelsOf([...days, 1_700_000_000])).toEqual([0, 1, 2, 3, 4, 4]);
  });

  it("includes a day that sits exactly on a threshold", () => {
    const thresholds = getHeatmapLevelThresholds([]);

    expect(getHeatmapLevel(50_000_000, thresholds)).toBe(4);
    expect(getHeatmapLevel(49_999_999, thresholds)).toBe(3);
  });

  it("does not show a light user's best day at the deepest level", () => {
    expect(levelsOf([120_000, 800_000, 2_500_000])).toEqual([1, 1, 2]);
  });

  it("shows every day of a steady heavy user at the deepest level", () => {
    const steady = Array.from(
      { length: 30 },
      (_, index) => 1.6e9 + index * 1e7,
    );

    expect(new Set(levelsOf([...steady, 57e9]))).toEqual(new Set([4]));
  });

  it("gives days with equal token counts the same level", () => {
    const levels = levelsOf([40_000_000, 40_000_000, 40_000_000, 900_000_000]);

    expect(levels.slice(0, 3)).toEqual([levels[0], levels[0], levels[0]]);
  });
});

describe("getHeatmapLevelLabel", () => {
  it("states each level's token range", () => {
    const thresholds = getHeatmapLevelThresholds([1_700_000_000]);

    expect(getHeatmapLevelLabel(0, thresholds)).toBe("< 100K tokens");
    expect(getHeatmapLevelLabel(1, thresholds)).toBe("≥ 100K tokens");
    expect(getHeatmapLevelLabel(4, thresholds)).toBe("≥ 537.6M tokens");
  });
});
