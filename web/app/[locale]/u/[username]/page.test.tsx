import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicProfilePageData } from "@/lib/social/queries";

const mocks = vi.hoisted(() => ({
  getOptionalSession: vi.fn(),
  getPublicProfilePageData: vi.fn(),
  container: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  ProfileArenaLevelBar: vi.fn(({ score }: { score: number }) =>
    React.createElement("div", {
      "data-slot": "profile-arena-level",
      "data-score": score,
    }),
  ),
}));

vi.mock("lucide-react", () => ({ Users: () => null }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock("@/i18n/navigation", () => ({ Link: mocks.container }));
vi.mock("@/components/social/social-shell", () => ({
  SocialShell: mocks.container,
}));
vi.mock("@/components/social/profile-arena-level", () => ({
  ProfileArenaLevelBar: mocks.ProfileArenaLevelBar,
}));
vi.mock("@/components/social/profile-achievement-wall", () => ({
  ProfileAchievementWall: () => null,
}));
vi.mock("@/components/social/profile-follow-action", () => ({
  ProfileFollowAction: () => null,
}));
vi.mock("@/components/social/profile-heatmap", () => ({
  ProfileHeatmap: () => null,
}));
vi.mock("@/components/social/profile-heatmap-markdown-button", () => ({
  ProfileHeatmapMarkdownButton: () => null,
}));
vi.mock("@/components/social/profile-linked-identity", () => ({
  ProfileLinkedIdentityLink: () => null,
}));
vi.mock("@/components/social/profile-range-filter", () => ({
  ProfileRangeFilter: () => null,
}));
vi.mock("@/components/social/profile-top-list", () => ({
  ProfileTopList: () => null,
}));
vi.mock("@/components/social/profile-wechat-share-button", () => ({
  ProfileWechatShareButton: () => null,
}));
vi.mock("@/components/ui/badge", () => ({ Badge: mocks.container }));
vi.mock("@/components/ui/button", () => ({ Button: mocks.container }));
vi.mock("@/components/ui/card", () => ({
  Card: mocks.container,
  CardContent: mocks.container,
  CardHeader: mocks.container,
  CardTitle: mocks.container,
}));
vi.mock("@/lib/session", () => ({
  getOptionalSession: mocks.getOptionalSession,
}));
vi.mock("@/lib/site-url", () => ({
  buildAbsoluteUrl: () => null,
  getAppOrigin: () => null,
}));
vi.mock("@/lib/social/heatmap-svg", () => ({
  buildActivitySvgUrl: () => null,
}));
vi.mock("@/lib/social/profile-range", () => ({
  parseProfileRangeQuery: () => ({ preset: "all" }),
}));
vi.mock("@/lib/social/queries", () => ({
  getPublicProfileMetadata: vi.fn(),
  getPublicProfilePageData: mocks.getPublicProfilePageData,
}));
vi.mock("@/lib/usage/format", () => ({
  formatTokenCount: (value: number) => `${value} tokens`,
  formatUsdAmount: (value: number) => `${value} USD`,
  formatDuration: (value: number) => `${value} seconds`,
}));
vi.mock("@/lib/wechat/share-server", () => ({
  isWechatShareConfigured: () => false,
}));

import PublicProfilePage from "./page";

function profile(arenaScore: number | null): PublicProfilePageData {
  return {
    id: "user-1",
    name: "Active User",
    username: "active_user",
    image: null,
    bio: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    publicProfileEnabled: true,
    timezone: "Asia/Shanghai",
    followerCount: 0,
    followingCount: 0,
    isFollowing: false,
    followTag: null,
    followsYou: false,
    isSelf: false,
    range: {
      preset: "all",
      from: null,
      to: null,
      timezone: "Asia/Shanghai",
    },
    overview: {
      arenaScore,
      arenaLevel: arenaScore === null ? null : 1,
      activeDays: null,
      totalTokens: 123,
      estimatedCostUsd: 12.5,
      activeSeconds: 3600,
      sessions: 7,
    },
    heatmap: [],
    topTools: [],
    topModels: [],
    achievementWall: [],
    linkedIdentity: null,
  };
}

async function renderProfile() {
  return renderToStaticMarkup(
    await PublicProfilePage({
      params: Promise.resolve({ locale: "en", username: "active_user" }),
    }),
  );
}

describe("PublicProfilePage achievement fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOptionalSession.mockResolvedValue(null);
  });

  it("keeps usage visible without a level bar when the arena score is unavailable", async () => {
    mocks.getPublicProfilePageData.mockResolvedValue(profile(null));

    const markup = await renderProfile();

    expect(markup).toContain("123 tokens");
    expect(markup).toContain("12.5 USD");
    expect(markup).toContain("3600 seconds");
    expect(markup).toContain(">7<");
    expect(markup).not.toContain('data-slot="profile-arena-level"');
    expect(mocks.ProfileArenaLevelBar).not.toHaveBeenCalled();
  });

  it("renders the level bar for a valid zero score", async () => {
    mocks.getPublicProfilePageData.mockResolvedValue(profile(0));

    const markup = await renderProfile();

    expect(markup).toContain('data-slot="profile-arena-level"');
    expect(markup).toContain('data-score="0"');
    expect(mocks.ProfileArenaLevelBar).toHaveBeenCalledWith(
      expect.objectContaining({ score: 0 }),
      undefined,
    );
  });
});
