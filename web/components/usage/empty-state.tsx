import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { CliSetupSteps } from "./cli-setup-steps";

type EmptyStateProps = {
  /** Placed after step 1 copy (e.g. create API key CTA). */
  step1Action: ReactNode;
};

export async function EmptyState({ step1Action }: EmptyStateProps) {
  const t = await getTranslations("usage.emptyState");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <CliSetupSteps step1Action={step1Action} />
      </CardContent>
    </Card>
  );
}
