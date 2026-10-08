"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useLocalStorageFlag } from "@/hooks/use-local-storage-flag";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/**
 * The CLI daemon uploads every 30 minutes by default, but `syncInterval` can
 * be far shorter. A minute keeps such a stream visible without re-running the
 * dashboard queries on every tick of a clock.
 */
export const AUTO_REFRESH_INTERVAL_MS = 60 * 1000;

export const AUTO_REFRESH_STORAGE_KEY = "tokenarena:usage:auto-refresh";

/**
 * Re-fetches the server-rendered dashboard: a button for right now, and a
 * switch that repeats it while the tab is visible. The switch is remembered
 * per browser.
 */
export function RefreshControls() {
  const t = useTranslations("usage.filters");
  const { refresh } = useRouter();
  const [isPending, startTransition] = useTransition();
  const [autoRefresh, setAutoRefresh] = useLocalStorageFlag(
    AUTO_REFRESH_STORAGE_KEY,
  );
  const switchId = useId();

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }

    // Also runs when the tab comes back into view, so a hidden tab catches up
    // at once instead of waiting for its next tick.
    const tick = () => {
      if (document.visibilityState !== "hidden") {
        startTransition(() => {
          refresh();
        });
      }
    };
    const interval = setInterval(tick, AUTO_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [autoRefresh, refresh]);

  return (
    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => {
          startTransition(() => {
            refresh();
          });
        }}
      >
        <RefreshCw className={cn(isPending && "animate-spin")} />
        {t("refresh")}
      </Button>
      <div
        className="flex items-center gap-2"
        title={t("autoRefreshHint", {
          seconds: AUTO_REFRESH_INTERVAL_MS / 1000,
        })}
      >
        <Switch
          id={switchId}
          size="sm"
          checked={autoRefresh}
          onCheckedChange={setAutoRefresh}
        />
        <Label
          htmlFor={switchId}
          className="text-sm font-normal text-muted-foreground"
        >
          {t("autoRefresh")}
        </Label>
      </div>
    </div>
  );
}
