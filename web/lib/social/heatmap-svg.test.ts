import { describe, expect, it } from "vitest";
import {
  buildActivitySvgUrl,
  renderActivityHeatmapSvg,
  resolveActivityHeatmapSvgTheme,
} from "./heatmap-svg";

const days = [
  {
    date: "2026-03-01",
    activeSeconds: 3600,
    sessions: 2,
    totalTokens: 12000,
    level: 2 as const,
  },
  {
    date: "2026-03-02",
    activeSeconds: 7200,
    sessions: 4,
    totalTokens: 36000,
    level: 4 as const,
  },
];

describe("heatmap svg renderer", () => {
  it("renders a compact svg heatmap", () => {
    const svg = renderActivityHeatmapSvg({
      locale: "en-US",
      title: "AI Coding Activity",
      username: "poco",
      days,
      lessLabel: "Less",
      moreLabel: "More",
    });

    expect(svg).toContain("<svg");
    expect(svg).toContain('role="img"');
    expect(svg).toContain("Mar");
    expect(svg).toContain("Less");
    expect(svg).toContain("More");
    expect(svg).toContain("#10b981");
    expect(svg).toContain("#6ee7b7");
  });

  it("builds a stable share url", () => {
    expect(
      buildActivitySvgUrl({
        baseUrl: "https://token.guji.uno",
        locale: "zh",
        username: "poco",
      }),
    ).toBe("https://token.guji.uno/zh/u/poco/activity.svg");

    expect(
      buildActivitySvgUrl({
        baseUrl: "https://token.guji.uno",
        locale: "zh",
        username: "poco",
        theme: "light",
      }),
    ).toBe("https://token.guji.uno/zh/u/poco/activity.svg?theme=light");
  });

  it("normalizes theme query params", () => {
    expect(resolveActivityHeatmapSvgTheme(undefined)).toBe("dark");
    expect(resolveActivityHeatmapSvgTheme("light")).toBe("light");
    expect(resolveActivityHeatmapSvgTheme("oops")).toBe("dark");
  });
});
