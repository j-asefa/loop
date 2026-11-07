import type { ReactNode } from "react";

/**
 * Wraps a text field that follows text Loop does not write: agent messages,
 * questions, titles. Safari guesses contact fields by scanning up to 500
 * characters of visible text before the field, ignoring autocomplete="off",
 * and stops at the nearest form or form control. This fieldset is that stop,
 * so an agent ending with "…first?" does not make the reply a name field.
 * It takes no layout or accessible group of its own.
 */
export function AutofillBoundary({ children }: { children: ReactNode }) {
  return <fieldset className="autofill-boundary">{children}</fieldset>;
}
