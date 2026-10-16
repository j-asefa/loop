import type { BriefGenerationUsage } from "../shared/brief-usage";
import "./briefTokenUsage.css";

const outcomes = {
  published: "Brief updated",
  unchanged: "No changes to the brief",
  failed: "Generation failed",
  discarded: "Generation discarded",
};

export function BriefTokenUsage({
  usage,
  recorded,
  statusCard = false,
}: {
  usage?: BriefGenerationUsage | null;
  recorded: boolean;
  statusCard?: boolean;
}) {
  if (!usage && !recorded) return null;
  const partial = !!usage && usage.reported_attempts < usage.attempts;
  const count = usage?.total_tokens;
  return (
    <details className="brief-token-usage">
      <summary>
        Brief generation ·{" "}
        {count == null
          ? "Token usage unavailable"
          : `${partial ? "At least " : ""}${count.toLocaleString()} tokens`}
      </summary>
      <div>
        {usage ? (
          <>
            <p>
              Latest generation ·{" "}
              <time dateTime={new Date(usage.at).toISOString()}>
                {new Date(usage.at).toLocaleString()}
              </time>
            </p>
            <p>
              {outcomes[usage.outcome]}
              {usage.model ? ` · ${usage.model}` : ""}
            </p>
            {count != null && (
              <dl>
                <div>
                  <dt>Input tokens</dt>
                  <dd>{usage.input_tokens?.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Output tokens</dt>
                  <dd>{usage.output_tokens?.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Total tokens</dt>
                  <dd>{count.toLocaleString()}</dd>
                </div>
              </dl>
            )}
            <p>
              {usage.attempts} {usage.attempts === 1 ? "request" : "requests"},
              including retries.
            </p>
            {partial && (
              <p>
                Usage reported for {usage.reported_attempts} of {usage.attempts}{" "}
                requests. The total may be incomplete.
              </p>
            )}
            {count != null && (
              <p>
                Input includes cached tokens; output includes reasoning tokens
                when reported.
              </p>
            )}
            {count == null && (
              <p>
                {usage.attempts
                  ? "The provider did not report token usage for this generation."
                  : "No model request was made."}
              </p>
            )}
          </>
        ) : (
          <p>Token usage was not recorded for this brief.</p>
        )}
        {statusCard && (
          <p>
            This card uses the project brief. Displaying it makes no additional
            model request.
          </p>
        )}
      </div>
    </details>
  );
}
