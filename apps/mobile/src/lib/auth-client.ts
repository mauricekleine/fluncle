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

export const meFetch = createMeFetch({
  fetchImpl: (input, init) => fetch(input, init),
  getCookie: () => authClient.getCookie(),
});
