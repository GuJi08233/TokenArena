import { passkeyClient } from "@better-auth/passkey/client";
import {
  genericOAuthClient,
  inferAdditionalFields,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    genericOAuthClient(),
    passkeyClient(),
    inferAdditionalFields({
      user: {
        username: {
          type: "string",
          required: true,
          returned: true,
          unique: true,
          sortable: true,
        },
        usernameNeedsSetup: {
          type: "boolean",
          required: false,
          returned: true,
        },
        usernameAutoAdjusted: {
          type: "boolean",
          required: false,
          returned: true,
        },
      },
    }),
  ],
});
