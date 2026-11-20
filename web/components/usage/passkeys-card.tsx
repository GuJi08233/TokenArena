"use client";

import { KeyRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { authClient } from "@/lib/auth-client";

export function PasskeysCard() {
  const t = useTranslations("usage.settings.passkeys");
  const tPasskey = useTranslations("auth.passkey");
  const format = useFormatter();
  const {
    data: passkeys,
    isPending,
    error: listError,
  } = authClient.useListPasskeys();
  const [busy, setBusy] = useState<"add" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    id: string;
    label: string;
  } | null>(null);

  const addPasskey = async () => {
    if (!window.isSecureContext || !window.PublicKeyCredential) {
      setError(tPasskey("unsupported"));
      return;
    }

    setError(null);
    setBusy("add");
    try {
      const { data, error: addError } = await authClient.passkey.addPasskey();
      if (!data) {
        setError(
          addError &&
            "code" in addError &&
            addError.code === "SESSION_NOT_FRESH"
            ? t("signInAgain")
            : t("addFailed"),
        );
      }
    } catch {
      setError(t("addFailed"));
    } finally {
      setBusy(null);
    }
  };

  const removePasskey = async () => {
    if (!selected) return;

    setError(null);
    setBusy("remove");
    try {
      const { data } = await authClient.passkey.deletePasskey({
        id: selected.id,
      });
      if (data?.status !== true) {
        setError(t("removeFailed"));
        return;
      }
      setSelected(null);
    } catch {
      setError(t("removeFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-border/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium">{t("title")}</h3>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={addPasskey}
        >
          <KeyRound aria-hidden />
          {busy === "add" ? t("adding") : t("add")}
        </Button>
      </div>

      {!selected && (error || listError) ? (
        <Alert variant="destructive">
          <AlertDescription>{error ?? t("listFailed")}</AlertDescription>
        </Alert>
      ) : null}

      {isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      ) : passkeys?.length ? (
        <ul className="divide-y divide-border/50">
          {passkeys.map((passkey) => {
            const label = passkey.name || t("unnamed");
            return (
              <li key={passkey.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{label}</p>
                  {passkey.createdAt ? (
                    <p className="text-xs text-muted-foreground">
                      {format.dateTime(new Date(passkey.createdAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => {
                    setError(null);
                    setSelected({ id: passkey.id, label });
                  }}
                >
                  {t("remove")}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : !listError ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : null}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && busy !== "remove") {
            setSelected(null);
            setError(null);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("removeTitle")}</DialogTitle>
            <DialogDescription>
              {t("removeDescription", { name: selected?.label ?? "" })}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy === "remove"}
              onClick={() => {
                setSelected(null);
                setError(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy === "remove"}
              onClick={removePasskey}
            >
              {busy === "remove" ? t("removing") : t("remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
