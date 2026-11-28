import { useEffect, useState } from "react";
import { ArrowUpRight, FolderInput } from "lucide-react";
import { workspaceApi } from "../shared/workspace-api";
import { readRoute } from "./api";
import type { Action } from "./components";

export function useResultWorkActions(
  message: string | null | undefined,
  source: string,
): Action[] {
  const [result, setResult] = useState<{
    message: string;
    source: string;
    projectId: string;
    beadId: string | null;
  }>();
  useEffect(() => {
    if (!message) return;
    const controller = new AbortController();
    void readRoute(
      workspaceApi.resultWork,
      { params: { message } },
      source,
      controller.signal,
    )
      .then((target) => {
        if (!controller.signal.aborted)
          setResult(target ? { ...target, message, source } : undefined);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [message, source]);

  if (!message || result?.message !== message || result.source !== source)
    return [];
  const open = (create: boolean) => {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set("page", "projects");
    url.searchParams.set("projectView", result.projectId);
    url.searchParams.set("projectTab", "work");
    if (source) url.searchParams.set("source", source);
    if (create) url.searchParams.set("beadFromMessage", message);
    else if (result.beadId) url.searchParams.set("bead", result.beadId);
    location.assign(url.href);
  };
  const actions: Action[] = [
    {
      id: "create-bead",
      label: "Create bead from result",
      icon: <FolderInput size={18} />,
      onSelect: () => open(true),
    },
  ];
  if (result.beadId)
    actions.unshift({
      id: "open-bead",
      label: "Open linked bead",
      icon: <ArrowUpRight size={18} />,
      onSelect: () => open(false),
    });
  return actions;
}
