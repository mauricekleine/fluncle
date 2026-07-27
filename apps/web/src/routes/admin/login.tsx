import { createFileRoute } from "@tanstack/react-router";
import { siSpotify } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Button } from "@fluncle/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@fluncle/ui/components/card";

// The admin front door. Plain utility copy — this surface lives behind the
// curtain (PRODUCT.md: the operator is never the narrator), so no Fluncle voice.
// The only way in is Login with Spotify, allow-listed to the operator account
// (admin-auth.ts); the button is a plain link to the public login-start route.
// `handoff` is the CLI connect ticket (lib/server/oauth-handoff.ts): a connect link
// opened while signed out lands here, and the ticket rides through the login so the
// operator is returned to the connect afterwards instead of the board. It is opaque
// here — the login start verifies it, the handoff route verifies it again.
type LoginSearch = {
  error?: string;
  handoff?: string;
};

export const Route = createFileRoute("/admin/login")({
  component: AdminLoginPage,
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    error: typeof search.error === "string" ? search.error : undefined,
    handoff: typeof search.handoff === "string" ? search.handoff : undefined,
  }),
});

function AdminLoginPage() {
  const { error, handoff } = Route.useSearch();
  const loginHref = handoff
    ? `/api/v1/admin/spotify/auth/login?handoff=${encodeURIComponent(handoff)}`
    : "/api/v1/admin/spotify/auth/login";

  return (
    <main className="flex min-h-screen items-center justify-center p-6 text-foreground">
      <Card className="w-full max-w-sm" size="sm">
        <CardHeader>
          <CardTitle>Fluncle admin</CardTitle>
          <CardDescription>Sign in to run the pipeline.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {error === "denied" ? (
            <p className="text-sm text-destructive">
              That account isn&rsquo;t allowed. Sign in with the operator account.
            </p>
          ) : undefined}
          {handoff ? (
            <p className="text-sm text-muted-foreground">
              Sign in to finish the connect you started in the terminal.
            </p>
          ) : undefined}
          <Button nativeButton={false} render={<a href={loginHref} />} size="lg">
            <BrandIcon icon={siSpotify} />
            Log in with Spotify
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
