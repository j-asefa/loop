import { literalEntry, proseEntry } from "./textEntry";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { callRoute, readRoute } from "./workspace-api";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { executionSourceId } from "./sourceRouting";
import { Sheet } from "./components";
import { Avatar } from "./Avatar";
import { ProfileCover } from "./ProfileCover";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { SHOW_LATER, type LaterSection, type ShowLater } from "./Later";

export type MyProfileData = RouteResponse<typeof workspaceApi.personalProfile>;
export type ProfileTab =
  | "messages"
  | "approvals"
  | "answers"
  | "files"
  | "social"
  | Exclude<LaterSection, "all">;
const profileTabs: [ProfileTab, string][] = [
  ["messages", "Messages"],
  ["approvals", "Approvals"],
  ["answers", "Answers"],
  ["saved", "Saved"],
  ["reminders", "Reminders"],
  ["scheduled", "Scheduled"],
  ["files", "Files"],
  ["social", "Social"],
];

/**
 * Your own profile: who you are, then messages, decisions, published files and what Later
 * holds (Saved, Reminders, Scheduled) as tabs. It opens on the tab Later
 * was last asked for, so links to a reminder or scheduled send land there.
 */
export function MyProfile({
  name,
  accountName,
  profile,
  onSaved,
  onCompose,
  hasDraft,
  messages,
  decisions,
  files,
  social,
  later,
  onAgents,
  onProjects,
}: {
  /** The name shown: your profile's, else the account's. */
  name: string;
  accountName: string;
  profile: MyProfileData | null;
  onSaved: (profile: MyProfileData) => void;
  onCompose: () => void;
  hasDraft: boolean;
  messages: ReactNode;
  decisions: (kind: "approval" | "answer") => ReactNode;
  files: ReactNode;
  social?: ReactNode;
  later: (section: Exclude<LaterSection, "all">) => ReactNode;
  /** Open agent management, from the Agents count. */
  onAgents: () => void;
  /** Open the Projects tab, from the Projects count. */
  onProjects: () => void;
}) {
  const [socialUnread, setSocialUnread] = useState<number>();
  useEffect(() => {
    const owner = viewOwner(),
      controller = new AbortController();
    let ticket = 0;
    const load = async () => {
      const current = ++ticket;
      try {
        const result = await readRoute(
          workspaceApi.socialUnread,
          {},
          "",
          controller.signal,
        );
        if (
          !controller.signal.aborted &&
          current === ticket &&
          owner === viewOwner()
        )
          setSocialUnread(result.unread);
      } catch {}
    };
    const stopChanges = listenWorkspaceChanges("social", load, "");
    void load();
    window.addEventListener("loop-social-read", load);
    return () => {
      controller.abort();
      stopChanges();
      window.removeEventListener("loop-social-read", load);
    };
  }, []);
  const [tab, setTabState] = useState<ProfileTab>(() => {
    const params = new URLSearchParams(location.search);
    const value = params.has("social")
      ? "social"
      : params.get("profileTab") || cachedView<string>("later-section");
    return profileTabs.some(([id]) => id === value)
      ? (value as ProfileTab)
      : "messages";
  });
  const setTab = (value: ProfileTab) => {
    setTabState(value);
    cacheView("later-section", value, viewOwner());
    const url = new URL(location.href);
    url.searchParams.set("profileTab", value);
    if (value !== "social") url.searchParams.delete("social");
    history.replaceState(history.state, "", url.pathname + url.search);
  };
  // "Show in Later" while your profile is already open switches the tab.
  useEffect(() => {
    const shown = (event: Event) => {
      const { section } = (event as CustomEvent<ShowLater>).detail;
      if (section !== "all") setTab(section);
    };
    window.addEventListener(SHOW_LATER, shown);
    return () => {
      window.removeEventListener(SHOW_LATER, shown);
    };
  }, []);
  const [editing, setEditing] = useState(false);
  const counts = profile?.counts;
  return (
    <section className="my-profile" aria-label="Your profile">
      <header className="my-profile-card">
        <ProfileCover name={name} />
        <div className="my-profile-top">
          <Avatar name={name} className="my-profile-avatar" expandable />
          <div className="my-profile-actions">
            <button
              type="button"
              className="secondary my-profile-edit"
              onClick={() => setEditing(true)}
            >
              Edit profile
            </button>
            <button
              type="button"
              className={
                "primary my-profile-compose" + (hasDraft ? " has-draft" : "")
              }
              aria-label="Compose a message"
              title={hasDraft ? "Continue draft" : "Compose a message"}
              onClick={onCompose}
            >
              <Plus size={20} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="my-profile-name">
          <h1>{name}</h1>
          <span className="personal-you">You</span>
        </div>
        <p className="my-profile-handle">
          {profile?.handle ? "@" + profile.handle + " · " : ""}Personal
          workspace
        </p>
        {profile?.bio && <p className="my-profile-bio">{profile.bio}</p>}
        {/* Each count goes to what it counts: your messages below, agent
            management, and Projects. */}
        <div className="my-profile-counts">
          {(
            [
              ["messages", "Messages", () => setTab("messages")],
              ["agents", "Agents", onAgents],
              ["projects", "Projects", onProjects],
            ] as const
          ).map(([key, label, open]) => (
            <button key={key} type="button" onClick={open}>
              <strong>{counts ? counts[key] : "–"}</strong>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </header>
      <div className="my-profile-tabs" role="tablist" aria-label="Show">
        {profileTabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            <span>{label}</span>
            {id === "social" && !!socialUnread && (
              <span className="chip-count">{socialUnread}</span>
            )}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        aria-label={profileTabs.find(([id]) => id === tab)?.[1]}
      >
        {tab === "messages"
          ? messages
          : tab === "approvals" || tab === "answers"
            ? decisions(tab === "approvals" ? "approval" : "answer")
            : tab === "files"
              ? files
              : tab === "social"
                ? social
                : later(tab)}
      </div>
      {editing && (
        <EditProfile
          profile={profile}
          accountName={accountName}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            onSaved(saved);
            setEditing(false);
          }}
        />
      )}
    </section>
  );
}

function EditProfile({
  profile,
  accountName,
  onClose,
  onSaved,
}: {
  profile: MyProfileData | null;
  accountName: string;
  onClose: () => void;
  onSaved: (profile: MyProfileData) => void;
}) {
  const [displayName, setDisplayName] = useState(profile?.display_name || "");
  const [handle, setHandle] = useState(profile?.handle || "");
  const [bio, setBio] = useState(profile?.bio || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(""), [displayName, handle, bio]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      onSaved(
        await callRoute(
          workspaceApi.personalProfileUpdate,
          {
            body: { display_name: displayName, handle, bio },
          },
          executionSourceId(),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Edit profile" onClose={onClose}>
      <form onSubmit={save}>
        <label>
          Name
          <input
            {...proseEntry}
            value={displayName}
            maxLength={80}
            placeholder={accountName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <p className="field-hint">Leave empty to use your account name.</p>
        <label>
          Handle
          <input
            {...literalEntry}
            value={handle}
            maxLength={31}
            placeholder="@handle"
            onChange={(e) => setHandle(e.target.value)}
          />
        </label>
        <p className="field-hint">2–30 letters, numbers or underscores.</p>
        <label>
          Bio
          <textarea
            {...proseEntry}
            value={bio}
            maxLength={200}
            rows={3}
            placeholder="A line about you"
            onChange={(e) => setBio(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save profile"}
        </button>
      </form>
    </Sheet>
  );
}
