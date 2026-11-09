import { useId, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  type LucideIcon,
} from "lucide-react";

/**
 * Shared settings presentation. Every settings page uses these so state reads
 * the same way: an icon, a label, one short description, the current state and
 * a single next action. Longer explanations belong in a row that opens them,
 * not in a paragraph above the controls.
 */

type SettingsTone = "ready" | "attention" | "muted";

/** A state label: a coloured dot plus a word. Colour never carries meaning alone. */
export function SettingsPill({
  tone = "muted",
  quiet = false,
  children,
}: {
  tone?: SettingsTone;
  quiet?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={
        "settings-pill" +
        (tone === "muted" ? "" : " " + tone) +
        (quiet ? " quiet" : "")
      }
    >
      {children}
    </span>
  );
}

/** A bordered group of rows. */
export function SettingsList({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div
      className="settings-list"
      role={label ? "group" : undefined}
      aria-label={label}
    >
      {children}
    </div>
  );
}

export function SettingsRow({
  icon: Icon,
  title,
  description,
  state,
  onClick,
  disabled,
  wrap = false,
  ariaLabel,
  children,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  state?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  wrap?: boolean;
  ariaLabel?: string;
  children?: ReactNode;
}) {
  const className =
    "settings-row" +
    (Icon ? "" : " no-icon") +
    (state ? " has-state" : "") +
    (onClick ? "" : " no-chevron") +
    (wrap ? " wrap" : "");
  const content = (
    <>
      {Icon && (
        <span className="settings-row-icon">
          <Icon size={20} aria-hidden="true" />
        </span>
      )}
      <span>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </span>
      {state}
      {onClick && <ChevronRight size={18} aria-hidden="true" />}
      {children}
    </>
  );
  if (!onClick)
    return (
      <div className={className} aria-label={ariaLabel}>
        {content}
      </div>
    );
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {content}
    </button>
  );
}

/**
 * A labelled switch. This is a real checkbox so the label association, keyboard
 * behavior and accessible name match the control it replaced.
 */
export function SettingsToggle({
  icon: Icon,
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={"settings-toggle" + (Icon ? "" : " no-icon")}>
      {Icon && (
        <span className="settings-row-icon">
          <Icon size={20} aria-hidden="true" />
        </span>
      )}
      <span>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </span>
      <input
        type="checkbox"
        className="settings-switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** Context attached to the control it qualifies. */
export function SettingsNote({
  icon: Icon,
  tone = "muted",
  title,
  children,
  role,
}: {
  icon?: LucideIcon;
  tone?: SettingsTone;
  title?: ReactNode;
  children?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div
      className={"settings-note-card" + (tone === "muted" ? "" : " " + tone)}
      role={role}
    >
      {Icon && <Icon size={18} aria-hidden="true" />}
      <div>
        {title && <strong>{title}</strong>}
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}

export function SettingsSteps({ children }: { children: ReactNode }) {
  return <ol className="settings-steps">{children}</ol>;
}

/**
 * A single copyable command. Long setup output stays collapsed until asked for
 * so the form below it remains reachable.
 */
export function SettingsCommand({
  title,
  command,
  copyLabel = "Copy",
}: {
  title: string;
  command: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  const long = command.split("\n").length > 3;
  return (
    <div className="settings-command">
      <div className="settings-command-head">
        <strong>{title}</strong>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
              setCopied(true);
              setError("");
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setError(
                "Could not copy. Select the command above to copy it manually.",
              );
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : copyLabel}
        </button>
      </div>
      <pre id={id} className={long && !expanded ? "clipped" : undefined}>
        {command}
      </pre>
      {long && (
        <button
          type="button"
          className="text-button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide full command" : "Show full command"}
          <ChevronDown
            size={14}
            aria-hidden="true"
            style={expanded ? { transform: "rotate(180deg)" } : undefined}
          />
        </button>
      )}
      {error && (
        <p role="alert" className="field-hint">
          {error}
        </p>
      )}
    </div>
  );
}

export function SettingsEmpty({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="settings-empty">
      <span className="settings-empty-mark">
        <Icon size={24} aria-hidden="true" />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function SettingsSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="drawer-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsProgress({
  value,
  total,
  running,
  label,
}: {
  value: number;
  total: number;
  running?: boolean;
  label: string;
}) {
  const percent =
    total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div
      className={"settings-progress" + (running ? " running" : "")}
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={total}
    >
      <span style={{ width: percent + "%" }} />
    </div>
  );
}

/** A section heading with an optional action on the right. */
export function SettingsSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="settings-navigation" aria-labelledby={id}>
      <div className="settings-section-head">
        <h3 id={id}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
