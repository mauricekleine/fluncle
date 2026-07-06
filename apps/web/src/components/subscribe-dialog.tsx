import { CircleNotchIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { type FormEvent, useReducer } from "react";
import { HoneypotField } from "@/components/honeypot-field";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@fluncle/ui/components/dialog";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@fluncle/ui/components/tooltip";
import { subscribeToNewsletter } from "@/lib/newsletter";

type FormState = {
  didSubscribe: boolean;
  email: string;
  error: string | undefined;
  isSubmitting: boolean;
  website: string;
};

type FormAction =
  | { fields: Partial<FormState>; type: "patch" }
  | { type: "submitFailed"; error: string }
  | { type: "submitStarted" }
  | { type: "submitSucceeded" };

const initialFormState: FormState = {
  didSubscribe: false,
  email: "",
  error: undefined,
  isSubmitting: false,
  website: "",
};

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "patch":
      return { ...state, ...action.fields };
    case "submitStarted":
      return { ...state, error: undefined, isSubmitting: true };
    case "submitSucceeded":
      return { ...state, didSubscribe: true, email: "", isSubmitting: false, website: "" };
    case "submitFailed":
      return { ...state, error: action.error, isSubmitting: false };
    default:
      return state;
  }
}

/**
 * `compact` renders the trigger as a tooltip'd icon. Otherwise it's a full
 * outline button; pass `className` (e.g. `flex-1`) and a shorter `label` to sit
 * it in the home plate's button row beside Playlist.
 */
export function SubscribeDialog({
  compact = false,
  className,
  label = "Get the weekly newsletter",
}: { compact?: boolean; className?: string; label?: string } = {}) {
  const [state, dispatch] = useReducer(formReducer, initialFormState);
  const { didSubscribe, email, error, isSubmitting, website } = state;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedEmail = email.trim();

    if (!trimmedEmail) {
      dispatch({ fields: { error: "Enter your email address." }, type: "patch" });
      return;
    }

    dispatch({ type: "submitStarted" });

    try {
      await subscribeToNewsletter({ email: trimmedEmail, honeypot: website });
      dispatch({ type: "submitSucceeded" });
    } catch (caughtError) {
      dispatch({
        error: caughtError instanceof Error ? caughtError.message : String(caughtError),
        type: "submitFailed",
      });
    }
  }

  return (
    <Dialog>
      {compact ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <DialogTrigger
                render={
                  <Button aria-label="Get the weekly newsletter" size="icon-lg" variant="outline" />
                }
              />
            }
          >
            <EnvelopeSimpleIcon aria-hidden="true" weight="bold" />
          </TooltipTrigger>
          <TooltipContent>Get the weekly newsletter</TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger render={<Button className={className} size="lg" variant="outline" />}>
          <EnvelopeSimpleIcon aria-hidden="true" weight="bold" />
          {label}
        </DialogTrigger>
      )}
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
                onChange={(event) =>
                  dispatch({ fields: { email: event.target.value }, type: "patch" })
                }
                placeholder="junglist@example.com"
                type="email"
                value={email}
              />
            </Label>
            <HoneypotField
              id="newsletter-website"
              onChange={(value) => dispatch({ fields: { website: value }, type: "patch" })}
              value={website}
            />
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
