import type { OAuth2Tokens } from "better-auth/oauth2";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getEnabledLoginProviders,
  getEnabledOAuth2ProviderConfigs,
  isSocialProviderEnabled,
} from "./auth-providers";

const tokens = { accessToken: "access-token" } as OAuth2Tokens;

const gitlabEnv = {
  GITLAB_BASE_URL: "https://gitlab.example.com/",
  GITLAB_CLIENT_ID: "gitlab-id",
  GITLAB_CLIENT_SECRET: "gitlab-secret",
};

const watchaEnv = {
  WATCHA_CLIENT_ID: "watcha-id",
  WATCHA_CLIENT_SECRET: "watcha-secret",
};

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...values };
}

function getUserInfo(values: Record<string, string>) {
  const [config] = getEnabledOAuth2ProviderConfigs(env(values));
  return config?.getUserInfo?.(tokens);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getEnabledLoginProviders", () => {
  it("lists only providers whose configuration is complete", () => {
    expect(
      getEnabledLoginProviders(
        env({
          GITHUB_CLIENT_ID: "github-id",
          GITHUB_CLIENT_SECRET: "github-secret",
          GOOGLE_CLIENT_ID: "google-id",
          GITLAB_CLIENT_ID: "gitlab-id",
          GITLAB_CLIENT_SECRET: "gitlab-secret",
          ...watchaEnv,
        }),
      ),
    ).toEqual([
      { id: "github", kind: "social", label: "GitHub" },
      { id: "watcha", kind: "oauth2", label: "Watcha" },
    ]);
  });
});

describe("isSocialProviderEnabled", () => {
  it("requires both the client id and the secret", () => {
    expect(
      isSocialProviderEnabled(
        "discord",
        env({ DISCORD_CLIENT_ID: "id", DISCORD_CLIENT_SECRET: "secret" }),
      ),
    ).toBe(true);
    expect(
      isSocialProviderEnabled("discord", env({ DISCORD_CLIENT_ID: "id" })),
    ).toBe(false);
  });
});

describe("getEnabledOAuth2ProviderConfigs", () => {
  it("derives GitLab endpoints from the configured base URL", () => {
    expect(getEnabledOAuth2ProviderConfigs(env(gitlabEnv))).toEqual([
      expect.objectContaining({
        providerId: "gitlab",
        authorizationUrl: "https://gitlab.example.com/oauth/authorize",
        tokenUrl: "https://gitlab.example.com/oauth/token",
        userInfoUrl: "https://gitlab.example.com/api/v4/user",
        clientId: "gitlab-id",
        clientSecret: "gitlab-secret",
        scopes: ["read_user"],
      }),
    ]);
  });

  it("keeps the fixed endpoints of hosted providers", () => {
    expect(
      getEnabledOAuth2ProviderConfigs(
        env({
          LINUXDO_CLIENT_ID: "linuxdo-id",
          LINUXDO_CLIENT_SECRET: "linuxdo-secret",
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        providerId: "linuxdo",
        authorizationUrl: "https://connect.linux.do/oauth2/authorize",
        tokenUrl: "https://connect.linux.do/oauth2/token",
        userInfoUrl: "https://connect.linux.do/api/user",
      }),
    ]);
  });

  it("skips providers without credentials", () => {
    expect(getEnabledOAuth2ProviderConfigs(env({}))).toEqual([]);
  });
});

describe("GitLab user info", () => {
  it("maps the GitLab profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: 42,
        name: "Alice",
        username: "alice",
        avatar_url: "https://gitlab.example.com/alice.png",
        email: "alice@example.com",
        confirmed_at: "2026-01-01T00:00:00Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getUserInfo(gitlabEnv)).resolves.toEqual({
      id: "42",
      name: "Alice",
      image: "https://gitlab.example.com/alice.png",
      email: "alice@example.com",
      emailVerified: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/api/v4/user",
      { headers: { Authorization: "Bearer access-token" } },
    );
  });

  it("falls back to a placeholder email when the profile has none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ id: 42, username: "alice" })),
    );

    await expect(getUserInfo(gitlabEnv)).resolves.toEqual({
      id: "42",
      name: "alice",
      image: undefined,
      email: "alice@gitlab.local",
      emailVerified: false,
    });
  });

  it("returns null when GitLab rejects the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );

    await expect(getUserInfo(gitlabEnv)).resolves.toBeNull();
  });
});

describe("Watcha user info", () => {
  it("maps the Watcha profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        statusCode: 200,
        data: {
          user_id: 7,
          nickname: "Bob",
          avatar_url: "https://watcha.cn/bob.png",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getUserInfo(watchaEnv)).resolves.toEqual({
      id: "7",
      name: "Bob",
      image: "https://watcha.cn/bob.png",
      email: "7@watcha.local",
      emailVerified: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://watcha.cn/oauth/api/userinfo?access_token=access-token",
    );
  });

  it("returns null when Watcha reports an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ statusCode: 401 })),
    );

    await expect(getUserInfo(watchaEnv)).resolves.toBeNull();
  });
});
