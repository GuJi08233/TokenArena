import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { getRequestOrigin } from "@/lib/request-origin";
import {
  getApiUrl,
  getDetailedInitGuide,
  USAGE_EMPTY_INSTALL_COMMAND,
} from "@/lib/usage/usage-empty-guide";

import { UsageEmptyCopyableCommand } from "./usage-empty-copyable-command";

type CliSetupStepsProps = {
  /** Placed after step 1 copy (e.g. create API key CTA). */
  step1Action: ReactNode;
};

/** Key → install/update → init steps, shared by the empty state and the persistent setup section. */
export async function CliSetupSteps({ step1Action }: CliSetupStepsProps) {
  const [t, origin] = await Promise.all([
    getTranslations("usage.emptyState"),
    getRequestOrigin(),
  ]);
  const apiUrl = getApiUrl(origin);
  const initGuide = getDetailedInitGuide(apiUrl);

  return (
    <ol className="list-inside list-decimal space-y-3 pl-6 text-sm text-muted-foreground sm:pl-8">
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
  );
}
