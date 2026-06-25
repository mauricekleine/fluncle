import { createAuthClient } from "better-auth/react";
import { deviceAuthorizationClient, usernameClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  // `deviceAuthorizationClient` exposes `authClient.device.approve/deny` for the
  // /device verification surface, where a signed-in user approves a `fluncle login`.
  plugins: [usernameClient(), deviceAuthorizationClient()],
});
