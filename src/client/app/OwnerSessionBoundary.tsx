import {
  Fragment,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ownerSession } from "../ownerSession";
import { executionSourceId } from "../sourceRouting";
import { workspaceLink } from "../../shared/workspace-links";
import { readAppNavigation, type AppNavigationInitial } from "./Navigation";
import { useOwnerSession } from "./Session";

export function OwnerSessionBoundary({
  children,
}: {
  children(initial: AppNavigationInitial): ReactNode;
}) {
  const { generation } = useOwnerSession();
  const [entry] = useState(() => ({
    navigation: readAppNavigation(),
    firstOwnerGeneration:
      ownerSession.current.generation + Number(!ownerSession.current.owner),
  }));
  const initial = useMemo(
    () =>
      generation <= entry.firstOwnerGeneration
        ? entry.navigation
        : readAppNavigation(
            new URL(
              workspaceLink({ source: executionSourceId() }),
              location.origin,
            ),
          ),
    [entry, generation],
  );
  useLayoutEffect(() => {
    if (generation > entry.firstOwnerGeneration)
      history.replaceState(
        history.state,
        "",
        workspaceLink({ source: executionSourceId() }),
      );
  }, [entry, generation]);
  // Keep the entry link across the initial authentication remount, but never
  // give it to a replacement owner. Same-owner metadata retains the controller.
  return <Fragment key={generation}>{children(initial)}</Fragment>;
}
