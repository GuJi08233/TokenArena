// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistClientLocale, persistClientTheme } from "./preferences-client";

function clearCookies() {
  for (const entry of document.cookie.split(";")) {
    const name = entry.split("=")[0]?.trim();
    if (name) {
      // biome-ignore lint/suspicious/noDocumentCookie: resetting jsdom cookies between tests
      document.cookie = `${name}=; path=/; max-age=0`;
    }
  }
}

describe("preferences-client", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearCookies();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to document.cookie when the Cookie Store API is missing", async () => {
    // jsdom, like browsers on plain-HTTP origins, has no `cookieStore`.
    expect(typeof cookieStore).toBe("undefined");

    await persistClientTheme("dark");
    await persistClientLocale("zh");

    expect(window.localStorage.getItem("tb-theme")).toBe("dark");
    expect(document.cookie).toContain("tb-theme=dark");
    expect(document.cookie).toContain("tb-locale=zh");
  });

  it("uses the Cookie Store API when it is available", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("cookieStore", { set });

    await persistClientTheme("light");

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tb-theme",
        value: "light",
        path: "/",
        sameSite: "lax",
      }),
    );
    expect(window.localStorage.getItem("tb-theme")).toBe("light");
  });

  it("never rejects when persisting fails", async () => {
    const failure = new Error("blocked");
    vi.stubGlobal("cookieStore", {
      set: vi.fn().mockRejectedValue(failure),
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(persistClientTheme("dark")).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(failure);
  });
});
