import { renderComposer, renderComposerSendSheets } from "./app/Composer";
import { workspaceApi } from "../shared/workspace-api";
import { callRoute } from "./workspace-api";

import { StartCodeReview } from "./CodeReview";
import { SettingsHome } from "./SettingsHome";
import { CardTokens } from "./CardTokens";
import { PersonalProfile } from "./PersonalProfile";
import { PersonalFiles } from "./PersonalFiles";
import { Social } from "./Social";
import { MyProfile } from "./MyProfile";
import { PersonalDecisions } from "./PersonalDecisions";
import { AgentModelSettings } from "./AgentModelSettings";
import { agentModelName } from "./modelChoices";
import { UploadButton } from "./Attachments";

import { capabilities } from "./capabilities";
import { SourceProvider } from "./SourceContext";

import { executionSourceId, sourceUrl } from "./sourceRouting";

import { NativeHistory } from "./NativeHistory";
import { NativeDecisions, WorkspaceConnection } from "./NativeControls";
import { BrowserBuildStatus } from "./BuildStatus";
import { AgentDirectory } from "./AgentDirectory";
import { YourAgents } from "./YourAgents";
import { ProfileCover } from "./ProfileCover";
import { AgentWork } from "./AgentWork";
import { agentStatusLine } from "./agentStatusLine";
import { belongsToProject } from "../shared/projects";
import { ProjectFiles } from "./ProjectFiles";
import { ProjectActivity } from "./ProjectActivity";
import { ProjectSearchResults, Projects } from "./Projects";
import { Traces } from "./Traces";
import { AgentMailThreads } from "./AgentMail";
import { AgentMessages } from "./AgentMessages";
import { afterSheetsClose } from "./sheetHistory";

import {
  TeamFilter,
  TeamMessages,
  CreateTeam,
  ProfileTeams,
  TeamManagerShortcut,
  TeamDirectory,
} from "./Teams";
import { RuntimeHosts } from "./RuntimeHosts";
import { ExecutionEnvironments } from "./ExecutionEnvironments";
import { Memory } from "./Memory";
import { ShareSheet, InstallHelp } from "./Sharing";
import { PwaStatus } from "./Pwa";
import { Notifications } from "./Notifications";
import { RetireAgent } from "./RetireAgent";
import { Tools } from "./Tools";
import { PiCustomizations } from "./PiCustomizations";
import { WorkflowEditor } from "./Workflows";
import { Approvals } from "./Approvals";
import { PullRequests, TOOLS_CLOSED } from "./PullRequests";
import { Feed } from "./Feed";

import { Later, SavedList } from "./Later";
import { ActionSheet, LaterSheet, ScheduledSends, undoReminder } from "./ThreadTools";
import { Toasts, notify } from "./toast";
import { GLOBAL_DRAFT, sourceDraftId, saveThreadDraft as writeThreadDraft } from "./drafts";

import { Orbit, RefreshCw, Search, Plus, SlidersHorizontal, Folder, Users, Settings, LogOut, Monitor, MessageSquare, ArrowLeft, MoreHorizontal, X } from "lucide-react";
import { api, parse } from "./api";

import { Connections } from "./Connections";
import { CreateAgent } from "./CreateAgent";
import {
  SearchWorkspace,
  FileSheet,
  FolderForm,
  ImportSheet,
  SearchSettings,
} from "./Workspace";
import { ArtifactViewer } from "./ArtifactViewer";
import { Conversation } from "./Conversation";
import { Avatar, Badge, Sheet } from "./components";
import type { Agent, Artifact } from "../shared/types";
import "./style.css";
import "./design.css";
import { PreviewBanner } from "./PreviewBanner";
import { tabs, useAppController } from "./app/AppController";
import { renderResults } from "./app/Results";
import { renderSessionGate } from "./app/Session";

export default function App() {
  const props = useAppController();
  const {
    bootstrapOwner, setBootstrapOwner, composerOptions, setComposerOptions,
    composerFocusRequest, startChat,
    tab, lastNavTap, setFeedFilter, setFeedHomeKey, setTab,
    setProfile, setView, displayName, runningAgentCount, session,
    error, check, conversation, data, projectFilter,
    setProjectFilter, replyContext, runs, activeAgent, conversationTarget,
    folderChoice, contextArtifact, selected, routePreview, busy,
    uploading, draft, send, sendPress, composerData,
    availableAgents, composerRef, composerExpanded, sendNotice, sentRun,
    setSelected, setConversation, setSendNotice, attachments, setContextArtifact,
    setFolderChoice, setFolder, focusComposer, setReplyContext, collapseComposer,
    setDraft, setComposerExpanded, setAttachments, composerError, setComposerError,
    threadIdentity, setUploading, viewIdentity, threadIdentityRef, attachmentsRef,
    setSheet, setModelAgent, setSendMenu, threadWork, threadNotice,
    setThreadNotice, beginReply, open, replyToArtifact, archiveCard,
    setLaterCard, setFiling, ownerRef, changed, setError,
    openCard, resultsError, items, loadResults, resultsLoading,
    profile, view, teamSelection, profileWork, next,
    setTeamSelection, setProject, sheet, pullRefresh, workspaceLoadError,
    refresh, unified, stopWorkspaceEvents, previousPage, currentSourceName,
    messageTeam, openTeamFeed, project, teamVisibilityChanged, setData,
    bootstrap, setTeamMessages, scopedAgents, openSourcedAgent, feedHomeKey,
    feedFilter, teamKey, revisionFor, openSourcedConversation, focusThreadComposer,
    showScheduled, openLater, askAboutPull, scopedRuns, draftFromScheduled,
    setActiveArtifact, revision, accountName, myProfile, setMyProfile,
    setSettingsParent, searchAgent, searchScope, pull, setPull,
    setWorkflowId, setWorkflowSource, setReviewTarget, dismissNotice, setDismissNotice,
    archivedCard, setArchivedCard, settingsParent, openSettingsPage, theme,
    setTheme, draftOwner, draftLoadedFor, draftRef, setSharedDraft,
    setRoutePreview, setSession, setItems, setRuns, setEditError,
    setSearchAgent, setSearchScope, sendMenu, setScheduleAt, scheduleAt,
    laterCard, openSourceLater, closeSheet, sharedDraft, shareAgent,
    setReturnTo, setShareAgent, workflowId, workflowSource, setRevision,
    returnTo, folder, newAgentPrompt, environmentToOpen, environmentSetupProvider,
    creationConnections, creationFolders, setEnvironmentToOpen, setEnvironmentSetupProvider, setNewAgentPrompt,
    reviewTarget, teamPreset, setTeamPreset, setReturnToTeamDirectory, teamMessages,
    actionSource, threadSource, modelAgent, editBusy, setEditBusy,
    editError, threadData, conversationSource, messageId, setThreadWork,
    setConversationTarget, threadDraft, restoreToComposer, withdrawToComposer, activeArtifact,
    filing, filingResult, setFilingResult,
  } = props;
  const nav = (
    <>
      {tabs.map((t) => (
        <button
          key={t.id}
          aria-label={t.label}
          aria-current={tab === t.id ? "page" : undefined}
          className={tab === t.id ? "current" : ""}
          onClick={() => {
            // A double tap goes home: the top of the tab, and for the Feed the
            // top of Done, whichever filter or tab the first tap left.
            const now = performance.now();
            const home =
              lastNavTap.current?.tab === t.id &&
              now - lastNavTap.current.at < 350;
            lastNavTap.current = home ? null : { tab: t.id, at: now };
            if (home) {
              if (t.id === "feed") {
                setFeedFilter("done");
                setFeedHomeKey((key) => key + 1);
              }
              requestAnimationFrame(() =>
                window.scrollTo({
                  top: 0,
                  // WebKit can cancel a smooth scroll during this touch
                  // sequence while the Feed is being remounted.
                  behavior: "instant",
                }),
              );
            }
            setTab(t.id);
            setProfile(null);
            setView("all");
          }}
        >
          {t.id === "profile" ? (
            <Avatar name={displayName} className="nav-avatar" />
          ) : (
            <t.icon size={21} />
          )}
          <span>{t.label}</span>
          {t.id === "feed" && runningAgentCount > 0 && (
            <small
              className="running-count"
              aria-label={`${runningAgentCount} ${runningAgentCount === 1 ? "agent" : "agents"} running`}
            >
              {runningAgentCount > 9 ? "9+" : runningAgentCount}
            </small>
          )}
        </button>
      ))}
    </>
  );
  if (session === undefined || !session?.user)
    return renderSessionGate({ session, error, check });
  const threadMode = Boolean(conversation);
  // The project filter shared by the Feed and your Saved list.
  const projectScope = data.folders.some((f) => f.kind === "project") && (
    <label className="scope-chip">
      <span className="sr-only">Project</span>
      <select
        aria-label="Filter by project"
        value={projectFilter}
        onChange={(e) => setProjectFilter(e.target.value)}
      >
        <option value="">All projects</option>
        {data.folders
          .filter((f) => f.kind === "project")
          .map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
      </select>
    </label>
  );
  // Who and where a send goes, said before it is sent.
  const topProject = (folderId?: string | null) => {
    let folder = data.folders.find((f) => f.id === folderId);
    while (folder?.parent_id)
      folder = data.folders.find((f) => f.id === folder!.parent_id);
    return folder?.name;
  };
  // Outside a thread, sending now to an agent with a running task steers
  // that task (the server joins its active conversation).
  const steersActive =
    !threadMode &&
    !replyContext?.conversationId &&
    runs.some(
      (run) =>
        run.agent_id === activeAgent?.id &&
        ["running", "awaiting_approval"].includes(run.state),
    );
  const destination = {
    agent: activeAgent?.name || "agent",
    project:
      (threadMode
        ? conversationTarget?.projectName
        : topProject(
            folderChoice !== undefined
              ? folderChoice
              : contextArtifact?.agent_id === activeAgent?.id
                ? contextArtifact?.folder_id
                : activeAgent?.folder_id,
          )) || "Unfiled",
    thread: threadMode
      ? conversationTarget?.title || "This thread"
      : replyContext?.conversationId
        ? replyContext.title || "Its thread"
        : "New thread",
  };
  const messageComposer = renderComposer({
    replyContext,
    contextArtifact,
    conversation,
    threadMode,
    selected,
    routePreview,
    busy,
    uploading,
    draft,
    activeAgent,
    conversationTarget,
    send,
    sendPress,
    composerData,
    availableAgents,
    composerRef,
    composerExpanded,
    workspaceReady: bootstrapOwner === session?.user?.id,
    composerOptions,
    setComposerOptions,
    startChat,
    sendNotice,
    sentRun,
    setSelected,
    setConversation,
    setSendNotice,
    attachments,
    session,
    setContextArtifact,
    setFolderChoice,
    setFolder,
    focusComposer,
    destination,
    data,
    setReplyContext,
    collapseComposer,
    steersActive,
    setDraft,
    setComposerExpanded,
    setAttachments,
    composerError,
    setComposerError,
    folderChoice,
    threadIdentity,
    setUploading,
    viewIdentity,
    threadIdentityRef,
    attachmentsRef,
    setSheet,
    setModelAgent,
    setSendMenu,
    threadWork,
    threadNotice,
    setThreadNotice,
  });
  const { replySaved, resultCard, resultsList } = renderResults({
    beginReply, setConversation, open, replyToArtifact, archiveCard,
    setLaterCard, setFiling, data, setProfile, ownerRef,
    changed, setError, openCard, resultsError, items,
    loadResults, resultsLoading, profile, view, projectFilter,
    teamSelection, profileWork, next,
  });
  return (
    <div className="app-shell" data-page={profile ? "agent" : tab}>
      <aside className="sidebar">
        <button
          className="wordmark"
          onClick={() => {
            setTab("feed");
            setProfile(null);
            setTeamSelection([]);
          }}
        >
          <Orbit />
          loop
          <span className="wordmark-dot" />
        </button>
        <nav>{nav}</nav>
        <button
          className="project-nav"
          onClick={() => setSheet("teamDirectory")}
        >
          <Users size={17} /> Teams
        </button>
        <div className="sidebar-label">
          WORKSPACE
          <button
            className="icon-button"
            aria-label="New project"
            onClick={() => {
              setFolder("");
              setTab("projects");
              setSheet("project");
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        {data.folders
          .filter((f) => !f.parent_id)
          .map((f) => (
            <button
              key={f.id}
              className="project-nav"
              onClick={() => {
                setFolder(f.id);
                setProject(f.id);
                setProfile(null);
                setTab("projects");
              }}
            >
              <Folder size={17} />
              {f.name}
            </button>
          ))}
        {!data.folders.length && (
          <p className="field-hint">Projects give your work a home.</p>
        )}
      </aside>
      <div className="main-column">
        <PreviewBanner preview={data.preview} />
        <PwaStatus />
        <header className="topbar">
          <div className="wordmark mobile-brand">
            <Orbit />
            loop
            <span className="wordmark-dot" />
          </div>
          <span className="desktop-breadcrumb">
            Workspace <span>/</span>{" "}
            {profile
              ? "@" + profile.name
              : tabs.find((t) => t.id === tab)?.label}
          </span>
          <div className="topbar-actions">
            {tab === "feed" && !profile && projectScope}
            <span className="private-indicator">
              <span />
              Private workspace
            </span>
            <button
              className="settings-button"
              aria-label="Open settings"
              aria-expanded={sheet === "settings"}
              onClick={() => setSheet("settings")}
            >
              <Settings size={20} aria-hidden="true" />
            </button>
          </div>
        </header>
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
          <WorkspaceConnection owner={session.user.id} sources={unified.sources} stopRef={stopWorkspaceEvents} />
          <BrowserBuildStatus />
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
                <Avatar name={profile.name} provider={profile.provider} expandable />
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
                    Retired · History stays available. Restore this agent to
                    send new work.
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
                <AgentWork
                  runs={profileWork}
                  onConversation={setConversation}
                />
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
                      if (profile)
                        sessionStorage.setItem(
                          "loop-agent-tab-" + profile.id,
                          v,
                        );
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
                      window.dispatchEvent(new Event("loop-source-refresh"))
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
                            scopedAgents.some(
                              (scoped) => scoped.id === agent.id,
                            ),
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
              files={
                <PersonalFiles onConversation={(id) => setConversation(id)} />
              }
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
                      section === "saved"
                        ? projectFilter || undefined
                        : undefined
                    }
                    revision={revisionFor(section === "saved" ? "saved" : section === "scheduled" ? "scheduled" : "later")}
                    onOpen={(c, m) => setConversation(c, m)}
                    onArtifact={(id) =>
                      void api<Artifact>(`/artifacts/${id}`)
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
                await api(`/agents/${a.id}`, { folderId: id }, "PATCH");
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
                      void api<Artifact>(`/artifacts/${artifact}`)
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
        {!conversation && messageComposer}
        <nav className="mobile-nav">{nav}</nav>
      </div>
      <Toasts />
      {archivedCard && (
        <div className="toast" role="status">
          <span>Archived from feed. Still in history and search.</span>
          <button
            onClick={() =>
              void archiveCard(archivedCard.id, false, archivedCard.source)
            }
          >
            Undo
          </button>
          <button
            aria-label="Dismiss archive notice"
            onClick={() => setArchivedCard(null)}
          >
            ×
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="toast error">
          <span>{error}</span>
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {(sheet === "settings" || settingsParent) && (
        <Sheet
          title="Settings"
          className="side-panel settings-drawer"
          onClose={() => {
            setSettingsParent(false);
            setSheet("");
          }}
        >
          <SettingsHome
            open={openSettingsPage}
            theme={theme}
            onTheme={setTheme}
            agents={data.agents}
            connections={data.connections}
          />
          <footer className="drawer-account">
            <Avatar name={displayName} />
            <span>
              <strong>{displayName}</strong>
              <small>Personal workspace</small>
            </span>
            {session.mode === "multi-user" && (
              <button
                className="text-button"
                onClick={async () => {
                  stopWorkspaceEvents.current();
                  const previous = draftOwner.current;
                  if (previous.owner && draftLoadedFor.current === previous.key)
                    writeThreadDraft(
                      previous.key,
                      draftRef.current,
                      attachmentsRef.current,
                      previous.owner,
                    );
                  await api("/auth/sign-out", {});
                  draftLoadedFor.current = null;
                  sessionStorage.clear();
                  setTeamSelection([]);
                  setArchivedCard(null);
                  setComposerExpanded(false);
                  setSharedDraft({
                    url: "",
                    title: "",
                    excerpt: "",
                    question: "",
                    folderId: "",
                  });
                  setActiveArtifact(null);
                  setContextArtifact(null);
                  setReplyContext(null);
                  setRoutePreview(null);
                  setFiling(null);
                  setLaterCard(null);
                  setSheet("");
                  history.replaceState(
                    history.state,
                    "",
                    sourceUrl(executionSourceId()),
                  );
                  setDraft("");
                  setFolderChoice(undefined);
                  setConversation(null);
                  setProfile(null);
                  setSession(null);
                  composerFocusRequest.current = null;
                  setData({ agents: [], connections: [], folders: [] });
                  setBootstrapOwner(undefined);
                  setItems([]);
                  setRuns([]);
                }}
              >
                <LogOut size={18} />
                Sign out
              </button>
            )}
          </footer>
        </Sheet>
      )}
      {sheet === "agent-menu" && profile && (
        <ActionSheet
          title={"@" + profile.name}
          onClose={() => setSheet("")}
          actions={[
            {
              id: "edit",
              label: "Edit agent",
              hint: "Name, instructions and project",
              icon: <Settings size={20} />,
              onSelect: () => {
                setEditError("");
                setSheet("edit-agent");
              },
            },
            {
              id: "model",
              label: "Model, provider & effort",
              hint: agentModelName(profile, data.connections),
              icon: <SlidersHorizontal size={20} />,
              onSelect: () => setModelAgent(profile),
            },
            {
              id: "search",
              label: "Search this agent",
              icon: <Search size={20} />,
              onSelect: () => {
                setSearchAgent(profile.id);
                setSearchScope("all");
                setProfile(null);
                setTab("search");
              },
            },
            {
              id: "retire",
              label: profile.retired_at ? "Restore agent" : "Retire agent",
              danger: !profile.retired_at,
              icon: <X size={20} />,
              onSelect: () => setSheet("retire-agent"),
            },
          ]}
        />
      )}
      {renderComposerSendSheets({
        sendMenu,
        setSendMenu,
        threadMode,
        threadWork,
        destination,
        send,
        steersActive,
        setScheduleAt,
        scheduleAt,
        draft,
        busy,
        setComposerError,
      })}
      {laterCard && (
        <LaterSheet
          kind="artifact"
          sourceId={laterCard.sourceId ?? executionSourceId()}
          targetId={laterCard.id}
          title={laterCard.title}
          onClose={() => setLaterCard(null)}
          onDone={(label, created) =>
            notify({
              text: `Reminder set: ${label.toLowerCase()}.`,
              link: {
                label: "View",
                onSelect: () =>
                  openSourceLater(
                    "reminders",
                    created.id,
                    laterCard.sourceId ?? executionSourceId(),
                  ),
              },
              undo: () =>
                laterCard.cardOwner && laterCard.cardOwner !== ownerRef.current
                  ? undefined
                  : undoReminder(
                      created,
                      laterCard.sourceId ?? executionSourceId(),
                    ),
            })
          }
        />
      )}
      {sheet === "notifications" && (
        <Sheet title="Notifications" onClose={closeSheet}>
          <Notifications />
        </Sheet>
      )}
      {sheet === "card-tokens" && capabilities.cardTokens === true && (
        <Sheet title="Card API tokens" onClose={closeSheet}>
          <CardTokens
            key={session.user.id + ":" + executionSourceId()}
            owner={session.user.id}
            sourceId={executionSourceId()}
          />
        </Sheet>
      )}
      {sheet === "retire-agent" && profile && (
        <RetireAgent
          agent={profile}
          onClose={closeSheet}
          onChanged={(agent) => {
            setProfile(agent);
            setData((old) => ({
              ...old,
              agents: old.agents.map((a) => (a.id === agent.id ? agent : a)),
            }));
            if (agent.retired_at && selected === agent.id) {
              setSelected("");
              setReplyContext(null);
              setContextArtifact(null);
            }
            setSheet("");
            setDismissNotice(
              agent.retired_at
                ? "Agent retired. Its history is still available."
                : "Agent restored.",
            );
          }}
        />
      )}
      {sheet === "share" && (
        <ShareSheet
          draft={sharedDraft}
          setDraft={setSharedDraft}
          folders={data.folders}
          agents={data.agents}
          newAgentId={shareAgent}
          onClose={closeSheet}
          onCreate={() => {
            setReturnTo("share");
            setSheet("create");
          }}
          onSent={(r) => {
            setSharedDraft({
              url: "",
              title: "",
              excerpt: "",
              question: "",
              folderId: "",
            });
            setShareAgent(undefined);
            setSheet("");
            setConversation(r.conversation_id);
            void refresh();
          }}
        />
      )}
      {sheet === "install" && (
        <InstallHelp
          personal={session.mode === "single-user"}
          onClose={closeSheet}
        />
      )}
      {sheet === "workflows" && (
        <WorkflowEditor
          agents={data.agents}
          folders={data.folders}
          initialId={workflowId}
          initialSource={workflowSource}
          onCreateAgent={(source, id) => {
            setWorkflowSource(source);
            setWorkflowId(id);
            setReturnTo("workflows");
            setSheet("create");
          }}
          onClose={closeSheet}
          onStarted={() => {
            setTab("feed");
            setFeedFilter("working");
            void changed();
          }}
          onConversation={(c) => {
            setSettingsParent(false);
            setSheet("");
            setConversation(c);
          }}
        />
      )}
      {sheet === "connections" && (
        <Connections
          connections={data.connections}
          onChange={async () => {
            await bootstrap();
            setRevision((value) => value + 1);
          }}
          onClose={() => (returnTo ? setSheet("create") : closeSheet())}
        />
      )}
      {sheet === "create" && (
        <CreateAgent
          initialFolder={folder}
          initialPromptText={newAgentPrompt}
          preferredEnvironmentId={environmentToOpen}
          preferredProvider={environmentSetupProvider}
          connections={creationConnections}
          folders={creationFolders}
          sources={unified.sources}
          onConnectionsChanged={bootstrap}
          onClose={closeSheet}
          onConnect={() => {
            setSheet("connections");
            if (!returnTo) setReturnTo("create");
          }}
          onSourceSetup={(sourceId) => {
            const url = new URL(sourceUrl(sourceId), location.origin);
            url.searchParams.set("connect", "1");
            location.assign(url.pathname + url.search);
          }}
          onEnvironmentSetup={(environmentId, provider) => {
            setEnvironmentToOpen(environmentId);
            setEnvironmentSetupProvider(provider);
            setReturnTo("create");
            setSheet("environments");
          }}
          onCreated={async (a, f, sourceId) => {
            if (
              sourceId !== executionSourceId() &&
              a.initialRun?.conversation_id
            ) {
              setSheet("");
              if (newAgentPrompt) setDraft("");
              setNewAgentPrompt("");
              window.dispatchEvent(new Event("loop-source-refresh"));
              setConversation(
                a.initialRun.conversation_id,
                undefined,
                sourceId,
              );
              return;
            }
            if (sourceId !== executionSourceId()) {
              const url = new URL(
                sourceUrl(
                  sourceId,
                  a.initialRun?.conversation_id
                    ? { conversation: a.initialRun.conversation_id }
                    : { agent: a.id },
                ),
                location.origin,
              );
              if (!a.initialRun) url.searchParams.set("compose", "1");
              location.assign(url.pathname + url.search);
              return;
            }
            if (newAgentPrompt) {
              setNewAgentPrompt("");
              setDraft("");
            }
            await bootstrap();
            setSelected(a.id);
            setFolder(f);
            if (!["share", "workflows", "teams"].includes(returnTo))
              setSettingsParent(false);
            if (returnTo === "share") {
              setShareAgent(a.id);
              setSheet("share");
            } else
              setSheet(
                ["workflows", "teams"].includes(returnTo) ? returnTo : "",
              );
            if (
              a.initialRun?.conversation_id &&
              !["share", "workflows", "teams"].includes(returnTo)
            ) {
              setTeamSelection([]);
              setProfile(null);
              setTab("feed");
              setContextArtifact(null);
              setConversation(a.initialRun.conversation_id);
            } else if (
              !a.initialRun &&
              !["share", "workflows", "teams"].includes(returnTo)
            ) {
              setConversation(null);
              setSelected(a.id);
              setTeamSelection([]);
              setProfile(null);
              setContextArtifact(null);
              setReplyContext(null);
              setFolderChoice(undefined);
              setComposerOptions(false);
              afterSheetsClose(focusComposer);
            }
            setReturnTo("");
            setEnvironmentToOpen("");
            setEnvironmentSetupProvider("");
          }}
        />
      )}
      {sheet === "runtime-hosts" && <RuntimeHosts onClose={closeSheet} />}
      {sheet === "environments" && (
        <ExecutionEnvironments
          folders={data.folders}
          connections={data.connections}
          initialEnvironmentId={environmentToOpen}
          onClose={closeSheet}
          onChange={async () => setData(await callRoute(workspaceApi.bootstrap, {}, executionSourceId()))}
          onLegacy={() => setSheet("runtime-hosts")}
        />
      )}
      {sheet === "memory" && (
        <Memory folders={data.folders} onClose={closeSheet} />
      )}
      {sheet === "teams" && (
        <CreateTeam
          agents={data.agents}
          connections={data.connections}
          folders={data.folders}
          initialFolder={reviewTarget?.folder || project || undefined}
          initialPreset={teamPreset}
          onClose={closeSheet}
          onCreateAgent={() => {
            setReturnTo("teams");
            setSheet("create");
          }}
          onCreated={(team) => {
            setTeamPreset(undefined);
            if (team.preset_id === "code-review") {
              setReviewTarget({
                team: team.id,
                folder: team.folder_id || undefined,
              });
              setSheet("codeReview");
              void bootstrap();
              return;
            }
            setReturnToTeamDirectory(false);
            setSettingsParent(false);
            setSheet("");
            setTeamSelection([team.id]);
            setSelected(team.manager_id);
            setContextArtifact(null);
            setTab("feed");
            setConversation(team.conversation_id);
            void bootstrap();
          }}
        />
      )}
      {sheet === "codeReview" && (
        <StartCodeReview
          teams={data.teams || []}
          folders={data.folders}
          initialTeam={reviewTarget?.team}
          initialFolder={reviewTarget?.folder}
          local={capabilities.localProjects}
          onClose={closeSheet}
          onCreateTeam={() => {
            setTeamPreset("code-review");
            setSheet("teams");
          }}
          onStarted={(id) => {
            setSheet("");
            setConversation(id);
            void bootstrap();
          }}
        />
      )}
      {sheet === "teamDirectory" && (
        <TeamDirectory
          teams={data.teams || []}
          folders={data.folders}
          onVisibilityChanged={teamVisibilityChanged}
          agents={data.agents}
          connections={data.connections}
          onClose={closeSheet}
          onCreate={() => {
            setReturnToTeamDirectory(true);
            setSheet("teams");
          }}
          onOpen={openTeamFeed}
          onReview={(team) => {
            setReviewTarget({
              team: team.id,
              folder: team.folder_id || undefined,
            });
            setSheet("codeReview");
          }}
          onChanged={() => void bootstrap()}
        />
      )}
      {teamMessages && (
        <TeamMessages
          team={teamMessages}
          ownerKey={session?.user?.id || ""}
          sourceId={executionSourceId()}
          agents={data.agents}
          onClose={() => setTeamMessages(null)}
          onOpenConversation={(id, source) => {
            setTeamMessages(null);
            setTab("feed");
            setConversation(id, undefined, source);
          }}
          onChanged={() => void bootstrap()}
        />
      )}
      {sheet === "mcp" && (
        <Tools
          onClose={() => {
            closeSheet();
            window.dispatchEvent(new Event(TOOLS_CLOSED));
          }}
        />
      )}
      {(sheet === "pi-customizations" || sheet === "pi-active") && (
        <SourceProvider
          sourceId={actionSource}
          capabilities={threadSource.capabilities || capabilities}
        >
          <PiCustomizations
            agents={composerData.agents}
            agentId={
              activeAgent?.provider === "pi" ? activeAgent.id : undefined
            }
            conversationId={conversation ?? undefined}
            mode={sheet === "pi-active" ? "active" : "library"}
            onClose={closeSheet}
            onUse={(agentId, token) => {
              if (
                agentId !== activeAgent?.id &&
                actionSource !== executionSourceId()
              ) {
                writeThreadDraft(
                  sourceDraftId(GLOBAL_DRAFT, actionSource),
                  token + " ",
                  [],
                  session?.user?.id,
                );
                sessionStorage.setItem("loop-draft-agent", agentId);
                sessionStorage.removeItem("loop-draft-context");
                location.assign(sourceUrl(actionSource, { agent: agentId }));
                return;
              }
              if (agentId !== activeAgent?.id) setConversation(null);
              setSelected(agentId);
              setDraft(token + " ");
              setSettingsParent(false);
              setSheet("");
              requestAnimationFrame(() =>
                document.getElementById("composer")?.focus(),
              );
            }}
          />
        </SourceProvider>
      )}
      {sheet === "agents" && (
        <AgentDirectory
          agents={unified.agents}
          scopedKeys={
            projectFilter || teamSelection.length
              ? scopedAgents.map(
                  (a) => `${executionSourceId() || "laptop"}:${a.id}`,
                )
              : unified.agents
                  .filter((a) => !a.retired_at)
                  .map((a) => `${a.sourceId || "laptop"}:${a.id}`)
          }
          folders={unified.folders.length ? unified.folders : creationFolders}
          onClose={closeSheet}
          onCreate={() => {
            setFolder(projectFilter);
            setSheet("create");
          }}
          onAgent={(a) => {
            setSettingsParent(false);
            setSheet("");
            openSourcedAgent(a);
            afterSheetsClose(() =>
              window.scrollTo({ top: 0, behavior: "instant" }),
            );
          }}
        />
      )}
      {modelAgent && (
        <SourceProvider
          sourceId={actionSource}
          capabilities={threadSource.capabilities || capabilities}
        >
          <AgentModelSettings
            agent={modelAgent}
            connections={composerData.connections}
            onClose={() => setModelAgent(null)}
            onSaved={(saved) => {
              if (viewIdentity !== threadIdentityRef.current) return;
              if (actionSource !== executionSourceId()) {
                if (saved.connection_id !== modelAgent.connection_id) {
                  openSourcedAgent({ ...saved, sourceId: actionSource });
                  return;
                }
                threadSource.retry();
                return;
              }
              if (saved.connection_id !== modelAgent.connection_id) {
                setContextArtifact(null);
                if (
                  replyContext?.agentId === saved.id ||
                  conversationTarget?.agentId === saved.id
                ) {
                  setReplyContext(null);
                  setConversation(null);
                  setComposerExpanded(true);
                }
              }
              if (profile?.id === saved.id) setProfile(saved);
              setModelAgent((current) =>
                current?.id === saved.id ? saved : current,
              );
              setData((old) => ({
                ...old,
                agents: old.agents.map((agent) =>
                  agent.id === saved.id ? saved : agent,
                ),
                teams:
                  saved.connection_id !== modelAgent.connection_id
                    ? old.teams?.map((team) =>
                        team.manager_id === saved.id
                          ? { ...team, conversation_id: null }
                          : team,
                      )
                    : old.teams,
              }));
              threadSource.retry();
              void bootstrap();
            }}
          />
        </SourceProvider>
      )}
      {sheet === "edit-agent" && profile && (
        <Sheet title="Edit agent" onClose={closeSheet}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (editBusy) return;
              setEditBusy(true);
              setEditError("");
              const f = new FormData(e.currentTarget);
              try {
                const a = await api<Agent>(
                  `/agents/${profile.id}`,
                  {
                    name: f.get("name"),
                    instructions: f.get("instructions"),
                    folderId: f.get("folder") || null,
                  },
                  "PATCH",
                );
                setProfile(a);
                await bootstrap();
                setSheet("");
                setDismissNotice("Agent changes saved.");
              } catch (e) {
                setEditError((e as Error).message);
              } finally {
                setEditBusy(false);
              }
            }}
          >
            <label>
              Unique name
              <input name="name" defaultValue={profile.name} />
            </label>
            <label>
              Agent instructions
              <textarea
                name="instructions"
                defaultValue={profile.instructions}
                maxLength={12000}
              />
            </label>
            <p className="field-hint">
              Guidance for every future task, such as the agent’s role, focus,
              or writing style.
            </p>
            <button
              type="button"
              className="secondary"
              onClick={() => setModelAgent(profile)}
            >
              Model, provider & effort
            </button>
            <p className="note">
              Past outputs and running tasks retain their original provider and
              model.
            </p>
            <label>
              Project
              <select
                name="folder"
                aria-label="Project"
                defaultValue={profile.folder_id || ""}
              >
                <option value="">Workspace</option>
                {data.folders
                  .filter((f) => !f.is_workspace)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>
            {editError && (
              <p className="error" role="alert">
                {editError}
              </p>
            )}
            <button className="primary" disabled={editBusy}>
              {editBusy ? "Saving…" : "Save changes"}
            </button>
          </form>
        </Sheet>
      )}
      {sheet === "native-history" && (
        <NativeHistory
          onClose={closeSheet}
          onOpen={(id) => {
            // Opening a thread leaves Settings, which this can be opened from.
            setSettingsParent(false);
            setSheet("");
            setConversation(id);
            void bootstrap();
          }}
        />
      )}
      {conversation && !threadData && (
        <Sheet title="Conversation" onClose={() => setConversation(null)}>
          {threadSource.error ? (
            <>
              <p role={threadSource.rateLimited ? "status" : "alert"}>{threadSource.error}</p>
              <button onClick={threadSource.retry}>Retry connection</button>
            </>
          ) : (
            <p role="status">Loading conversation…</p>
          )}
        </Sheet>
      )}
      {conversation && threadData && (
        <SourceProvider
          key={threadIdentity}
          sourceId={conversationSource}
          capabilities={threadSource.capabilities || capabilities}
        >
          <Conversation
            key={threadIdentity}
            id={conversation}
            messageId={messageId}
            revision={revision}
            sourceStatus={threadSource.error ? {
              message: threadSource.error,
              rateLimited: threadSource.rateLimited,
              retry: threadSource.retry,
            } : undefined}
            onAgentChanged={() => {
              threadSource.retry();
              void bootstrap();
            }}
            onNewConversation={(agent) => {
              if (conversationSource !== executionSourceId()) {
                openSourcedAgent({ ...agent, sourceId: conversationSource });
                return;
              }
              setConversation(null);
              setSelected(agent.id);
              setContextArtifact(null);
              setReplyContext(null);
              setComposerExpanded(true);
            }}
            onProfile={(a) => {
              if (conversationSource !== executionSourceId()) {
                openSourcedAgent({ ...a, sourceId: conversationSource });
                return;
              }
              setConversation(null);
              collapseComposer();
              if (!draft.trim() && !attachments.length) setReplyContext(null);
              setProfile(a);
              afterSheetsClose(() =>
                window.scrollTo({ top: 0, behavior: "instant" }),
              );
            }}
            agents={threadData.agents}
            connections={threadData.connections}
            teams={threadData.teams || []}
            folders={threadData.folders}
            onNotice={setDismissNotice}
            onShowLater={(section, id) =>
              openSourceLater(section, id, conversationSource)
            }
            onWork={setThreadWork}
            onClose={() => {
              setConversation(null);
              setThreadNotice("");
              collapseComposer();
              if (!draft.trim() && !attachments.length) setReplyContext(null);
            }}
            onContinue={(id) => {
              if (viewIdentity === threadIdentityRef.current)
                setConversation(id, undefined, conversationSource);
            }}
            composer={messageComposer}
            readyKey={viewIdentity}
            onReady={(context) => {
              if (viewIdentity !== threadIdentityRef.current) return;
              setConversationTarget(context);
              setSelected(context.agentId);
              setFolderChoice(undefined);
              setContextArtifact(null);
              setReplyContext((current) =>
                current?.agentId === context.agentId &&
                current.conversationId === context.conversationId
                  ? current
                  : context,
              );
              const saved = threadDraft(context.conversationId);
              if (!draft.trim() && saved.text) setDraft(saved.text);
              if (!attachments.length && saved.files.length)
                setAttachments(saved.files);
            }}
            onReply={beginReply}
            onUsePrompt={(text) => {
              if (viewIdentity !== threadIdentityRef.current) return;
              setDraft(text);
              focusComposer();
            }}
            onRestoreDraft={(text, files) => {
              if (viewIdentity === threadIdentityRef.current)
                restoreToComposer(text, files);
            }}
            onWithdraw={withdrawToComposer}
            onSubmitted={() => {
              window.dispatchEvent(new Event("loop-source-refresh"));
              void refresh();
            }}
          />
        </SourceProvider>
      )}
      {activeArtifact && (
        <SourceProvider
          sourceId={activeArtifact.sourceId ?? executionSourceId()}
          capabilities={capabilities}
        >
          <ArtifactViewer
            key={JSON.stringify([
              session.user.id,
              activeArtifact.sourceId ?? executionSourceId(),
              activeArtifact.id,
            ])}
            item={activeArtifact}
            connections={data.connections}
            onProfile={(agent) => {
              setActiveArtifact(null);
              setConversation(null);
              setProfile(agent);
              afterSheetsClose(() =>
                window.scrollTo({ top: 0, behavior: "instant" }),
              );
            }}
            agent={data.agents.find(
              (agent) => agent.id === activeArtifact.agent_id,
            )}
            onClose={() => setActiveArtifact(null)}
            onFile={() => {
              setFiling(activeArtifact);
              setActiveArtifact(null);
            }}
            onConversation={() => {
              const message = parse<any>(activeArtifact.metadata, {}).messageId;
              setConversation(
                activeArtifact.conversation_id,
                message,
                activeArtifact.sourceId ?? executionSourceId(),
              );
              setActiveArtifact(null);
            }}
            onChanged={() => void changed()}
            onReply={() => void replyToArtifact(activeArtifact)}
            onWorkflow={(source) => {
              setWorkflowSource(source);
              setWorkflowId(undefined);
              setActiveArtifact(null);
              setSheet("workflows");
            }}
            onRun={(text) => {
              setDraft(text);
              setActiveArtifact(null);
              focusComposer();
            }}
          />
        </SourceProvider>
      )}
      {filing && (
        <SourceProvider
          sourceId={filing.sourceId ?? executionSourceId()}
          capabilities={capabilities}
        >
          <FileSheet
            key={JSON.stringify([
              session.user.id,
              filing.sourceId ?? executionSourceId(),
              filing.id,
            ])}
            item={filing}
            initialResult={filingResult}
            folders={data.folders}
            onClose={() => {
              setFiling(null);
              setFilingResult(null);
            }}
            onChanged={() => void changed()}
          />
        </SourceProvider>
      )}
      {(sheet === "project" || sheet === "folder-edit") && (
        <FolderForm
          kind={tab === "projects" ? "project" : "folder"}
          existing={
            sheet === "folder-edit"
              ? data.folders.find((f) => f.id === folder)
              : undefined
          }
          folders={data.folders}
          parent={folder}
          onClose={closeSheet}
          onCreated={(created) => {
            if (tab === "projects") {
              setProject(created.id);
              setFolder(created.id);
            }
            void changed();
          }}
        />
      )}
      {sheet === "import" && (
        <ImportSheet
          onClose={() => {
            closeSheet();
            void changed();
          }}
          onChange={() => void changed()}
        />
      )}
      {sheet === "search-settings" && (
        <SearchSettings connections={data.connections} onClose={closeSheet} />
      )}
    </div>
  );
}
