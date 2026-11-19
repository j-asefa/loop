import remarkMath from "remark-math";
import type {} from "remark-parse";
import type {} from "micromark-extension-math";
import type { Token } from "micromark-util-types";
import type { Plugin } from "unified";

// Single dollars are useful in agent answers, but "$5 and $10" is prose.
// Let remark-math find candidates, then reject currency at the tokenizer
// boundary. Returning nok lets Markdown parse emphasis, code and later math
// normally; replacing an already-parsed math node with text would swallow them.
export const remarkChatMath: Plugin = function () {
  remarkMath.call(this);
  // remark-math creates a fresh extension (including its text construct) for
  // this processor. Wrap only that extension, never a shared parser construct.
  const extension = this.data().micromarkExtensions!.at(-1)!;
  const constructs = extension.text![36]!;
  for (const construct of Array.isArray(constructs)
    ? constructs
    : [constructs]) {
    const tokenize = construct.tokenize;
    construct.tokenize = function (effects, ok, nok) {
      let candidate: Token | undefined;
      return tokenize.call(
        this,
        {
          ...effects,
          enter: (...args) => {
            const token = effects.enter(...args);
            if (token.type === "mathText") candidate = token;
            return token;
          },
        },
        (code) => {
          const raw = candidate ? this.sliceSerialize(candidate) : "";
          if (
            !raw.startsWith("$$") &&
            (/^\$\s|\s\$$|`/.test(raw) ||
              (code !== null && code >= 48 && code <= 57))
          )
            return nok(code);
          return ok(code);
        },
        nok,
      );
    };
  }
};
