// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteErrorCard } from "./route-error-card";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("RouteErrorCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT;
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders translated copy and re-fetches through retry", () => {
    const error = new Error("database unavailable");
    const retry = vi.fn();

    act(() => {
      root.render(<RouteErrorCard error={error} retry={retry} />);
    });

    expect(container.querySelector("h1")?.textContent).toBe(
      "common.errors.title",
    );
    expect(container.textContent).toContain("common.errors.description");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/");
    expect(console.error).toHaveBeenCalledWith(error);

    const retryButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "common.errors.retry",
    );

    act(() => {
      retryButton?.click();
    });

    expect(retry).toHaveBeenCalledTimes(1);
  });
});
