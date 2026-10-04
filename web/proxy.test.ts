import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `proxy.ts` is the only thing standing between an unauthenticated request and
 * every protected route, and it lives outside the `app/`, `components/`,
 * `hooks/` and `lib/` trees. It had no test, so a wrong condition here would
 * have shipped silently.
 *
 * next-intl's middleware is replaced with a marker: these cases are about the
 * auth decisions, and the real middleware cannot be imported under Node (it
 * pulls the extensionless `next/server`).
 */
const i18nRouting = vi.hoisted(() => vi.fn(() => ({ marker: "i18n-routing" })));
vi.mock("next-intl/middleware", () => ({
  default: () => i18nRouting,
}));

import { proxy } from "./proxy";

function buildRequest(
  url: string,
  options: { cookie?: string; acceptLanguage?: string } = {},
) {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.acceptLanguage) {
    headers.set("accept-language", options.acceptLanguage);
  }
  return new NextRequest(new Request(url, { headers }));
}

const SESSION_COOKIE = "better-auth.session_token=abc123";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("proxy protected routes", () => {
  it.each([
    "/en/usage",
    "/zh/usage",
    "/en/settings",
    "/zh/settings/cli-keys",
    "/en/following",
    "/zh/followers",
  ])("redirects an unauthenticated request to %s", (path) => {
    const response = proxy(buildRequest(`http://localhost:3000${path}`));

    // A redirect, not the i18n fallthrough: this is the auth boundary.
    expect(i18nRouting).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/en/login");
    expect(location.searchParams.get("invalid")).toBe("1");
  });

  it("sends an authenticated request on a protected path through i18n routing", () => {
    const response = proxy(
      buildRequest("http://localhost:3000/en/usage", {
        cookie: SESSION_COOKIE,
      }),
    );

    expect(response).toEqual({ marker: "i18n-routing" });
    expect(i18nRouting).toHaveBeenCalledTimes(1);
  });

  it("treats an empty session cookie as unauthenticated", () => {
    const response = proxy(
      buildRequest("http://localhost:3000/en/usage", { cookie: "other=1" }),
    );

    expect(i18nRouting).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
  });
});

describe("proxy auth pages", () => {
  it.each([
    "/en/login",
    "/zh/register",
  ])("redirects an authenticated request on %s to the dashboard", (path) => {
    const response = proxy(
      buildRequest(`http://localhost:3000${path}`, {
        cookie: SESSION_COOKIE,
      }),
    );

    expect(i18nRouting).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/en/usage",
    );
  });

  it("does not bounce an authenticated request that was sent here by a failed session check", () => {
    // Without the invalid=1 exemption this pair of rules loops forever.
    const response = proxy(
      buildRequest("http://localhost:3000/en/login?invalid=1", {
        cookie: SESSION_COOKIE,
      }),
    );

    expect(response).toEqual({ marker: "i18n-routing" });
    expect(i18nRouting).toHaveBeenCalledTimes(1);
  });

  it("lets an unauthenticated request reach the login page", () => {
    const response = proxy(buildRequest("http://localhost:3000/en/login"));

    expect(response).toEqual({ marker: "i18n-routing" });
  });
});

describe("proxy public routes", () => {
  it.each([
    "/en/leaderboard",
    "/zh/people",
    "/en",
    "/zh/u/someone",
  ])("passes %s through to i18n routing", (path) => {
    const response = proxy(buildRequest(`http://localhost:3000${path}`));

    expect(response).toEqual({ marker: "i18n-routing" });
    expect(i18nRouting).toHaveBeenCalledTimes(1);
  });

  it("does not treat a nested protected prefix as public", () => {
    // `/usage/setup` must be protected too; the check is a prefix match.
    const response = proxy(
      buildRequest("http://localhost:3000/en/usage/setup"),
    );

    expect(response.status).toBe(307);
  });

  it("does not protect a path that merely resembles a protected one", () => {
    // The check is a raw prefix match, so `/settings` protects `/settings/x`
    // but `/setting` is a different path and must pass through.
    const response = proxy(buildRequest("http://localhost:3000/en/setting"));

    expect(response).toEqual({ marker: "i18n-routing" });
  });

  it("knows the prefix match is deliberate, not path-segment aware", () => {
    // Documented consequence of `startsWith`: `/usages` is protected even
    // though it is not a route. Over-protecting is the safe direction — an
    // unknown path redirects to login and then 404s — so this is pinned rather
    // than changed.
    const response = proxy(buildRequest("http://localhost:3000/en/usages"));

    expect(response.status).toBe(307);
  });
});

describe("proxy locale detection for redirects", () => {
  it("prefers the locale cookie", () => {
    const response = proxy(
      buildRequest("http://localhost:3000/en/usage", {
        cookie: "tb-locale=zh",
        acceptLanguage: "en-US,en;q=0.9",
      }),
    );

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/zh/login",
    );
  });

  it("falls back to accept-language", () => {
    const response = proxy(
      buildRequest("http://localhost:3000/en/usage", {
        acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
      }),
    );

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/zh/login",
    );
  });

  it("falls back to the default locale", () => {
    const response = proxy(buildRequest("http://localhost:3000/en/usage"));

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/en/login",
    );
  });
});
