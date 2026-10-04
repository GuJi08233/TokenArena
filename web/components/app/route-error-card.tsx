"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { StatusCard } from "@/components/app/status-card";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

type RouteErrorCardProps = {
  error: Error & { digest?: string };
  /** Re-fetches the segment; `reset` alone would re-render the failed payload. */
  retry: () => void;
};

export function RouteErrorCard({ error, retry }: RouteErrorCardProps) {
  const t = useTranslations("common.errors");

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusCard
      tone="error"
      title={t("title")}
      description={t("description")}
      actions={
        <>
          <Button type="button" onClick={retry}>
            {t("retry")}
          </Button>
          <Button asChild variant="outline">
            <Link href="/">{t("home")}</Link>
          </Button>
        </>
      }
    />
  );
}
