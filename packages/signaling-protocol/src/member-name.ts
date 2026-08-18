/**
 * Member names come from a machine's hostname, but they arrive over the wire
 * like everything else and are shown to every other member. This is the one
 * place they are cleaned, so the server and the client cannot disagree about
 * what a name is.
 */

/** NetBIOS names stop at 15 characters and DNS labels at 63. 32 fits both uses. */
export const MAX_NAME_LENGTH = 32;

/** C0 and C1 control characters, which no computer name legitimately contains. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeName(raw: string): string | null {
  // Control characters are stripped rather than rejected: a name is a label,
  // not a credential, and refusing a whole join over an escape sequence would
  // strand a machine whose hostname we cannot fix.
  const cleaned = raw.replace(CONTROL_CHARACTERS, "").trim().slice(0, MAX_NAME_LENGTH);
  return cleaned.length === 0 ? null : cleaned;
}
