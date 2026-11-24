import { useEffect, useState } from "react";
import { snippetTitle } from "../shared/workshop-actions";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { callRoute, readRoute } from "./api";
import { emitClientEvent, listenClientEvent } from "./clientEvents";
import { notify } from "./toast";
import { viewGeneration, viewOwner } from "./viewCache";

export type SavedSnippet = RouteResponse<
  typeof workspaceApi.snippetList
>["items"][number];

/**
 * Loads the signed-in owner's saved `/` snippets for quick-action sheets.
 * Isolated by owner and view generation so snippets never leak across accounts.
 */
export function useSnippets(enabled: boolean) {
  const generation = viewGeneration();
  const owner = viewOwner();
  const scopeKey = JSON.stringify([generation, owner]);
  const [state, setState] = useState<{
    scope: string;
    items: SavedSnippet[];
    loading: boolean;
  }>({ scope: scopeKey, items: [], loading: false });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let activeController: AbortController | null = null;
    const load = () => {
      if (!active || generation !== viewGeneration() || owner !== viewOwner())
        return;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      setState((prev) => ({
        scope: scopeKey,
        items: prev.scope === scopeKey ? prev.items : [],
        loading: prev.scope !== scopeKey || prev.items.length === 0,
      }));
      void readRoute(workspaceApi.snippetList, {}, "", controller.signal)
        .then(({ items }) => {
          if (
            !active ||
            controller.signal.aborted ||
            generation !== viewGeneration() ||
            owner !== viewOwner()
          )
            return;
          setState({ scope: scopeKey, items, loading: false });
        })
        .catch(() => {
          if (
            !active ||
            controller.signal.aborted ||
            generation !== viewGeneration() ||
            owner !== viewOwner()
          )
            return;
          setState((prev) => ({
            scope: scopeKey,
            items: prev.scope === scopeKey ? prev.items : [],
            loading: false,
          }));
        });
    };
    load();
    const stop = listenClientEvent("loop-snippets-change", load);
    return () => {
      active = false;
      activeController?.abort();
      stop();
    };
  }, [enabled, scopeKey, generation, owner]);

  return {
    snippets: state.scope === scopeKey ? state.items : [],
    loading: state.scope === scopeKey ? state.loading : false,
  };
}

/**
 * Saves arbitrary prompt text as a reusable `/` snippet using Loop's canonical
 * artifact creation endpoint and notifies listeners so autocomplete and
 * quick-action sheets refresh immediately.
 */
export async function saveTextAsSnippet(
  content: string,
  source = "",
): Promise<boolean> {
  const text = content.trim();
  if (!text) return false;
  try {
    await callRoute(
      workspaceApi.artifactCreate,
      {
        body: {
          title: snippetTitle(text),
          content: text,
          kind: "markdown",
          metadata: { snippet: true },
        },
      },
      source,
    );
    emitClientEvent("loop-snippets-change");
    notify({
      text: "Saved as a snippet. Type / in any composer to insert it.",
    });
    return true;
  } catch (error) {
    notify({
      text: (error as Error).message || "Could not save snippet.",
      tone: "error",
    });
    return false;
  }
}
