import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProfileTopList } from "./profile-top-list";

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) =>
    (key: string): string => {
      if (namespace === "social.profile" && key === "totalTokens") {
        return "Total Tokens";
      }
      if (namespace === "usage.breakdowns.table" && key === "share") {
        return "Share";
      }
      return key;
    },
}));

describe("ProfileTopList", () => {
  it("renders ranked values and proportional bars without a chart runtime", () => {
    const markup = renderToStaticMarkup(
      <ProfileTopList
        locale="en"
        emptyLabel="No data"
        items={[
          { name: "Claude Code", totalTokens: 1_200_000, share: 0.8 },
          { name: "Codex", totalTokens: 300_000, share: 0.2 },
        ]}
      />,
    );

    expect(markup).toContain("Claude Code");
    expect(markup).toContain("Codex");
    expect(markup).toContain("1.2M");
    expect(markup).toContain("300K");
    expect(markup).toContain("Share: 80.0%");
    expect(markup).toContain("width:100%");
    expect(markup).toContain("width:25%");
    expect(markup).toContain("Total Tokens:");
  });

  it("renders the empty label when no items are available", () => {
    const markup = renderToStaticMarkup(
      <ProfileTopList locale="en" emptyLabel="No tool usage yet." items={[]} />,
    );

    expect(markup).toContain("No tool usage yet.");
    expect(markup).not.toContain('aria-hidden="true"');
  });
});
