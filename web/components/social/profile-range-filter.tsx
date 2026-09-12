"use client";

import { CalendarDays } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Link, useRouter } from "@/i18n/navigation";
import {
  defaultProfileRangePreset,
  type ProfileRangePreset,
  profileRangePresets,
} from "@/lib/social/profile-range";
import { formatDateInput } from "@/lib/usage/format";

type ProfileRangeFilterProps = {
  /** Locale-less profile path, e.g. `/u/alice`. */
  basePath: string;
  preset: ProfileRangePreset;
  /** ISO bounds of the active range; null for the all-time default. */
  from: string | null;
  to: string | null;
  timezone: string;
};

const linkPresets = profileRangePresets.filter(
  (preset) => preset !== "custom",
) satisfies readonly ProfileRangePreset[];

function buildPresetHref(basePath: string, preset: ProfileRangePreset) {
  if (preset === defaultProfileRangePreset) {
    return basePath;
  }

  return `${basePath}?preset=${preset}`;
}

function toDateValue(value: string | null, timezone: string) {
  return formatDateInput(value ? new Date(value) : new Date(), timezone);
}

export function ProfileRangeFilter({
  basePath,
  preset,
  from,
  to,
  timezone,
}: ProfileRangeFilterProps) {
  const tProfile = useTranslations("social.profile");
  const tFilters = useTranslations("usage.filters");
  const { replace } = useRouter();
  const [isCustomOpen, setIsCustomOpen] = useState(false);
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- draft inputs, seeded from the active range
  const [customFrom, setCustomFrom] = useState(() =>
    toDateValue(from, timezone),
  );
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- draft inputs, seeded from the active range
  const [customTo, setCustomTo] = useState(() => toDateValue(to, timezone));

  const applyCustomRange = () => {
    if (!customFrom || !customTo) {
      return;
    }

    const params = new URLSearchParams({
      preset: "custom",
      from: customFrom,
      to: customTo,
    });

    replace(`${basePath}?${params.toString()}`);
    setIsCustomOpen(false);
  };

  const rangeCaption =
    from && to
      ? `${formatDateInput(from, timezone)} → ${formatDateInput(to, timezone)}`
      : null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-card px-4 py-3 text-card-foreground ring-1 ring-foreground/10">
      <span className="shrink-0 font-heading text-base font-medium leading-snug text-card-foreground">
        {tProfile("rangeTitle")}
      </span>

      {linkPresets.map((item) => (
        <Button
          key={item}
          asChild
          variant={preset === item ? "default" : "outline"}
          size="sm"
        >
          <Link
            href={buildPresetHref(basePath, item)}
            aria-current={preset === item ? "page" : undefined}
          >
            {item === "all" ? tProfile("rangeAll") : item.toUpperCase()}
          </Link>
        </Button>
      ))}

      <Popover
        open={isCustomOpen}
        onOpenChange={(open) => {
          setIsCustomOpen(open);
          if (open) {
            setCustomFrom(toDateValue(from, timezone));
            setCustomTo(toDateValue(to, timezone));
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={preset === "custom" ? "default" : "outline"}
            size="sm"
          >
            <CalendarDays />
            {tFilters("custom")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-4">
          <div className="space-y-4">
            <div className="space-y-1">
              <div className="font-medium">{tFilters("customRangeTitle")}</div>
              <p className="text-sm text-muted-foreground">
                {tFilters("customRangeDescription", { timezone })}
              </p>
            </div>
            <div className="grid gap-3">
              <div className="space-y-2">
                <Label htmlFor="profile-range-from">{tFilters("from")}</Label>
                <Input
                  id="profile-range-from"
                  type="date"
                  value={customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="profile-range-to">{tFilters("to")}</Label>
                <Input
                  id="profile-range-to"
                  type="date"
                  value={customTo}
                  onChange={(event) => setCustomTo(event.target.value)}
                />
              </div>
              <Button type="button" onClick={applyCustomRange}>
                {tFilters("apply")}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {rangeCaption ? (
        <span className="ml-auto text-sm text-muted-foreground">
          {rangeCaption}
        </span>
      ) : null}
    </div>
  );
}
