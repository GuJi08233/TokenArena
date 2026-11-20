import type { AuthMode } from "@/lib/auth-config";
import type { LoginProvider } from "@/lib/auth-providers";
import { CredentialsLoginForm } from "./credentials-login-form";
import { PasskeyLoginButton } from "./passkey-login-button";
import { SocialLoginForm } from "./social-login-form";

type LoginFormProps = {
  mode: AuthMode;
  showInvalidSessionMessage?: boolean;
  providers: LoginProvider[];
};

export function LoginForm({
  mode,
  showInvalidSessionMessage = false,
  providers,
}: LoginFormProps) {
  return (
    <div className="space-y-4">
      {mode === "self-hosted" ? (
        <CredentialsLoginForm
          showInvalidSessionMessage={showInvalidSessionMessage}
        />
      ) : (
        <SocialLoginForm
          showInvalidSessionMessage={showInvalidSessionMessage}
          providers={providers}
        />
      )}
      <PasskeyLoginButton />
    </div>
  );
}
