import { expect, it } from "vitest";
import { createdPullRequest } from "../src/shared/pr-command";
it.each([
  "echo 'gh pr create --fill'",
  "git push && echo 'gh pr create --fill'",
  "false || gh pr create --fill",
  "gh pr create --fill; echo https://github.com/acme/api/pull/42",
  "echo $(gh pr create --fill)",
  '"gh pr create"',
])(
  "does not interpret quoted text or uncertain shell control flow: %s",
  (command) => {
    expect(
      createdPullRequest(command, "https://github.com/acme/api/pull/42"),
    ).toBeUndefined();
  },
);
