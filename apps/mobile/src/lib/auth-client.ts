// The Better Auth client for the app (RFC: accounts in the pocket) — the native sibling of
// apps/web/src/lib/auth-client.ts. The app is one more SURFACE over the same public auth
// server (public-auth.ts): email/password + the username plugin, with `fluncle://`
// allow-listed in the server's `trustedOrigins`.
//
// The Expo plugin is what makes a cookie-session work with NO cookie jar: it persists the
// session cookie in SecureStore (keyed under `storagePrefix`) and replays it on the
// client's own auth calls; `cookiePrefix` must match the server's `advanced.cookiePrefix`
// ("fluncle_user") so it recognises the session cookie. For our OWN `/me` calls we read
// that cookie back via `authClient.getCookie()` and hand it to `meFetch` below.
//
// `expo-secure-store` is a NATIVE module — a dev client that predates this file must be
// rebuilt before the client can run on device.

import { expoClient } from "@better-auth/expo/client";
import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { API_BASE } from "@/config";
import { createMeFetch } from "@/lib/me-fetch";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  baseURL: API_BASE,
  plugins: [
    usernameClient(),
    expoClient({
      cookiePrefix: "fluncle_user",
      scheme: "fluncle",
      storage: SecureStore,
      storagePrefix: "fluncle",
    }),
  ],
});

// The one authenticated fetch for the private `/me` tier, bound to this client's stored
// cookie + the platform `fetch`. Every account slice (this one, and the later
// preferences/saves/sets) imports this.
export const meFetch = createMeFetch({
  fetchImpl: (input, init) => fetch(input, init),
  getCookie: () => authClient.getCookie(),
});
