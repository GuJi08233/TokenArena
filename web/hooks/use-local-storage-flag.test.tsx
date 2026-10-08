// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLocalStorageFlag } from "./use-local-storage-flag";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function Probe({ storageKey }: { storageKey: string }) {
  const [value, setValue] = useLocalStorageFlag(storageKey);

  return (
    <button
      type="button"
      data-value={String(value)}
      onClick={() => setValue(!value)}
    >
      toggle
    </button>
  );
}

describe("useLocalStorageFlag", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
  });

  function render(storageKey: string) {
    act(() => {
      root.render(<Probe storageKey={storageKey} />);
    });

    return container.querySelector("button") as HTMLButtonElement;
  }

  it("defaults to false and persists changes", () => {
    const button = render("flag:default");

    expect(button.dataset.value).toBe("false");

    act(() => {
      button.click();
    });

    expect(button.dataset.value).toBe("true");
    expect(window.localStorage.getItem("flag:default")).toBe("1");

    act(() => {
      button.click();
    });

    expect(button.dataset.value).toBe("false");
    expect(window.localStorage.getItem("flag:default")).toBe("0");
  });

  it("reads a value stored earlier", () => {
    window.localStorage.setItem("flag:stored", "1");

    expect(render("flag:stored").dataset.value).toBe("true");
  });

  it("follows storage events from other tabs", () => {
    const button = render("flag:remote");

    window.localStorage.setItem("flag:remote", "1");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "flag:remote" }));
    });

    expect(button.dataset.value).toBe("true");
  });

  it("falls back to memory when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    const button = render("flag:blocked");

    expect(button.dataset.value).toBe("false");

    act(() => {
      button.click();
    });

    expect(button.dataset.value).toBe("true");
  });
});
