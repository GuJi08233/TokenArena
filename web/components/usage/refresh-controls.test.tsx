// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_REFRESH_INTERVAL_MS,
  AUTO_REFRESH_STORAGE_KEY,
  RefreshControls,
} from "./refresh-controls";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, number>) =>
    values ? `${key}:${values.seconds}` : key,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({
    refresh: mocks.refresh,
  }),
}));

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("RefreshControls", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    window.localStorage.clear();
    setVisibility("visible");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
    delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
  });

  function render() {
    act(() => {
      root.render(<RefreshControls />);
    });
  }

  function refreshButton() {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "refresh",
    ) as HTMLButtonElement;
  }

  function autoSwitch() {
    return container.querySelector('[role="switch"]') as HTMLButtonElement;
  }

  it("refreshes the route when the button is clicked", () => {
    render();

    act(() => {
      refreshButton().click();
    });

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("starts, remembers and stops the interval from the switch", () => {
    render();

    expect(autoSwitch().getAttribute("aria-checked")).toBe("false");

    act(() => {
      autoSwitch().click();
    });

    expect(autoSwitch().getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY)).toBe("1");

    act(() => {
      vi.advanceTimersByTime(AUTO_REFRESH_INTERVAL_MS * 2);
    });

    expect(mocks.refresh).toHaveBeenCalledTimes(2);

    act(() => {
      autoSwitch().click();
    });
    act(() => {
      vi.advanceTimersByTime(AUTO_REFRESH_INTERVAL_MS * 2);
    });

    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY)).toBe("0");
  });

  it("restores the stored switch state on mount", () => {
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, "1");

    render();

    expect(autoSwitch().getAttribute("aria-checked")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(AUTO_REFRESH_INTERVAL_MS);
    });

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("skips ticks while hidden and catches up once the tab is shown", () => {
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, "1");

    render();
    setVisibility("hidden");

    act(() => {
      vi.advanceTimersByTime(AUTO_REFRESH_INTERVAL_MS * 3);
    });

    expect(mocks.refresh).not.toHaveBeenCalled();

    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("names the interval in the switch hint", () => {
    render();

    expect(container.querySelector("[title]")?.getAttribute("title")).toBe(
      `autoRefreshHint:${AUTO_REFRESH_INTERVAL_MS / 1000}`,
    );
  });
});
