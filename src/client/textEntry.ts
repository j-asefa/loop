// Every text field declares what it holds. Fields that want real AutoFill
// (sign-in name, email, password) declare their autocomplete token instead.
// iOS Safari ignores autocomplete="off" when it guesses a field is a contact
// field from its label, name or placeholder, so keep words like "first",
// "initial" and "name", and "@" handles that read as email addresses, out of
// those on fields that are not contact details.

/** Sentences people write: messages, notes, names and titles. */
export const proseEntry = {
  autoComplete: "off",
  autoCorrect: "on",
  autoCapitalize: "sentences",
  spellCheck: true,
} as const;

/** Exact text: searches, handles, URLs, paths, code, keys and codes. */
export const literalEntry = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
} as const;
