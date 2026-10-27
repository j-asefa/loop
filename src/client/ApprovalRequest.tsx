import { parse } from "./api";
import { RichText } from "./components";

// GitHub writes from the official GitHub connection. The approval shows the
// exact target and arguments; the broker refuses merges without a head SHA.
const GITHUB_TITLES: Record<string, string> = {
  pull_request_review_write: "Write a pull request review",
  merge_pull_request: "Merge a pull request",
  create_pull_request: "Open a pull request",
  update_pull_request: "Edit a pull request",
  update_pull_request_branch: "Update a pull request branch",
  add_issue_comment: "Comment on GitHub",
  add_reply_to_pull_request_comment: "Reply to a review comment",
  add_comment_to_pending_review: "Add a review comment",
  push_files: "Push commits to GitHub",
  create_or_update_file: "Commit a file to GitHub",
  delete_file: "Delete a file on GitHub",
  create_branch: "Create a GitHub branch",
};
const ARGUMENT_LABELS: Record<string, string> = {
  body: "Review text",
  event: "Action",
  expectedHeadSha: "Head commit",
  merge_method: "Merge method",
  commit_title: "Commit title",
  commit_message: "Commit message",
};
const label = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());
export function describeApproval(encoded: string) {
  const request = parse<any>(encoded, {});
  const args =
    request.arguments && typeof request.arguments === "object"
      ? request.arguments
      : {};
  const title =
    request.type === "mcp_install"
      ? "Install workspace tools"
      : request.type === "workflow_review"
        ? "Review workflow output"
        : request.tool && GITHUB_TITLES[request.tool]
          ? GITHUB_TITLES[request.tool]
          : request.tool === "browser_navigate"
            ? "Open a webpage"
            : request.tool
              ? label(request.tool)
              : "Review requested action";
  const target =
    args.owner && args.repo && (args.pullNumber || args.pull_number)
      ? `${args.owner}/${args.repo} #${args.pullNumber || args.pull_number}`
      : args.owner && args.repo && args.issue_number
        ? `${args.owner}/${args.repo} #${args.issue_number}`
        : request.tool === "create_pull_request" && args.owner && args.repo
          ? `${args.owner}/${args.repo}: ${args.head} → ${args.base}`
          : [args.url, args.path, args.command, args.query].find(
              (v) => typeof v === "string",
            );
  return { request, title, args, target };
}

export function ApprovalRequestDetails({
  request,
  heading = false,
}: {
  request: string;
  heading?: boolean;
}) {
  const detail = describeApproval(request);
  return (
    <>
      {heading && <h3>{detail.title}</h3>}
      {detail.request.message && (
        <p className="approval-description">{detail.request.message}</p>
      )}
      {detail.target && <p className="approval-target">{detail.target}</p>}
      {!!Object.keys(detail.args).length && (
        <dl className="approval-arguments">
          {Object.entries(detail.args)
            .filter(
              ([key]) =>
                !(
                  detail.request.tool === "pull_request_review_write" &&
                  detail.target &&
                  ["owner", "repo", "pullNumber", "pull_number"].includes(key)
                ) && !(key === "url" && detail.target === detail.args.url),
            )
            .map(([key, value]) => (
              <div key={key}>
                <dt>
                  {key === "body" &&
                  detail.request.tool !== "pull_request_review_write"
                    ? "Text"
                    : ARGUMENT_LABELS[key] ||
                      (key.toLowerCase() === "url" ? "URL" : label(key))}
                </dt>
                <dd>
                  <pre>
                    {key === "event" && value === "COMMENT"
                      ? "Post review comments"
                      : key === "event" && value === "APPROVE"
                        ? "Approve the pull request"
                        : key === "event" && value === "REQUEST_CHANGES"
                          ? "Request changes"
                          : typeof value === "string"
                            ? value
                            : typeof value === "boolean"
                              ? value
                                ? "Yes"
                                : "No"
                              : Array.isArray(value) &&
                                  value.every(
                                    (item) => typeof item === "string",
                                  )
                                ? value.join("\n")
                                : JSON.stringify(value, null, 2)}
                  </pre>
                </dd>
              </div>
            ))}
        </dl>
      )}
      {detail.request.config && (
        <div className="approval-config">
          <h4>Tools to install</h4>
          <pre>{JSON.stringify(detail.request.config, null, 2)}</pre>
        </div>
      )}
      {detail.request.content && (
        <div className="approval-output">
          <RichText content={detail.request.content} />
        </div>
      )}
    </>
  );
}
