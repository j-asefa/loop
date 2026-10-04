/** Shared change totals for pull request lists, details, and result cards. */
export function PullChangeCounts({
  changedFiles,
  additions,
  deletions,
}: {
  changedFiles?: number;
  additions?: number;
  deletions?: number;
}) {
  return (
    <span className="pull-change-counts">
      {changedFiles !== undefined && (
        <span className="pull-changed-files">
          {changedFiles} file{changedFiles === 1 ? "" : "s"}
        </span>
      )}
      {additions !== undefined && (
        <span
          className="diff-add-count"
          aria-label={`${additions} lines added`}
        >
          +{additions}
        </span>
      )}
      {deletions !== undefined && (
        <span
          className="diff-remove-count"
          aria-label={`${deletions} lines removed`}
        >
          −{deletions}
        </span>
      )}
    </span>
  );
}
