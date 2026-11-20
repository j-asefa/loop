import rehypeKatex from "rehype-katex";
import type { PluggableList } from "unified";
import { remarkChatMath } from "../shared/remark-chat-math";
import "katex/dist/katex.min.css";

export const mathPlugins: { remark: PluggableList; rehype: PluggableList } = {
  remark: [remarkChatMath],
  rehype: [
    [
      rehypeKatex,
      {
        trust: false,
        maxSize: 20,
        maxExpand: 1000,
        errorColor: "var(--muted)",
      },
    ],
  ],
};
