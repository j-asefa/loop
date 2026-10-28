import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Layers,
  MousePointer2,
} from "lucide-react";
import { Sheet } from "./components";
import type { Action } from "./ThreadTools";

function MenuAction({
  action,
  onClose,
  className = "",
  compact = false,
}: {
  action: Action;
  onClose: () => void;
  className?: string;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={action.label}
      className={`done-menu-action ${action.danger ? "danger " : ""}${className}`}
      disabled={action.disabled}
      onClick={() => {
        onClose();
        action.onSelect();
      }}
    >
      <span className="done-menu-icon" aria-hidden="true">
        {action.icon}
      </span>
      <span className="done-menu-label">
        <span>
          {compact &&
          action.id === "save" &&
          action.label === "Remove from Saved"
            ? "Saved"
            : action.label}
        </span>
        {!compact && action.hint && <small>{action.hint}</small>}
      </span>
      {!compact && (
        <ChevronRight
          size={16}
          className="done-menu-chevron"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export function DoneCardMenu({
  title,
  subtitle,
  threadCount,
  actions,
  onClose,
}: {
  title: string;
  subtitle: string;
  threadCount?: number;
  actions: Action[];
  onClose: () => void;
}) {
  const quick = actions.filter((action) =>
    ["reply", "save", "later"].includes(action.id),
  );
  const combine = actions.find((action) => action.id === "combine");
  const organize = actions.filter((action) =>
    ["select-cards", "move-to"].includes(action.id),
  );
  const remove = actions.find(
    (action) => action.id === "remove-done" || action.id === "ungroup",
  );
  const rest = actions.filter(
    (action) =>
      !quick.includes(action) &&
      action !== combine &&
      !organize.includes(action) &&
      action !== remove,
  );
  return (
    <Sheet
      title={title}
      onClose={onClose}
      className="action-sheet done-menu done-card-menu"
      heading={
        <div className="done-menu-heading">
          <span className="done-menu-eyebrow">
            {threadCount ? <Layers size={13} /> : <Check size={13} />}
            {threadCount ? `Thread · ${threadCount} cards` : "Done card"}
          </span>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      }
    >
      {!!quick.length && (
        <div className="done-menu-quick" role="menu" aria-label="Quick actions">
          {quick.map((action) => (
            <MenuAction
              key={action.id}
              action={action}
              onClose={onClose}
              compact
              className={
                action.id === "save" && action.label === "Remove from Saved"
                  ? "is-saved"
                  : ""
              }
            />
          ))}
        </div>
      )}
      {(combine || !!organize.length) && (
        <section className="done-menu-section" aria-label="Organize cards">
          <span className="done-menu-section-label">Organize</span>
          {combine && (
            <div role="menu" aria-label="Combine cards">
              <MenuAction
                action={combine}
                onClose={onClose}
                className="done-menu-featured"
              />
            </div>
          )}
          {!!organize.length && (
            <div
              className="done-menu-organize"
              role="menu"
              aria-label="Select or move cards"
            >
              {organize.map((action) => (
                <MenuAction
                  key={action.id}
                  action={action}
                  onClose={onClose}
                  compact
                />
              ))}
            </div>
          )}
        </section>
      )}
      {!!rest.length && (
        <div
          className="done-menu-secondary"
          role="menu"
          aria-label="More card actions"
        >
          {rest.map((action) => (
            <MenuAction key={action.id} action={action} onClose={onClose} />
          ))}
        </div>
      )}
      {remove && (
        <div
          className="done-menu-remove"
          role="menu"
          aria-label="Remove grouping or card"
        >
          <MenuAction action={remove} onClose={onClose} compact />
        </div>
      )}
      {combine && (
        <p className="done-menu-tip">
          <MousePointer2 size={13} aria-hidden="true" />
          You can also hold and drag cards together.
        </p>
      )}
    </Sheet>
  );
}

export function DoneCardPicker({
  actions,
  onClose,
}: {
  actions: Action[];
  onClose: () => void;
}) {
  return (
    <Sheet
      title="Choose another card"
      onClose={onClose}
      className="action-sheet done-menu done-card-picker"
      heading={
        <div className="done-menu-heading">
          <span className="done-menu-eyebrow">
            <Layers size={13} />
            Combine cards
          </span>
          <h2>Choose another card</h2>
          <p>Bring related results into one conversation.</p>
        </div>
      }
    >
      <div
        className="done-menu-candidates"
        role="menu"
        aria-label="Available Done cards"
      >
        {actions.map((action) => (
          <MenuAction
            key={action.id}
            action={{ ...action, icon: <ArrowUpRight size={19} /> }}
            onClose={onClose}
          />
        ))}
      </div>
    </Sheet>
  );
}
