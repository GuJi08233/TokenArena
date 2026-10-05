"use client";

import { useTranslations } from "next-intl";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  formatDuration,
  formatPercentage,
  formatTokenCount,
  formatUsdAmount,
} from "@/lib/usage/format";

type BreakdownChartDatum = {
  key: string;
  name: string;
  shortName: string;
  value: number;
  valueLabel: string;
  share: number;
  totalTokens: number;
  estimatedCostUsd: number;
  totalSeconds: number;
  sessions: number;
  messages: number;
};

type BreakdownMetric = "estimatedCostUsd" | "totalTokens";

const VALUE_LABEL_FONT_SIZE = 12;
const VALUE_LABEL_OFFSET = 10;
/** Room the rightmost axis tick, centred on the plot edge, already needed. */
const MIN_RIGHT_MARGIN = 24;

/**
 * Pixel width of a value label. The UI font is Geist Mono, 0.6em per
 * character; CJK units from compact currency (万, 亿) fall back to a
 * full-width glyph.
 */
function estimateLabelWidth(label: string) {
  let width = 0;
  for (const character of label) {
    width +=
      (character.charCodeAt(0) >= 0x2e80 ? 1 : 0.6) * VALUE_LABEL_FONT_SIZE;
  }
  return width;
}

/**
 * Right margin that keeps every value label inside the chart.
 *
 * Labels sit past the end of their bar, and the longest bar reaches the plot
 * edge whenever the axis rounds its maximum only just above the data (139.2M
 * on a 140M axis), so the margin has to hold a whole label.
 */
export function getValueLabelMargin(labels: readonly string[]) {
  const widest = Math.max(0, ...labels.map(estimateLabelWidth));
  return Math.max(MIN_RIGHT_MARGIN, Math.ceil(VALUE_LABEL_OFFSET + widest + 4));
}

function formatMetricValue(
  value: number,
  metric: BreakdownMetric,
  locale: string,
) {
  if (metric === "estimatedCostUsd") {
    return formatUsdAmount(value, locale, { compact: true });
  }

  return formatTokenCount(value);
}

type BreakdownTooltipContentProps = {
  active?: boolean;
  payload?: ReadonlyArray<{
    payload?: BreakdownChartDatum;
  }>;
  metric: BreakdownMetric;
  locale: string;
};

function getMetricLabelKey(metric: BreakdownMetric) {
  switch (metric) {
    case "estimatedCostUsd":
      return "estimatedCost";
    case "totalTokens":
      return "totalTokens";
  }
}

export function BreakdownTooltipContent({
  active,
  payload,
  metric,
  locale,
}: BreakdownTooltipContentProps) {
  const t = useTranslations("usage.breakdowns.table");
  const point = payload?.[0]?.payload;

  if (!active || !point) {
    return null;
  }

  return (
    <div className="min-w-48 rounded-lg border bg-background/95 p-3 shadow-md">
      <div className="mb-3 text-sm font-medium text-foreground">
        {point.name}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-6 text-sm">
          <span className="text-muted-foreground">
            {t(getMetricLabelKey(metric))}
          </span>
          <span className="font-medium text-foreground">
            {formatMetricValue(point.value, metric, locale)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-6 text-sm">
          <span className="text-muted-foreground">{t("share")}</span>
          <span className="font-medium text-foreground">
            {formatPercentage(point.share, locale)}
          </span>
        </div>
        {metric !== "totalTokens" ? (
          <div className="flex items-center justify-between gap-6 text-sm">
            <span className="text-muted-foreground">{t("totalTokens")}</span>
            <span className="font-medium text-foreground">
              {formatTokenCount(point.totalTokens)}
            </span>
          </div>
        ) : null}
        {metric !== "estimatedCostUsd" ? (
          <div className="flex items-center justify-between gap-6 text-sm">
            <span className="text-muted-foreground">{t("estimatedCost")}</span>
            <span className="font-medium text-foreground">
              {formatUsdAmount(point.estimatedCostUsd, locale)}
            </span>
          </div>
        ) : null}
        {point.totalSeconds > 0 ? (
          <div className="flex items-center justify-between gap-6 text-sm">
            <span className="text-muted-foreground">{t("totalTime")}</span>
            <span className="font-medium text-foreground">
              {formatDuration(point.totalSeconds)}
            </span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-6 text-sm">
          <span className="text-muted-foreground">{t("sessions")}</span>
          <span className="font-medium text-foreground">
            {formatTokenCount(point.sessions)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-6 text-sm">
          <span className="text-muted-foreground">{t("messages")}</span>
          <span className="font-medium text-foreground">
            {formatTokenCount(point.messages)}
          </span>
        </div>
      </div>
    </div>
  );
}

type BreakdownChartInnerProps = {
  chartData: BreakdownChartDatum[];
  chartHeight: number;
  metric: BreakdownMetric;
  locale: string;
};

export function BreakdownChartInner({
  chartData,
  chartHeight,
  metric,
  locale,
}: BreakdownChartInnerProps) {
  return (
    <div
      className="w-full min-w-0 flex-1"
      style={{ height: `${chartHeight}px` }}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{
          width: 720,
          height: chartHeight,
        }}
      >
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{
            left: 8,
            right: getValueLabelMargin(chartData.map((row) => row.valueLabel)),
            top: 4,
            bottom: 4,
          }}
          barCategoryGap="20%"
        >
          <CartesianGrid
            horizontal={false}
            strokeDasharray="3 3"
            className="stroke-muted"
          />
          <XAxis
            type="number"
            tick={{ fontSize: 12 }}
            tickFormatter={(value) => formatMetricValue(value, metric, locale)}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="key"
            width={104}
            tick={{ fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value: string) => {
              const entry = chartData.find((row) => row.key === value);
              return entry?.shortName ?? value;
            }}
          />
          <Tooltip
            cursor={{ fill: "var(--muted)", opacity: 0.45 }}
            content={(props) => (
              <BreakdownTooltipContent
                {...props}
                metric={metric}
                locale={locale}
              />
            )}
          />
          <Bar
            dataKey="value"
            fill={
              metric === "estimatedCostUsd"
                ? "var(--chart-2)"
                : "var(--chart-1)"
            }
            radius={[0, 6, 6, 0]}
            background={{ fill: "var(--card)" }}
          >
            <LabelList
              dataKey="valueLabel"
              position="right"
              offset={VALUE_LABEL_OFFSET}
              fill="var(--foreground)"
              fontSize={VALUE_LABEL_FONT_SIZE}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
