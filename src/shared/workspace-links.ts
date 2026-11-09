export type WorkspaceLinkTarget = {
  source?: string | null;
  conversation?: string | null;
  message?: string | null;
  agent?: string | null;
  artifact?: string | null;
  social?: string | null;
  page?: "profile";
  memory?: string | null;
};

export function workspaceLink(target: WorkspaceLinkTarget, pathname = "/") {
  const query = Object.entries(target)
    .filter(([, value]) => !!value)
    .map(([key, value]) => `${key}=${encodeURIComponent(value!)}`)
    .join("&");
  return pathname + (query ? "?" + query : "");
}

export function downloadLink(target: {
  artifactId: string;
  objectId?: string | null;
  published: boolean;
}) {
  return target.objectId
    ? "/api/objects/" + encodeURIComponent(target.objectId)
    : target.published
      ? "/api/artifacts/" + encodeURIComponent(target.artifactId) + "/file"
      : null;
}
