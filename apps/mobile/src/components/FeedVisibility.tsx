import { createContext, useContext } from "react";
import { relativeTime } from "../fixtures";

export const FeedVisibilityContext = createContext(true);

export function FeedTime({
  timestamp,
  prefix = "",
}: {
  timestamp: number;
  prefix?: string;
}) {
  // A tab change refreshes the label without rendering the surrounding card.
  useContext(FeedVisibilityContext);
  return prefix + relativeTime(timestamp);
}
