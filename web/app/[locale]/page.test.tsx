import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardEntry } from "@/lib/leaderboard/types";

const mocks = vi.hoisted(() => ({
  getOptionalSession: vi.fn(),
  getUsagePreference: vi.fn(),
  getLeaderboardPageData: vi.fn(),
  getLandingStats: vi.fn(),
  getRequestOrigin: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  container: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

function translator(namespace?: string) {
  return (key: string, values?: Record<string, unknown>) => {
    const path = namespace ? `${namespace}.${key}` : key;
    return values ? `${path}${JSON.stringify(values)}` : path;
  };
}

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async (input: { namespace?: string }) =>
    translator(input?.namespace),
  ),
}));
vi.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => translator(namespace),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));
vi.mock("@/components/app/app-shell", () => ({ AppShell: mocks.container }));
vi.mock("@/lib/session", () => ({
  getOptionalSession: mocks.getOptionalSession,
}));
vi.mock("@/lib/usage/preferences", () => ({
  getUsagePreference: mocks.getUsagePreference,
}));
vi.mock("@/lib/leaderboard/queries", () => ({
  getLeaderboardPageData: mocks.getLeaderboardPageData,
}));
vi.mock("@/lib/landing/stats", () => ({
  getLandingStats: mocks.getLandingStats,
}));
vi.mock("@/lib/request-origin", () => ({
  getRequestOrigin: mocks.getRequestOrigin,
}));
vi.mock("@/lib/site-url", () => ({
  getAppOrigin: () => undefined,
  buildAbsoluteUrl: (path: string) => path,
}));

import LocaleHomePage, { generateMetadata } from "./page";

function entry(rank: number): LeaderboardEntry {
  return {
    rank,
    userId: `user-${rank}`,
    name: `Player ${rank}`,
    username: `player${rank}`,
    image: null,
    bio: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 1_000_000 - rank,
    estimatedCostUsd: 1,
    activeSeconds: 3600,
    sessions: 2,
    followerCount: 0,
    followingCount: 0,
    isSelf: false,
    isFollowing: false,
    followsYou: false,
  } as LeaderboardEntry;
}

function board(period: "week" | "all_time", count: number) {
  return {
    global: {
      scope: "global",
      period,
      generatedAt: null,
      windowStart: null,
      windowEnd: null,
      entries: Array.from({ length: count }, (_, index) => entry(index + 1)),
    },
    following: null,
    viewerGlobalEntry: null,
    viewerPublicProfileEnabled: null,
  };
}

async function renderLanding() {
  return renderToStaticMarkup(
    await LocaleHomePage({ params: Promise.resolve({ locale: "zh" }) }),
  );
}

describe("LocaleHomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOptionalSession.mockResolvedValue(null);
    mocks.getLeaderboardPageData.mockResolvedValue(board("week", 25));
    mocks.getLandingStats.mockResolvedValue({
      developers: 42,
      totalTokens: 3_200_000_000,
      weekTokens: 45_000_000,
      activeSeconds: 7_200_000,
    });
    mocks.getRequestOrigin.mockResolvedValue("https://arena.example.com");
  });

  it("sends signed-in users to their app instead of the landing page", async () => {
    mocks.getOptionalSession.mockResolvedValue({
      user: { id: "viewer", username: "viewer" },
    });
    mocks.getUsagePreference.mockResolvedValue({ locale: "en" });

    await expect(renderLanding()).rejects.toThrow("redirect:/en");
    expect(mocks.getLeaderboardPageData).not.toHaveBeenCalled();
  });

  it("explains the product and previews the top ten of this week", async () => {
    const markup = await renderLanding();

    expect(markup).toContain("<h1");
    expect(markup).toContain("landing.hero.title");
    expect(markup).toContain("landing.leaderboard.weekTitle");
    expect(markup).toContain("Player 10");
    expect(markup).not.toContain("Player 11");
    expect(markup).toContain('href="/leaderboard"');
    expect(markup).toContain('href="/u/player1"');
    expect(mocks.getLeaderboardPageData).toHaveBeenCalledTimes(1);
    expect(mocks.getLeaderboardPageData).toHaveBeenCalledWith(
      expect.objectContaining({ period: "week", viewerUserId: null }),
    );
  });

  it("shows site totals and the setup commands for this instance", async () => {
    const markup = await renderLanding();

    expect(markup).toContain("3.2B");
    expect(markup).toContain("45M");
    expect(markup).toContain("2,000");
    expect(markup).toContain("npm install -g @yishiguji/tokenarena@latest");
    expect(markup).toContain(
      "tokenarena init --api-url https://arena.example.com",
    );
    expect(markup).toContain("Claude Code");
  });

  it("falls back to the all-time board while the week is empty", async () => {
    mocks.getLeaderboardPageData
      .mockResolvedValueOnce(board("week", 0))
      .mockResolvedValueOnce(board("all_time", 3));

    const markup = await renderLanding();

    expect(mocks.getLeaderboardPageData).toHaveBeenLastCalledWith(
      expect.objectContaining({ period: "all_time" }),
    );
    expect(markup).toContain("landing.leaderboard.allTimeTitle");
    expect(markup).toContain("Player 3");
  });

  it("still renders when the board and the totals cannot be loaded", async () => {
    mocks.getLeaderboardPageData.mockRejectedValue(new Error("db down"));
    mocks.getLandingStats.mockRejectedValue(new Error("db down"));

    const markup = await renderLanding();

    expect(markup).toContain("landing.hero.title");
    expect(markup).not.toContain("landing.leaderboard.weekTitle");
    expect(markup).not.toContain("landing.stats.developers");
    expect(markup).toContain("landing.privacy.title");
  });

  it("hides the totals on an instance nobody has synced to yet", async () => {
    mocks.getLandingStats.mockResolvedValue({
      developers: 0,
      totalTokens: 0,
      weekTokens: 0,
      activeSeconds: 0,
    });

    const markup = await renderLanding();

    expect(markup).not.toContain("landing.stats.developers");
  });

  it("describes the landing page in its metadata", async () => {
    await expect(
      generateMetadata({ params: Promise.resolve({ locale: "en" }) }),
    ).resolves.toMatchObject({
      title: "landing.metaTitle",
      description: "landing.metaDescription",
    });
  });
});
