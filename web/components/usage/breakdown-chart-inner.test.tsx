import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BreakdownTooltipContent } from "./breakdown-chart-inner";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

const point = {
  key: "claude-code",
  name: "Claude Code",
  shortName: "Claude Code",
  value: 1_500_000,
  valueLabel: "1.5M",
  share: 0.42,
  totalTokens: 1_500_000,
  estimatedCostUsd: 3.2,
  totalSeconds: 5400,
  sessions: 12,
  messages: 140,
};

describe("BreakdownTooltipContent", () => {
  it("labels every row with translated copy instead of field names", () => {
    const markup = renderToStaticMarkup(
      <BreakdownTooltipContent
        active
        payload={[{ payload: point }]}
        metric="totalTokens"
        locale="en"
      />,
    );

    for (const key of [
      "totalTokens",
      "share",
      "estimatedCost",
      "totalTime",
      "sessions",
      "messages",
    ]) {
      expect(markup).toContain(`usage.breakdowns.table.${key}`);
    }
    expect(markup).not.toMatch(/>(share|sessions|messages|totalTime)</);
  });

  it("does not repeat the ranked metric as a secondary row", () => {
    const markup = renderToStaticMarkup(
      <BreakdownTooltipContent
        active
        payload={[{ payload: point }]}
        metric="estimatedCostUsd"
        locale="en"
      />,
    );

    expect(
      markup.match(/usage\.breakdowns\.table\.estimatedCost/g),
    ).toHaveLength(1);
    expect(markup).toContain("usage.breakdowns.table.totalTokens");
  });

  it("renders nothing while inactive", () => {
    expect(
      renderToStaticMarkup(
        <BreakdownTooltipContent metric="totalTokens" locale="en" />,
      ),
    ).toBe("");
  });
});
