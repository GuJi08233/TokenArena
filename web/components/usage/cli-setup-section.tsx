import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { CliSetupSteps } from "./cli-setup-steps";
import { CollapsibleSection } from "./collapsible-section";

type CliSetupSectionProps = {
  /** Placed after step 1 copy (e.g. manage API keys CTA). */
  step1Action: ReactNode;
};

/** Always-available CLI install / update guide, collapsed by default once usage data exists. */
export async function CliSetupSection({ step1Action }: CliSetupSectionProps) {
  const t = await getTranslations("usage.cliSetup");

  return (
    <CollapsibleSection title={t("title")} description={t("description")}>
      <CliSetupSteps step1Action={step1Action} />
    </CollapsibleSection>
  );
}
