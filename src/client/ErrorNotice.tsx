import type { HTMLAttributes } from "react";

export function ErrorNotice({
  as: Tag = "p",
  className = "error",
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "p" | "div" | "span" }) {
  return <Tag className={className} {...props} />;
}
