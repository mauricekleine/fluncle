// The typed-confirmation gate for the Delete account dialog (the Fence Ladder's
// rule: a destructive act is gated). The user must type their username to arm the
// button — or the literal "delete" when the account has no username yet. Pure, so
// the gate is unit-tested without mounting the dialog.

/**
 * Whether the typed confirmation matches: the account's username (case-insensitive,
 * trimmed), or the literal "delete" when there is no username. An empty input never
 * matches, so the destructive button stays disabled until the user has typed the word.
 */
export function deleteConfirmationMatches(input: string, username: string | undefined): boolean {
  const typed = input.trim().toLowerCase();

  if (typed.length === 0) {
    return false;
  }

  const target = (username?.trim() ? username : "delete").toLowerCase();

  return typed === target;
}

/** The word the dialog asks the user to type (the username, or "delete" when there is none). */
export function deleteConfirmationWord(username: string | undefined): string {
  return username?.trim() ? username : "delete";
}
