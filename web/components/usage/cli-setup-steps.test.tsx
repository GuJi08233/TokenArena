import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  getAppOrigin: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/site-url", () => ({
  getAppOrigin: mocks.getAppOrigin,
}));

import { CliSetupSteps } from "./cli-setup-steps";

describe("CliSetupSteps", () => {
  beforeEach(() => {
    mocks.getAppOrigin.mockReturnValue(undefined);
    mocks.headers.mockResolvedValue(
      new Headers({ host: "arena.example.com", "x-forwarded-proto": "http" }),
    );
  });

  it("renders the step action, install/update command and init guide", async () => {
    const markup = renderToStaticMarkup(
      await CliSetupSteps({
        step1Action: React.createElement("a", { href: "/keys" }, "keys"),
      }),
    );

    expect(markup).toContain('<a href="/keys">keys</a>');
    expect(markup).toContain("npm install -g @yishiguji/tokenarena@latest");
    expect(markup).toContain(
      "tokenarena init --api-url http://arena.example.com",
    );
  });

  it("falls back to the default server when no origin is available", async () => {
    mocks.headers.mockResolvedValue(new Headers());

    const markup = renderToStaticMarkup(
      await CliSetupSteps({ step1Action: null }),
    );

    expect(markup).toContain(
      "tokenarena init --api-url https://token.guji.uno",
    );
  });
});
