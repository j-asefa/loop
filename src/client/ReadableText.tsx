import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createReadableText,
  readableAuthor,
  readableText,
  type DisplayAgent,
} from "../shared/readable-text";

const ReadableTextContext = createContext({
  text: readableText,
  author: (id: string) => readableAuthor(id),
});
export const useReadableText = () => useContext(ReadableTextContext).text;
export const useReadableAuthor = () => useContext(ReadableTextContext).author;

/** Names stay within the owning workspace's component tree. */
export function ReadableTextProvider({
  agents,
  children,
}: {
  agents: readonly DisplayAgent[];
  children: ReactNode;
}) {
  const format = useMemo(
    () => ({
      text: createReadableText(agents),
      author: (id: string) => readableAuthor(id, agents),
    }),
    [agents],
  );
  return (
    <ReadableTextContext.Provider value={format}>
      {children}
    </ReadableTextContext.Provider>
  );
}
