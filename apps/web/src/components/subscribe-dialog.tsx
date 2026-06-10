import { CircleNotchIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { HoneypotField } from "@/components/honeypot-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { subscribeToNewsletter } from "@/lib/newsletter";

export function SubscribeDialog() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [didSubscribe, setDidSubscribe] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedEmail = email.trim();

    if (!trimmedEmail) {
      setError("Enter your email address.");
      return;
    }

    setError(undefined);
    setIsSubmitting(true);

    try {
      await subscribeToNewsletter({ email: trimmedEmail, honeypot: website });
      setDidSubscribe(true);
      setEmail("");
      setWebsite("");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog>
      <DialogTrigger render={<Button size="lg" variant="outline" />}>
        <EnvelopeSimpleIcon aria-hidden="true" weight="bold" />
        Get the weekly newsletter
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>The weekly newsletter</DialogTitle>
          <DialogDescription>Fresh bangers, every Friday, from Fluncle.</DialogDescription>
        </DialogHeader>

        {didSubscribe ? (
          <p className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm text-accent-foreground">
            You're on the list.
          </p>
        ) : (
          <form className="grid gap-3" onSubmit={handleSubmit}>
            <Label className="grid gap-2 text-sm font-bold" htmlFor="newsletter-email">
              Email
              <Input
                autoComplete="email"
                id="newsletter-email"
                inputMode="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="junglist@example.com"
                type="email"
                value={email}
              />
            </Label>
            <HoneypotField id="newsletter-website" onChange={setWebsite} value={website} />
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? (
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
              ) : (
                <EnvelopeSimpleIcon aria-hidden="true" weight="bold" />
              )}
              Get on the list
            </Button>
          </form>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : undefined}
      </DialogContent>
    </Dialog>
  );
}
