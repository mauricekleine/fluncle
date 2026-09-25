import { createAuthClient } from "better-auth/react";
import { deviceAuthorizationClient, usernameClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  basePath: "/api/auth",

  plugins: [usernameClient(), deviceAuthorizationClient()],
});
