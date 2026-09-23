"use client";

import { useTranslations } from "next-intl";

import { formatPercentage, formatTokenCount } from "@/lib/usage/format";

type ProfileTopListProps = {
  locale: string;
  emptyLabel: string;
  items: Array<{
    name: string;
    totalTokens: number;
    share: number;
  }>;
};

export function ProfileTopList({
  locale,
  emptyLabel,
  items,
}: ProfileTopListProps) {
  const tProfile = useTranslations("social.profile");
  const tTable = useTranslations("usage.breakdowns.table");

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const maxTokens = Math.max(0, ...items.map((item) => item.totalTokens));

  return (
    <ol className="space-y-3 py-1">
      {items.map((item, index) => (
        <li key={item.name} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium" title={item.name}>
              {item.name}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              <span className="sr-only">{tProfile("totalTokens")}: </span>
              {formatTokenCount(item.totalTokens)}
            </span>
          </div>
          <div
            aria-hidden="true"
            className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-chart-1"
              style={{
                width: `${maxTokens > 0 ? Math.max(0, Math.min(100, (item.totalTokens / maxTokens) * 100)) : 0}%`,
                opacity: Math.max(1 - index * 0.14, 0.35),
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {tTable("share")}: {formatPercentage(item.share, locale)}
          </p>
        </li>
      ))}
    </ol>
  );
}
