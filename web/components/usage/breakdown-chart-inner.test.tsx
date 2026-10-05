import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BreakdownTooltipContent,
  getValueLabelMargin,
} from "./breakdown-chart-inner";

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

describe("getValueLabelMargin", () => {
  // Value labels are 12px Geist Mono, 7.2px per glyph, drawn 10px past the
  // bar. A bar can end at the plot edge, so the margin must hold all of it.
  it("holds a whole label after a bar that reaches the plot edge", () => {
    // 139.2M on a 140M axis was cut down to "139" by the old 24px margin.
    expect(getValueLabelMargin(["139.2M", "214.1K"])).toBeGreaterThanOrEqual(
      10 + 6 * 7.2,
    );
  });

  it("sizes CJK currency units as full-width glyphs", () => {
    expect(getValueLabelMargin(["US$13.9万"])).toBeGreaterThanOrEqual(
      10 + 7 * 7.2 + 12,
    );
    expect(getValueLabelMargin(["US$13.9万"])).toBeGreaterThan(
      getValueLabelMargin(["US$13.9M"]),
    );
  });

  it("follows the widest label and keeps the edge tick's room", () => {
    expect(getValueLabelMargin(["1", "US$0.000123"])).toBe(
      getValueLabelMargin(["US$0.000123"]),
    );
    expect(getValueLabelMargin(["0"])).toBe(24);
    expect(getValueLabelMargin([])).toBe(24);
  });
});
