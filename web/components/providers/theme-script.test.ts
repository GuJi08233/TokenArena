// @vitest-environment jsdom

import { runInThisContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThemeInitScript } from "./theme-script";

function runScript(script: string) {
  // The script is plain browser JS; run it against the jsdom globals the way
  // the HTML parser would.
  runInThisContext(script);
}

function mockSystemDark(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches } as MediaQueryList),
  );
}

describe("buildThemeInitScript", () => {
  const root = document.documentElement;

  beforeEach(() => {
    window.localStorage.clear();
    root.className = "";
    root.removeAttribute("data-theme-mode");
    root.style.colorScheme = "";
    mockSystemDark(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies the theme saved in localStorage before the cookie default", () => {
    window.localStorage.setItem("tb-theme", "dark");

    runScript(buildThemeInitScript("light"));

    expect(root.classList.contains("dark")).toBe(true);
    expect(root.dataset.themeMode).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("falls back to the server-provided mode and follows the system setting", () => {
    mockSystemDark(true);

    runScript(buildThemeInitScript("system"));

    expect(root.classList.contains("dark")).toBe(true);
    expect(root.dataset.themeMode).toBe("system");
  });

  it("ignores unknown stored values", () => {
    window.localStorage.setItem("tb-theme", "sepia");

    runScript(buildThemeInitScript("light"));

    expect(root.classList.contains("dark")).toBe(false);
    expect(root.dataset.themeMode).toBe("light");
  });

  it("still applies the default when storage access throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    runScript(buildThemeInitScript("dark"));

    expect(root.classList.contains("dark")).toBe(true);
  });
});
