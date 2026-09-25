export function deleteConfirmationMatches(input: string, username: string | undefined): boolean {
  const typed = input.trim().toLowerCase();

  if (typed.length === 0) {
    return false;
  }

  const target = (username?.trim() ? username : "delete").toLowerCase();

  return typed === target;
}

export function deleteConfirmationWord(username: string | undefined): string {
  return username?.trim() ? username : "delete";
}
