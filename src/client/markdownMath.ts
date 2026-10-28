import { useEffect, useState } from "react";
import type { PluggableList } from "unified";

type MathPlugins = { remark: PluggableList; rehype: PluggableList };
let loaded: MathPlugins | undefined;
let pending: Promise<MathPlugins> | undefined;

// One shared download, including the stylesheet and local fonts. Keep this
// module free of runtime imports from the math renderer so ordinary messages
// don't pull KaTeX into the application entry chunk.
export function loadMarkdownMath(): Promise<MathPlugins> {
  return (pending ??= import("./mathPlugins").then(
    (module) => (loaded = module.mathPlugins),
  ));
}

export function useMarkdownMath(content: string) {
  // This is only a loading hint. The Markdown parser owns delimiter matching,
  // escaping and code boundaries. False positives (such as prices) are harmless.
  const candidate = /\$|(?:`{3,}|~{3,})[ \t]*math\b/.test(content);
  const [plugins, setPlugins] = useState(() => loaded);
  useEffect(() => {
    if (!candidate || plugins) return;
    let active = true;
    void loadMarkdownMath().then(
      (value) => {
        if (active) setPlugins(value);
      },
      () => {
        // A disconnected phone can keep reading the original Markdown.
        // Reloading the app can retry; never blank the surrounding message.
      },
    );
    return () => {
      active = false;
    };
  }, [candidate, plugins]);
  return candidate ? plugins : undefined;
}
