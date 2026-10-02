import { Clock, Data, Duration, Effect, Result } from "effect";
import { ApiError } from "./api-error";
import { runServerEffect } from "./effect/runtime";
import { type FetchImpl } from "./env";

class OAuthRequestFailed extends Data.TaggedError("OAuthRequestFailed")<{
  cause: unknown;
  invalidGrant: boolean;
}> {}

export function oauthPromise<A>(call: () => Promise<A>): Effect.Effect<A, OAuthRequestFailed> {
  return Effect.tryPromise({
    catch: (cause) =>
      cause instanceof OAuthRequestFailed
        ? cause
        : new OAuthRequestFailed({ cause, invalidGrant: false }),
    try: call,
  });
}

export function oauthRequest<A>(
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<A>,
  fetchImpl: FetchImpl = fetch,
): Effect.Effect<A, OAuthRequestFailed> {
  return Effect.tryPromise({
    catch: (cause) =>
      cause instanceof OAuthRequestFailed
        ? cause
        : new OAuthRequestFailed({ cause, invalidGrant: false }),
    try: async (signal) => read(await fetchImpl(url, { ...init, signal })),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(15),
      orElse: () =>
        Effect.fail(
          new OAuthRequestFailed({
            cause: new Error("OAuth request timed out"),
            invalidGrant: false,
          }),
        ),
    }),
  );
}

export function oauthTokenRequest<A>(
  url: string,
  init: RequestInit,
  code: string,
  label: string,
  fetchImpl: FetchImpl = fetch,
  isInvalidGrant?: (
    response: Response,
    data: { error?: unknown; message?: unknown } | null,
  ) => boolean,
): Effect.Effect<A, OAuthRequestFailed> {
  return oauthRequest(
    url,
    init,
    async (response) => {
      if (!response.ok) {
        const body = await response.text();
        let invalidGrant = false;

        try {
          const data = JSON.parse(body) as { error?: unknown; message?: unknown } | null;
          invalidGrant =
            data?.error === "invalid_grant" || isInvalidGrant?.(response, data) === true;
        } catch {
          invalidGrant = false;
        }

        throw new OAuthRequestFailed({
          cause: new ApiError(
            code,
            `${label} failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
            400,
          ),
          invalidGrant,
        });
      }

      return (await response.json()) as A;
    },
    fetchImpl,
  );
}

export function runOAuthEffect<A>(effect: Effect.Effect<A, OAuthRequestFailed>): Promise<A> {
  return runServerEffect(effect.pipe(Effect.mapError((error) => error.cause)));
}

type OAuthAuthRow = {
  access_token: string;
  expires_at: string;
  refresh_token?: string;
};

type OAuthTokenStore<Row extends OAuthAuthRow, Token> = {
  clear: () => Promise<void>;
  notAuthenticated: ApiError;
  read: () => Promise<Row | undefined>;
  reauthRequired: ApiError;
  refresh: (row: Row) => Effect.Effect<Token, OAuthRequestFailed>;
  refreshWindowMs: number;
  write: (token: Token, row: Row) => Promise<string>;
};

export async function refreshOAuthToken<Row extends OAuthAuthRow, Token>(
  store: OAuthTokenStore<Row, Token>,
): Promise<string> {
  const auth = await store.read();

  if (!auth) {
    throw store.notAuthenticated;
  }

  const outcome = await runServerEffect(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (new Date(auth.expires_at).getTime() - store.refreshWindowMs > now) {
        return { kind: "fresh" as const, token: auth.access_token };
      }

      const data = yield* store.refresh(auth);

      return { data, kind: "refreshed" as const };
    }).pipe(Effect.result),
  );

  if (Result.isFailure(outcome)) {
    if (!outcome.failure.invalidGrant) {
      throw outcome.failure.cause;
    }

    const current = await store.read();

    if (
      current &&
      (current.refresh_token ?? current.access_token) !== (auth.refresh_token ?? auth.access_token)
    ) {
      return current.access_token;
    }

    await store.clear();
    throw store.reauthRequired;
  }

  if (outcome.success.kind === "fresh") {
    return outcome.success.token;
  }

  return store.write(outcome.success.data, auth);
}
