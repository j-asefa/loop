import { Avatar } from "./components";
import { modelDisplayName } from "./modelChoices";

export function ResultIdentity({
  name,
  model,
  createdAt,
  onProfile,
}: {
  name?: string;
  model?: string;
  createdAt: number;
  onProfile?: () => void;
}) {
  const content = (
    <>
      <Avatar name={name || "Loop55"} />
      <span className="result-author">
        <span className="result-author-name" role="heading" aria-level={2}>
          {name ? "@" + name : "Saved result"}
        </span>
        <span className="result-author-details">
          {model && <span>{modelDisplayName({ id: model, name: model })}</span>}
          <time dateTime={new Date(createdAt).toISOString()}>
            {new Date(createdAt).toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
            })}
          </time>
        </span>
      </span>
    </>
  );
  return onProfile ? (
    <button
      className="result-identity"
      aria-label={`Open @${name} profile`}
      onClick={onProfile}
    >
      {content}
    </button>
  ) : (
    <div className="result-identity">{content}</div>
  );
}
