const CSRF_HEADER = "x-fluncle-csrf";

const SIGN_IN_PATH = "/account";

function goSignIn(): void {
  window.location.href = SIGN_IN_PATH;
}

export function csrfJsonHeaders(token: string): Record<string, string> {
  return { "Content-Type": "application/json", [CSRF_HEADER]: token };
}

export async function fetchCsrfToken(options?: {
  onLapsedSession?: "ignore" | "redirect";
}): Promise<string | undefined> {
  const response = await fetch("/api/v1/me/csrf");

  if (options?.onLapsedSession === "ignore") {
    if (!response.ok) {
      return undefined;
    }
  } else if (response.status === 401) {
    goSignIn();

    return undefined;
  }

  const { csrfToken } = (await response.json()) as { csrfToken?: string };

  return csrfToken ?? "";
}

export async function authedJsonFetch(
  path: string,
  init: Omit<RequestInit, "headers">,
): Promise<Response | undefined> {
  const token = await fetchCsrfToken();

  if (token === undefined) {
    return undefined;
  }

  const response = await fetch(path, { ...init, headers: csrfJsonHeaders(token) });

  if (response.status === 401) {
    goSignIn();

    return undefined;
  }

  return response;
}
