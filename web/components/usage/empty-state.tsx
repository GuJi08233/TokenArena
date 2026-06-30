import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getApiUrl,
  getDetailedInitGuide,
  USAGE_EMPTY_INSTALL_COMMAND,
} from "@/lib/usage/usage-empty-guide";

import { UsageEmptyCopyableCommand } from "./usage-empty-copyable-command";

/** Get the current origin from request headers (server-side). */
async function getRequestOrigin(): Promise<string | undefined> {
  const headersList = await headers();
  const host = headersList.get("host");
  if (!host) return undefined;

  const protocol = headersList.get("x-forwarded-proto") || "https";
  return `${protocol}://${host}`;
}

type EmptyStateProps = {
  /** Placed after step 1 copy (e.g. create API key CTA). */
  step1Action: ReactNode;
};

export async function EmptyState({ step1Action }: EmptyStateProps) {
  const t = await getTranslations("usage.emptyState");
  const origin = await getRequestOrigin();
  const apiUrl = getApiUrl(origin);
  const initGuide = getDetailedInitGuide(apiUrl);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm text-muted-foreground">
        <ol className="list-inside list-decimal space-y-3 pl-6 sm:pl-8">
          {/* step1 */}
          <li className="space-y-2">{step1Action}</li>

          {/* step2 */}
          <li className="space-y-2">
            {t("step2")}
            <br />
          </li>
          <UsageEmptyCopyableCommand command={USAGE_EMPTY_INSTALL_COMMAND} />

          {/* step3 */}
          <li className="space-y-2">
            {t("step3")}
            <br />
          </li>
          <UsageEmptyCopyableCommand command={initGuide} />
        </ol>
      </CardContent>
    </Card>
  );
}
