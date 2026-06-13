import { createFileRoute } from "@tanstack/react-router";
import { siSpotify } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// The admin front door. Plain utility copy — this surface lives behind the
// curtain (PRODUCT.md: the operator is never the narrator), so no Fluncle voice.
// The only way in is Login with Spotify, allow-listed to the operator account
// (admin-auth.ts); the button is a plain link to the public login-start route.
type LoginSearch = {
  error?: string;
};

export const Route = createFileRoute("/admin/login")({
  component: AdminLoginPage,
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
});

function AdminLoginPage() {
  const { error } = Route.useSearch();

  return (
    <main className="flex min-h-screen items-center justify-center p-6 text-foreground">
      <Card className="w-full max-w-sm" size="sm">
        <CardHeader>
          <CardTitle>Fluncle admin</CardTitle>
          <CardDescription>Sign in to tag tracks.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {error === "denied" ? (
            <p className="text-sm text-destructive">
              That account isn&rsquo;t allowed. Sign in with the operator account.
            </p>
          ) : undefined}
          <Button
            nativeButton={false}
            render={<a href="/api/admin/spotify/auth/login" />}
            size="lg"
          >
            <BrandIcon icon={siSpotify} />
            Log in with Spotify
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
