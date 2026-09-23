import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOptionalSession: vi.fn(),
  countFollowingProfiles: vi.fn(),
  countFollowerProfiles: vi.fn(),
  countPublicProfiles: vi.fn(),
  listFollowingProfiles: vi.fn(),
  listFollowerProfiles: vi.fn(),
  searchPublicProfiles: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: () => null,
}));
vi.mock("@/components/social/social-shell", () => ({
  SocialShell: () => null,
}));
vi.mock("@/components/social/profile-list-item", () => ({
  ProfileListItem: () => null,
}));
vi.mock("@/components/ui/button", () => ({
  Button: () => null,
}));
vi.mock("@/components/ui/card", () => ({
  Card: () => null,
  CardContent: () => null,
}));
vi.mock("@/components/ui/input", () => ({
  Input: () => null,
}));
vi.mock("@/components/ui/pagination", () => ({
  Pagination: () => null,
  PaginationContent: () => null,
  PaginationEllipsis: () => null,
  PaginationItem: () => null,
  PaginationLink: () => null,
  PaginationNext: () => null,
  PaginationPrevious: () => null,
}));
vi.mock("@/lib/session", () => ({
  getOptionalSession: mocks.getOptionalSession,
}));
vi.mock("@/lib/social/queries", () => ({
  countFollowingProfiles: mocks.countFollowingProfiles,
  countFollowerProfiles: mocks.countFollowerProfiles,
  countPublicProfiles: mocks.countPublicProfiles,
  listFollowingProfiles: mocks.listFollowingProfiles,
  listFollowerProfiles: mocks.listFollowerProfiles,
  searchPublicProfiles: mocks.searchPublicProfiles,
}));

import PeoplePage from "@/app/[locale]/people/page";

describe("PeoplePage network pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOptionalSession.mockResolvedValue({
      user: {
        id: "viewer",
        email: "viewer@example.test",
        name: "Viewer",
        image: null,
        username: "viewer",
        usernameAutoAdjusted: false,
      },
    });
    mocks.listFollowingProfiles.mockResolvedValue([]);
    mocks.listFollowerProfiles.mockResolvedValue([]);
    mocks.countPublicProfiles.mockResolvedValue(0);
    mocks.searchPublicProfiles.mockResolvedValue([]);
  });

  it("falls back to the last following page before asking the database", async () => {
    mocks.countFollowingProfiles.mockResolvedValue(12);

    await PeoplePage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({
        tab: "following",
        query: "  editor  ",
        page: "999",
      }),
    });

    expect(mocks.countFollowingProfiles).toHaveBeenCalledWith({
      viewerUserId: "viewer",
      query: "editor",
    });
    expect(mocks.listFollowingProfiles).toHaveBeenCalledWith({
      viewerUserId: "viewer",
      query: "editor",
      offset: 10,
      limit: 10,
    });
    expect(mocks.listFollowerProfiles).not.toHaveBeenCalled();
  });

  it("uses the first follower page when an out-of-range search is empty", async () => {
    mocks.countFollowerProfiles.mockResolvedValue(0);

    await PeoplePage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({
        tab: "followers",
        query: "missing",
        page: "999",
      }),
    });

    expect(mocks.listFollowerProfiles).toHaveBeenCalledWith({
      viewerUserId: "viewer",
      query: "missing",
      offset: 0,
      limit: 10,
    });
    expect(mocks.listFollowingProfiles).not.toHaveBeenCalled();
  });

  it("paginates the public directory for a guest", async () => {
    mocks.getOptionalSession.mockResolvedValue(null);
    mocks.countPublicProfiles.mockResolvedValue(23);
    mocks.searchPublicProfiles.mockResolvedValue([{ id: "public-user" }]);

    await PeoplePage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ query: "  maker  ", page: "2" }),
    });

    expect(mocks.countPublicProfiles).toHaveBeenCalledWith({
      query: "maker",
      viewerUserId: null,
    });
    expect(mocks.searchPublicProfiles).toHaveBeenCalledWith({
      query: "maker",
      viewerUserId: null,
      offset: 10,
      limit: 10,
    });
    expect(mocks.countFollowingProfiles).not.toHaveBeenCalled();
  });

  it("shows the public directory when a guest asks for a network tab", async () => {
    mocks.getOptionalSession.mockResolvedValue(null);
    mocks.countPublicProfiles.mockResolvedValue(1);
    mocks.searchPublicProfiles.mockResolvedValue([{ id: "public-user" }]);

    await PeoplePage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ tab: "following", page: "invalid" }),
    });

    expect(mocks.searchPublicProfiles).toHaveBeenCalledWith({
      query: "",
      viewerUserId: null,
      offset: 0,
      limit: 10,
    });
    expect(mocks.listFollowingProfiles).not.toHaveBeenCalled();
  });

  it("reads only a middle page of a larger follower list", async () => {
    mocks.countFollowerProfiles.mockResolvedValue(71);
    mocks.listFollowerProfiles.mockResolvedValue([{ id: "follower-31" }]);

    await PeoplePage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ tab: "followers", page: "4" }),
    });

    expect(mocks.listFollowerProfiles).toHaveBeenCalledWith({
      viewerUserId: "viewer",
      query: "",
      offset: 30,
      limit: 10,
    });
  });

  it("keeps a single-result following list on its first page", async () => {
    mocks.countFollowingProfiles.mockResolvedValue(1);
    mocks.listFollowingProfiles.mockResolvedValue([{ id: "followed-user" }]);

    await PeoplePage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ tab: "following" }),
    });

    expect(mocks.listFollowingProfiles).toHaveBeenCalledWith({
      viewerUserId: "viewer",
      query: "",
      offset: 0,
      limit: 10,
    });
  });
});
