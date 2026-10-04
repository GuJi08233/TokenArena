import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type StatusCardProps = {
  title: string;
  description: string;
  actions?: ReactNode;
  tone?: "default" | "error";
};

/** Full-page status message shared by the error and not-found screens. */
export function StatusCard({
  title,
  description,
  actions,
  tone = "default",
}: StatusCardProps) {
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-6 sm:px-6 lg:px-8">
      <Card
        className={cn(
          "mx-auto mt-16 max-w-lg bg-card shadow-sm",
          tone === "error" && "border-destructive/20",
        )}
      >
        <CardContent className="space-y-4 p-6 text-center">
          <div className="space-y-2">
            <h1 className="font-semibold text-foreground text-lg tracking-tight">
              {title}
            </h1>
            <p className="text-muted-foreground text-sm leading-6">
              {description}
            </p>
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {actions}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
