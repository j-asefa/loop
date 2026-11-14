import { expect, it } from "vitest";
import { runMatchesScope } from "../src/client/runScope";
import { PublicFolder } from "../src/shared/workspace-contract-schemas";
import { writeRunPayload } from "../src/shared/run-payload";
const folders = [
  {
    id: "workspace",
    name: "Workspace",
    parent_id: null,
    kind: "folder",
    is_workspace: true,
  },
  { id: "project", name: "Project", parent_id: "workspace", kind: "project" },
  { id: "child", name: "Child", parent_id: "project", kind: "folder" },
  { id: "other", name: "Other", parent_id: "workspace", kind: "project" },
].map((folder) => PublicFolder.parse(folder));
it("requires both selected team and project membership using the shared reader", () => {
  const payload = writeRunPayload({ teamId: "team", folderId: "child" });
  expect(runMatchesScope(payload, ["team"], "project", folders)).toBe(true);
  expect(runMatchesScope(payload, ["other-team"], "project", folders)).toBe(
    false,
  );
  expect(runMatchesScope(payload, ["team"], "other", folders)).toBe(false);
  expect(runMatchesScope(payload, [], "project", folders)).toBe(true);
  expect(runMatchesScope(payload, ["team"], "", folders)).toBe(true);
  expect(runMatchesScope(payload, [], "workspace", folders)).toBe(false);
});
it.each([
  "not JSON",
  "null",
  '{"teamId":4}',
  '{"teamId":"team","folderId":"child","undeclared":true}',
])("uses fallback membership for unreadable payloads: %s", (payload) => {
  expect(runMatchesScope(payload, ["team"], "project", folders)).toBe(false);
  expect(runMatchesScope(payload, [], "project", folders)).toBe(false);
  // Existing empty-payload behavior: unfiltered and default-workspace views
  // include unscoped runs, while a team/project selection excludes them.
  expect(runMatchesScope(payload, [], "", folders)).toBe(true);
  expect(runMatchesScope(payload, [], "workspace", folders)).toBe(true);
});
