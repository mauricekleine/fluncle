import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { isAdminRequest } from "@/lib/server/admin-auth";

// The page guard every `/admin/*` station runs in its `beforeLoad`: no grant, no
// page — bounce to the login card. ONE server fn, shared, so the guard cannot
// drift station to station (docs/admin-shell.md § web admin auth).
//
// It guards the PAINT only. Every admin server function and API route re-checks
// the grant itself, because a guard that runs before the loader protects the route
// and never the data behind it.
export const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});
