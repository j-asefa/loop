// Every text field declares what it holds. Without these hints iOS Safari
// guesses from labels and placeholders, and may offer contact AutoFill in
// place of autocorrect. Fields that want real AutoFill (sign-in name, email,
// password) declare their autocomplete token instead.

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
