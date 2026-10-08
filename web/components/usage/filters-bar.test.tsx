// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FiltersBar } from "./filters-bar";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  searchParams: new URLSearchParams(
    "preset=custom&from=2026-03-26&to=2026-03-27",
  ),
}));

vi.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({
    replace: mocks.replace,
    refresh: mocks.refresh,
  }),
}));

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const options = {
  apiKeys: [],
  devices: [],
  sources: [],
  models: [],
  projects: [],
};

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(text: string) {
  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  ) as HTMLButtonElement;
}

function hrefParams(href: string) {
  return new URL(href, "http://localhost").searchParams;
}

describe("FiltersBar", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
    delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
  });

  function render() {
    act(() => {
      root.render(
        <FiltersBar
          preset="custom"
          range={{
            // 2026-03-26 00:00 up to 2026-03-28 00:00 in Asia/Shanghai.
            from: "2026-03-25T16:00:00.000Z",
            to: "2026-03-27T15:59:59.999Z",
            timezone: "Asia/Shanghai",
          }}
          filters={{}}
          options={options}
          lastSyncedText="synced"
        />,
      );
    });
  }

  function openCustomRange() {
    act(() => {
      buttonByText("custom").click();
    });

    return {
      from: document.getElementById("custom-from") as HTMLInputElement,
      to: document.getElementById("custom-to") as HTMLInputElement,
      apply: buttonByText("apply"),
    };
  }

  it("renders the presets, the sync text and the refresh controls", () => {
    render();

    expect(buttonByText("today")).toBeDefined();
    expect(buttonByText("7D")).toBeDefined();
    expect(buttonByText("30D")).toBeDefined();
    expect(container.textContent).toContain("synced");
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
    expect(buttonByText("refresh")).toBeDefined();
  });

  it("opens the custom range with the resolved edges to the minute", () => {
    render();

    const { from, to } = openCustomRange();

    expect(from.type).toBe("datetime-local");
    expect(to.type).toBe("datetime-local");
    expect(from.value).toBe("2026-03-26T00:00");
    expect(to.value).toBe("2026-03-28T00:00");
    expect(document.body.textContent).toContain(
      "customRangeDescription:Asia/Shanghai",
    );
  });

  it("applies a wall-clock range through the URL", () => {
    render();

    const { from, to, apply } = openCustomRange();

    act(() => {
      setInputValue(from, "2026-03-26T10:00");
    });
    act(() => {
      setInputValue(to, "2026-03-26T18:00");
    });

    expect(apply.disabled).toBe(false);

    act(() => {
      apply.click();
    });

    expect(mocks.replace).toHaveBeenCalledTimes(1);

    const href = mocks.replace.mock.calls[0][0] as string;
    const params = hrefParams(href);

    expect(new URL(href, "http://localhost").pathname).toBe("/usage");
    expect(params.get("preset")).toBe("custom");
    expect(params.get("from")).toBe("2026-03-26T10:00");
    expect(params.get("to")).toBe("2026-03-26T18:00");
  });

  it("refuses an end that is not after the start", () => {
    render();

    const { from, to, apply } = openCustomRange();

    act(() => {
      setInputValue(from, "2026-03-26T18:00");
    });
    act(() => {
      setInputValue(to, "2026-03-26T18:00");
    });

    expect(apply.disabled).toBe(true);

    act(() => {
      apply.click();
    });

    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("drops the custom edges when a preset is chosen", () => {
    render();

    act(() => {
      buttonByText("today").click();
    });

    const params = hrefParams(mocks.replace.mock.calls[0][0] as string);

    expect(params.get("preset")).toBe("1d");
    expect(params.get("from")).toBeNull();
    expect(params.get("to")).toBeNull();
  });
});
