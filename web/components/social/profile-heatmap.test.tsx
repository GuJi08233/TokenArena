import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./profile-heatmap.module.css", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, property) => String(property),
    },
  ),
}));

import { ProfileHeatmap } from "./profile-heatmap";

function createDays(from: string, count: number) {
  const start = new Date(`${from}T00:00:00Z`);

  return Array.from({ length: count }, (_, index) => {
    const current = new Date(start.getTime() + index * 24 * 60 * 60 * 1000);

    return {
      date: current.toISOString().slice(0, 10),
      activeSeconds: 0,
      sessions: 0,
      totalTokens: 0,
      level: 0 as const,
    };
  });
}

describe("ProfileHeatmap", () => {
  it("renders a new month label as soon as the month starts mid-week", () => {
    const markup = renderToStaticMarkup(
      <ProfileHeatmap
        locale="en-US"
        days={createDays("2026-03-22", 14)}
        lessLabel="Less"
        moreLabel="More"
      />,
    );

    expect(markup).toContain(">Mar<");
    expect(markup).toContain(">Apr<");
  });

  it("uses brighter dark-mode activity colors and border-based cell outlines", () => {
    const markup = renderToStaticMarkup(
      <ProfileHeatmap
        locale="en-US"
        days={[
          {
            date: "2026-03-27",
            activeSeconds: 3600,
            sessions: 3,
            totalTokens: 12000,
            level: 1,
          },
          {
            date: "2026-03-28",
            activeSeconds: 7200,
            sessions: 5,
            totalTokens: 24000,
            level: 4,
          },
        ]}
        lessLabel="Less"
        moreLabel="More"
      />,
    );

    expect(markup).toContain("dark:bg-foreground/12");
    expect(markup).toContain("dark:bg-emerald-900");
    expect(markup).toContain("dark:bg-emerald-700");
    expect(markup).toContain("dark:bg-emerald-500");
    expect(markup).toContain("dark:bg-emerald-300");
    expect(markup).toContain("ring-border/35");
  });

  it("states each legend level's token threshold", () => {
    const markup = renderToStaticMarkup(
      <ProfileHeatmap
        locale="en-US"
        days={[
          {
            date: "2026-03-28",
            activeSeconds: 7200,
            sessions: 5,
            totalTokens: 1_700_000_000,
            level: 4,
          },
        ]}
        lessLabel="Less"
        moreLabel="More"
      />,
    );

    expect(markup).toContain('title="&lt; 100K tokens"');
    expect(markup).toContain('title="≥ 537.6M tokens"');
  });
});
