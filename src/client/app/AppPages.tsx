import { sessionDraft } from "../workspace-drafts";
import { PersonalProfile } from "../PersonalProfile";
import { PersonalFiles } from "../PersonalFiles";
import { Social } from "../Social";
import { MyProfile } from "../MyProfile";
import { PersonalDecisions } from "../PersonalDecisions";
import { agentModelName } from "../modelChoices";
import { UploadButton } from "../Attachments";
import { capabilities } from "../capabilities";
import { executionSourceId } from "../sourceRouting";
import { NativeDecisions, WorkspaceConnection } from "../NativeControls";
import { FleetAuthorityNotice } from "../FleetContext";
import { BrowserBuildStatus } from "../BuildStatus";
import { YourAgents } from "../YourAgents";
import { ProfileCover } from "../ProfileCover";
import { AgentWork } from "../AgentWork";
import { agentStatusLine } from "../agentStatusLine";
import { belongsToProject } from "../../shared/projects";
import { ProjectFiles } from "../ProjectFiles";
import { ProjectActivity } from "../ProjectActivity";
import { ProjectSearchResults, Projects } from "../Projects";
import { Traces } from "../Traces";
import { AgentMailThreads } from "../AgentMail";
import { AgentMessages } from "../AgentMessages";
import { afterSheetsClose } from "../sheetHistory";
import { TeamFilter, ProfileTeams, TeamManagerShortcut } from "../Teams";
import { Approvals } from "../Approvals";
import { PullRequests } from "../PullRequests";
import { Feed } from "../Feed";
import { Later, SavedList } from "../Later";
import { ScheduledSends } from "../ThreadTools";
import {
  RefreshCw,
  Plus,
  Settings,
  Monitor,
  MessageSquare,
  ArrowLeft,
  MoreHorizontal,
  X,
} from "lucide-react";
import { callRoute } from "../workspace-api";
import { workspaceApi } from "../../shared/workspace-api";
import { SearchWorkspace } from "../Workspace";
import { Avatar, Badge } from "../components";

import type { ReactNode } from "react";
import { tabs, type AppModel } from "./AppController";
import type { renderResults } from "./Results";
import type { renderComposer } from "./Composer";

export function renderAppPages(
  props: Pick<
    AppModel,
    | "attachments"
    | "startChat"
    | "pullRefresh"
    | "workspaceLoadError"
    | "refresh"
    | "session"
    | "unified"
    | "stopWorkspaceEvents"
    | "profile"
    | "previousPage"
    | "setProfile"
    | "setView"
    | "sheet"
    | "setSheet"
    | "profileWork"
    | "data"
    | "currentSourceName"
    | "messageTeam"
    | "openTeamFeed"
    | "setSelected"
    | "setFolderChoice"
    | "setFolder"
    | "setReplyContext"
    | "focusComposer"
    | "setConversation"
    | "view"
    | "tab"
    | "project"
    | "teamVisibilityChanged"
    | "teamSelection"
    | "setData"
    | "setTeamSelection"
    | "bootstrap"
    | "draft"
    | "setContextArtifact"
    | "setTeamMessages"
    | "projectFilter"
    | "scopedAgents"
    | "openSourcedAgent"
    | "feedHomeKey"
    | "feedFilter"
    | "setFeedFilter"
    | "teamKey"
    | "revisionFor"
    | "openSourcedConversation"
    | "focusThreadComposer"
    | "changed"
    | "showScheduled"
    | "openLater"
    | "availableAgents"
    | "askAboutPull"
    | "scopedRuns"
    | "draftFromScheduled"
    | "setActiveArtifact"
    | "revision"
    | "beginReply"
    | "displayName"
    | "accountName"
    | "myProfile"
    | "setMyProfile"
    | "setSettingsParent"
    | "setTab"
    | "setProject"
    | "open"
    | "setError"
    | "searchAgent"
    | "searchScope"
    | "pull"
    | "setPull"
    | "replyToArtifact"
    | "setFiling"
    | "selected"
    | "setWorkflowId"
    | "setWorkflowSource"
    | "setReviewTarget"
    | "dismissNotice"
    | "setDismissNotice"
  > &
    ReturnType<typeof renderResults> & {
      projectScope: ReactNode;
      launchComposer: ReturnType<typeof renderComposer>["launchComposer"];
    },
) {
  const {
    attachments,
    launchComposer,
    startChat,
    pullRefresh,
    workspaceLoadError,
    refresh,
    session,
    unified,
    stopWorkspaceEvents,
    profile,
    previousPage,
    setProfile,
    setView,
    sheet,
    setSheet,
    profileWork,
    data,
    currentSourceName,
    messageTeam,
    openTeamFeed,
    setSelected,
    setFolderChoice,
    setFolder,
    setReplyContext,
    focusComposer,
    setConversation,
    view,
    tab,
    project,
    teamVisibilityChanged,
    teamSelection,
    setData,
    setTeamSelection,
    bootstrap,
    draft,
    setContextArtifact,
    setTeamMessages,
    projectFilter,
    scopedAgents,
    openSourcedAgent,
    feedHomeKey,
    feedFilter,
    setFeedFilter,
    teamKey,
    revisionFor,
    openSourcedConversation,
    focusThreadComposer,
    changed,
    showScheduled,
    openLater,
    availableAgents,
    askAboutPull,
    scopedRuns,
    draftFromScheduled,
    setActiveArtifact,
    revision,
    beginReply,
    resultsList,
    displayName,
    accountName,
    myProfile,
    setMyProfile,
    setSettingsParent,
    setTab,
    setProject,
    projectScope,
    open,
    setError,
    resultCard,
    replySaved,
    searchAgent,
    searchScope,
    pull,
    setPull,
    replyToArtifact,
    setFiling,
    selected,
    setWorkflowId,
    setWorkflowSource,
    setReviewTarget,
    dismissNotice,
    setDismissNotice,
  } = props;
  const profileTabStorage = sessionDraft<string>(
    session?.user?.id,
    executionSourceId(),
    "agent-tab",
    profile?.id || "",
  );
  return (
    <main className="workspace-content">
      {(pullRefresh.pull > 0 || pullRefresh.refreshing) && (
        <div
          className={
            "pull-refresh" +
            (pullRefresh.ready ? " ready" : "") +
            (pullRefresh.refreshing ? " refreshing" : "")
          }
          style={
            pullRefresh.refreshing
              ? undefined
              : { transform: `translateY(${pullRefresh.pull}px)` }
          }
          role="status"
          aria-label={
            pullRefresh.refreshing
              ? "Refreshing"
              : pullRefresh.ready
                ? "Release to refresh"
                : "Pull to refresh"
          }
        >
          <RefreshCw size={18} aria-hidden="true" />
        </div>
      )}
      {workspaceLoadError && (
        <div className="workspace-load-status note" role="status">
          <span>{workspaceLoadError} Retrying…</span>
          <button className="text-button" onClick={() => void refresh()}>
            Retry now
          </button>
        </div>
      )}
      <WorkspaceConnection
        owner={session.user.id}
        sources={unified.sources}
        stopRef={stopWorkspaceEvents}
      />
      <BrowserBuildStatus />
      <FleetAuthorityNotice open={() => setSheet("fleet")} />
      {profile ? (
        <>
          <div className="profile-backbar">
            <button
              className="text-button back-button"
              onClick={() => {
                if (previousPage()) return;
                setProfile(null);
                setView("all");
              }}
            >
              <ArrowLeft size={16} />
              Back
            </button>
            <div>
              <strong>{profile.name}</strong>
              <span>Agent profile</span>
            </div>
            <button
              className="settings-button profile-settings"
              aria-label="Open settings"
              aria-expanded={sheet === "settings"}
              onClick={() => setSheet("settings")}
            >
              <Settings size={20} aria-hidden="true" />
            </button>
          </div>
          <section className="profile-head">
            <ProfileCover name={profile.name} />
            <button
              className="icon-button profile-menu"
              aria-label="Agent actions"
              onClick={() => setSheet("agent-menu")}
            >
              <MoreHorizontal size={20} />
            </button>
            <Avatar
              name={profile.name}
              provider={profile.provider}
              expandable
            />
            <div className="profile-identity">
              <div className="profile-name">
                <h1>{profile.name}</h1>
                <span className="agent-label">Agent</span>
              </div>
              <p className="profile-handle">@{profile.name}</p>
            </div>
            <p className="profile-status">
              {profile.instructions ||
                (profileWork.some((run) =>
                  ["running", "pausing", "waiting_children"].includes(
                    run.state,
                  ),
                )
                  ? agentStatusLine(
                      profile.id,
                      profileWork.find((run) =>
                        ["running", "pausing", "waiting_children"].includes(
                          run.state,
                        ),
                      )?.id,
                    )
                  : profileWork.some((run) =>
                        ["paused", "awaiting_approval"].includes(run.state),
                      )
                    ? "Waiting for your input."
                    : profileWork.length
                      ? "Your work is queued."
                      : agentStatusLine(profile.id))}
            </p>
            <div className="profile-meta">
              <Badge provider={profile.provider} />
              <span className="muted profile-model">
                {agentModelName(profile, data.connections)}
              </span>
              <span className="muted profile-environment">
                <Monitor size={14} aria-hidden="true" />
                {unified.agents.find(
                  (agent) =>
                    agent.id === profile.id &&
                    (agent.sourceId || "") === executionSourceId(),
                )?.executionEnvironment || currentSourceName}
              </span>
            </div>
            <ProfileTeams
              agent={profile}
              teams={data.teams || []}
              onMessage={messageTeam}
              onOpen={openTeamFeed}
            />
            {profile.retired_at && (
              <p className="note" role="status">
                Retired · History stays available. Restore this agent to send
                new work.
              </p>
            )}
            <div className="profile-actions">
              <button
                className="primary"
                disabled={!!profile.retired_at}
                onClick={() => {
                  setSelected(profile.id);
                  setFolderChoice(undefined);
                  setFolder(profile.folder_id || "");
                  setReplyContext(null);
                  focusComposer();
                }}
              >
                <MessageSquare size={16} />
                Message
              </button>
            </div>
            <AgentWork runs={profileWork} onConversation={setConversation} />
          </section>

          <div
            className="segmented scroll-tabs profile-tabs"
            role="tablist"
            aria-label="Agent activity"
          >
            {[
              ["all", "Results"],
              ["threads", "Threads"],
              ["messages", "Messages"],
              ["mail", "Agent mail"],
              ["files", "Files"],
              ["traces", "Traces"],
            ].map(([v, label]) => (
              <button
                className={view === v ? "selected" : ""}
                key={v}
                role="tab"
                aria-selected={view === v}
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                  if (profile) profileTabStorage.write(v);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      ) : (tab === "projects" && project) || tab === "profile" ? null : (
        <div className="page-heading compact">
          <h1>{tabs.find((t) => t.id === tab)?.label}</h1>
        </div>
      )}
      {tab === "feed" && !profile && !!data.teams?.length && (
        <div className="workspace-scope">
          <TeamFilter
            teams={data.teams || []}
            onVisibilityChanged={teamVisibilityChanged}
            selected={teamSelection}
            onDeleted={(id) => {
              setData((old) => ({
                ...old,
                teams: old.teams?.filter((team) => team.id !== id),
              }));
              setTeamSelection((old) => old.filter((team) => team !== id));
              void bootstrap();
            }}
            onChange={(ids) => {
              setTeamSelection(ids);
              const team =
                ids.length === 1
                  ? data.teams?.find((t) => t.id === ids[0])
                  : undefined;
              if (team && !draft.trim()) {
                setSelected(team.manager_id);
                setContextArtifact(null);
              }
            }}
            onCreate={() => setSheet("teams")}
            onOpen={messageTeam}
            onMessages={setTeamMessages}
          />
          <TeamManagerShortcut
            teams={data.teams || []}
            agents={data.agents}
            selected={teamSelection}
            onOpen={messageTeam}
          />
        </div>
      )}
      {tab === "feed" && !profile && (
        <>
          {unified.error && (
            <p className="error" role="status">
              {unified.error}
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  window.dispatchEvent(new Event("loop55-source-refresh"))
                }
              >
                Retry connection
              </button>
            </p>
          )}
          {unified.agents.length > 0 && (
            <YourAgents
              agents={
                projectFilter || teamSelection.length
                  ? unified.agents.filter(
                      (agent) =>
                        (agent.sourceId || "") === executionSourceId() &&
                        scopedAgents.some((scoped) => scoped.id === agent.id),
                    )
                  : unified.agents.filter((agent) => !agent.retired_at)
              }
              connections={unified.connections}
              runs={unified.runs}
              onProfile={openSourcedAgent}
              onCreate={startChat}
            />
          )}
          <Feed
            key={feedHomeKey}
            filter={feedFilter}
            onFilter={setFeedFilter}
            project={projectFilter || undefined}
            teams={teamKey || undefined}
            revision={revisionFor("feed")}
            agents={unified.agents}
            sources={unified.feedSources}
            sourcesLoading={unified.loading}
            onOpen={openSourcedConversation}
            onReply={(c, source, quote) => {
              if (!quote) {
                openSourcedConversation(c, undefined, source);
                return focusThreadComposer(c);
              }
              beginReply(
                { ...quote, conversationId: c },
                undefined,
                source ?? executionSourceId(),
              );
            }}
            connections={unified.connections}
            onAgent={openSourcedAgent}
            onChanged={() => void changed()}
            onScheduled={() => showScheduled()}
            onShowReminder={(id) => openLater("reminders", id)}
            onAsk={availableAgents.length ? askAboutPull : undefined}
            needsSlot={
              <div className="run-list">
                {capabilities.nativeHarnesses && (
                  <NativeDecisions onConversation={setConversation} />
                )}
                <Approvals
                  teams={teamKey}
                  runIds={
                    projectFilter ? scopedRuns.map((r) => r.id) : undefined
                  }
                  revision={revisionFor("approvals")}
                  onChange={() => void changed()}
                  onConversation={setConversation}
                />
                <ScheduledSends
                  revision={revisionFor("scheduled")}
                  failedOnly
                  onOpen={(c) => setConversation(c)}
                  onDraft={draftFromScheduled}
                />
              </div>
            }
            emptyAction={
              <button
                className="primary"
                onClick={() =>
                  data.agents.length
                    ? focusComposer()
                    : unified.agents.length
                      ? setSheet("agents")
                      : startChat()
                }
              >
                <Plus size={17} />
                {unified.agents.length
                  ? data.agents.length
                    ? "Start a conversation"
                    : "Choose an agent"
                  : "Start chatting"}
              </button>
            }
          />
        </>
      )}
      {profile && view === "traces" && (
        <Traces
          key={profile.id}
          agentId={profile.id}
          revision={revisionFor("activities")}
          onConversation={setConversation}
          onArtifact={setActiveArtifact}
        />
      )}
      {profile && view === "threads" && (
        <Feed
          key={"agent-" + profile.id}
          filter="all"
          onFilter={() => {}}
          hideFilters
          agent={profile.id}
          revision={revisionFor("feed")}
          agents={data.agents}
          connections={data.connections}
          onOpen={(c, m) => {
            setSelected(profile.id);
            setConversation(c, m);
          }}
          onReply={(c) => {
            setSelected(profile.id);
            setConversation(c);
            focusThreadComposer(c);
          }}
          onAgent={setProfile}
          onChanged={() => void changed()}
        />
      )}
      {profile && view === "mail" && (
        <AgentMailThreads
          target={{ kind: "agent", id: profile.id }}
          ownerKey={session?.user?.id || ""}
          sourceId={executionSourceId()}
          agents={data.agents}
          onOpenConversation={(id, source) =>
            setConversation(id, undefined, source)
          }
          onChanged={() => void bootstrap()}
        />
      )}
      {profile && view === "messages" && (
        <AgentMessages
          key={profile.id}
          agent={profile}
          revision={revision}
          onConversation={setConversation}
          onReply={beginReply}
        />
      )}
      {profile && ["all", "files"].includes(view) && resultsList}
      {tab === "profile" && !profile && (
        <MyProfile
          social={
            <Social
              onAsk={availableAgents.length ? askAboutPull : undefined}
              agents={unified.agents}
            />
          }
          name={displayName}
          accountName={accountName}
          profile={myProfile}
          onSaved={setMyProfile}
          onCompose={launchComposer}
          hasDraft={!!draft.trim() || !!attachments.length}
          decisions={(kind) => (
            <PersonalDecisions
              key={kind}
              kind={kind}
              onConversation={(id) => setConversation(id)}
            />
          )}
          onAgents={() => {
            // Closing it comes back here, not to Settings.
            setSettingsParent(false);
            setSheet("agents");
          }}
          onProjects={() => {
            setTab("projects");
            setProject("");
            setProfile(null);
            setView("all");
            afterSheetsClose(() =>
              window.scrollTo({ top: 0, behavior: "instant" }),
            );
          }}
          files={<PersonalFiles onConversation={(id) => setConversation(id)} />}
          messages={
            <PersonalProfile
              embedded
              name={displayName}
              agents={data.agents}
              onAgent={setProfile}
              onConversation={(c, m) => setConversation(c, m)}
              onReply={(prompt) =>
                beginReply({
                  agentId: prompt.agent_id,
                  conversationId: prompt.conversation_id,
                  messageId: prompt.id,
                  content: prompt.content,
                  mine: true,
                })
              }
            />
          }
          later={(section) => (
            <>
              {section === "saved" && projectScope && (
                <div className="later-scope">{projectScope}</div>
              )}
              <Later
                key={section}
                only={section}
                project={
                  section === "saved" ? projectFilter || undefined : undefined
                }
                revision={revisionFor(
                  section === "saved"
                    ? "saved"
                    : section === "scheduled"
                      ? "scheduled"
                      : "later",
                )}
                onOpen={(c, m) => setConversation(c, m)}
                onArtifact={(id) =>
                  void callRoute(
                    workspaceApi.artifactDetail,
                    { params: { id } },
                    executionSourceId(),
                  )
                    .then((item) => void open(item))
                    .catch((e) => setError(e.message))
                }
                teams={teamKey || undefined}
                renderResult={(item, options) =>
                  resultCard(item, true, options.onUnsave)
                }
                onDraft={draftFromScheduled}
                onReply={replySaved}
              />
            </>
          )}
        />
      )}
      {tab === "search" && !profile && (
        <SearchWorkspace
          key={searchAgent + ":" + searchScope}
          userName={session.user.name?.trim() || "You"}
          initialScope={searchScope}
          onProfile={setProfile}
          initialAgent={searchAgent}
          agents={data.agents}
          folders={data.folders}
          onOpen={open}
          onConversation={(c, m) => {
            setConversation(c, m);
          }}
          onReplyPrompt={(prompt) =>
            beginReply({
              agentId: prompt.agent_id,
              conversationId: prompt.conversation_id,
              messageId: prompt.id,
              content: prompt.content,
              mine: true,
            })
          }
        />
      )}
      {tab === "pulls" && !profile && (
        <PullRequests
          selected={pull}
          onSelect={setPull}
          onConnect={() => setSheet("mcp")}
          onAsk={availableAgents.length ? askAboutPull : undefined}
        />
      )}
      {tab === "projects" && !profile && (
        <Projects
          folders={data.folders}
          agents={data.agents}
          selected={project}
          onSelect={setProject}
          onCreate={() => {
            setFolder("");
            setSheet("project");
          }}
          onCreateAgent={(id) => {
            setFolder(id);
            setSheet("create");
          }}
          onAgent={setProfile}
          onAssign={async (a, id) => {
            await callRoute(
              workspaceApi.agentUpdate,
              { params: { id: a.id }, body: { folderId: id } },
              executionSourceId(),
            );
            await bootstrap();
          }}
          renderActivity={(id) => (
            <ProjectActivity
              key={id}
              projectId={id}
              agents={data.agents}
              connections={data.connections}
              revision={revisionFor("activities")}
              onOpen={open}
              onReply={(item) => void replyToArtifact(item)}
              onConversation={setConversation}
              onAgent={setProfile}
              onFile={setFiling}
            />
          )}
          renderFiles={(id) => (
            <>
              <UploadButton
                folderId={id}
                label="Upload files"
                onUploaded={() => {
                  void changed();
                }}
              />
              <ProjectFiles
                key={id}
                embedded
                folders={data.folders}
                folder={id}
                onFolder={setProject}
                onOpen={open}
                onFile={setFiling}
                onCreate={() => {
                  setFolder(id);
                  setSheet("project");
                }}
                onEdit={() => {
                  setFolder(id);
                  setSheet("folder-edit");
                }}
                version={revisionFor("results")}
              />
            </>
          )}
          onEdit={() => {
            setFolder(project);
            setSheet("folder-edit");
          }}
          revision={revision}
          renderThreads={(id) => (
            <Feed
              key={id}
              filter="all"
              onFilter={() => {}}
              hideFilters
              project={id}
              revision={revisionFor("feed")}
              agents={data.agents}
              onOpen={(c, m) => setConversation(c, m)}
              onReply={(c) => {
                setConversation(c);
                focusThreadComposer(c);
              }}
              connections={data.connections}
              onAgent={setProfile}
              onChanged={() => void changed()}
            />
          )}
          renderHistory={(id, view, text) =>
            view === "search" ? (
              <ProjectSearchResults
                project={id}
                query={text}
                onConversation={(c, m) => setConversation(c, m)}
                onArtifact={(artifact) =>
                  void callRoute(
                    workspaceApi.artifactDetail,
                    { params: { id: artifact } },
                    executionSourceId(),
                  )
                    .then((item) => void open(item))
                    .catch((e) => setError(e.message))
                }
              />
            ) : view === "saved" ? (
              <SavedList
                key={id}
                revision={revisionFor("saved")}
                project={id}
                searchLabel="Search saved decisions"
                onOpen={(c, m) => setConversation(c, m)}
                onReply={replySaved}
                renderResult={(item, options) =>
                  resultCard(item, true, options.onUnsave)
                }
              />
            ) : (
              <Feed
                key={id + view}
                filter={view}
                onFilter={() => {}}
                hideFilters
                project={id}
                revision={revisionFor("feed")}
                agents={data.agents}
                onOpen={(c, m) => setConversation(c, m)}
                onReply={(c) => {
                  setConversation(c);
                  focusThreadComposer(c);
                }}
                connections={data.connections}
                onAgent={setProfile}
                onChanged={() => void changed()}
              />
            )
          }
          onNewTask={(id) => {
            const agent =
              data.agents.find(
                (a) =>
                  !a.retired_at &&
                  a.connection_id &&
                  a.id === selected &&
                  belongsToProject(a.folder_id, id, data.folders),
              ) ||
              data.agents.find(
                (a) =>
                  !a.retired_at &&
                  a.connection_id &&
                  belongsToProject(a.folder_id, id, data.folders),
              );
            if (!agent) {
              setFolder(id);
              setSheet("create");
              return;
            }
            setSelected(agent.id);
            setReplyContext(null);
            setContextArtifact(null);
            setFolder(id);
            setFolderChoice(undefined);
            focusComposer();
          }}
          onWorkflows={() => {
            setWorkflowId(undefined);
            setWorkflowSource(undefined);
            setSheet("workflows");
          }}
          onTeams={() => setSheet("teamDirectory")}
          onReview={(id) => {
            setReviewTarget({ folder: id });
            setSheet("codeReview");
          }}
        />
      )}
      {dismissNotice && (
        <p className="note" role="status">
          {typeof dismissNotice === "string" ? (
            dismissNotice
          ) : (
            <>
              {dismissNotice.text}{" "}
              <button
                className="text-button"
                onClick={() => {
                  dismissNotice.onAction();
                  setDismissNotice("");
                }}
              >
                {dismissNotice.action}
              </button>
            </>
          )}
          <button
            className="icon-button"
            aria-label="Close notice"
            onClick={() => setDismissNotice("")}
          >
            <X size={16} />
          </button>
        </p>
      )}
    </main>
  );
}
