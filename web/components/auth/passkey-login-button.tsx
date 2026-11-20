"use client";

import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";

export function PasskeyLoginButton() {
  const t = useTranslations("auth.passkey");
  const { push, refresh } = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    if (!window.isSecureContext || !window.PublicKeyCredential) {
      setError(t("unsupported"));
      return;
    }

    setPending(true);
    setError(null);
    try {
      const { data } = await authClient.signIn.passkey();
      if (!data) {
        setError(t("signInFailed"));
        return;
      }

      push("/usage");
      refresh();
    } catch {
      setError(t("signInFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        className="w-full"
        disabled={pending}
        onClick={signIn}
        type="button"
        variant="outline"
      >
        <KeyRound aria-hidden />
        {pending ? t("signingIn") : t("signIn")}
      </Button>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
