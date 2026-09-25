import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { isAdminRequest } from "@/lib/server/admin-auth";

export const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});
