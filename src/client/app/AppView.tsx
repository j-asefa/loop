import { resultTarget } from "../card-actions";
import { LoopLogo } from "../LoopLogo";
import { sessionDraft, type WorkspaceComposerDraft } from "../workspace-drafts";

import { literalEntry, proseEntry } from "../textEntry";
import { renderComposer, renderComposerSendSheets } from "./Composer";
import { workspaceApi } from "../../shared/workspace-api";
import { callRoute } from "../api";
import { StartCodeReview } from "../CodeReview";
import { FleetSettings } from "../FleetSettings";
import { WhenFleetAvailable } from "../FleetContext";
import { SettingsHome } from "../SettingsHome";
import { CardTokens } from "../CardTokens";
import { Webhooks } from "../Webhooks";
import { AgentModelSettings } from "../AgentModelSettings";
import { agentModelName } from "../modelChoices";
import { capabilities } from "../capabilities";
import { SourceProvider } from "../SourceContext";
import { executionSourceId, sourceUrl } from "../sourceRouting";
import { NativeHistory } from "../NativeHistory";
import { AgentDirectory } from "../AgentDirectory";
import {
  FleetCommandReceipts,
  showFleetCommandReceipts,
} from "../FleetCommandReceipts";
import "../fleetCommandReceipts.css";

import { afterSheetsClose } from "../sheetHistory";
import { TeamMessages, CreateTeam, TeamDirectory } from "../Teams";
import { RuntimeHosts } from "../RuntimeHosts";
import { ExecutionEnvironments } from "../ExecutionEnvironments";
import { Memory } from "../Memory";
import { ShareSheet, InstallHelp } from "../Sharing";
import { PwaStatus } from "../Pwa";
import { Notifications } from "../Notifications";
import { RetireAgent } from "../RetireAgent";
import { Tools } from "../Tools";
import { PiCustomizations } from "../PiCustomizations";
import { TOOLS_CLOSED } from "../PullRequests";

import { ActionSheet, LaterSheet, undoReminder } from "../ThreadTools";
import { Toasts, notify } from "../toast";
import {
  GLOBAL_DRAFT,
  sourceDraftId,
  saveThreadDraft as writeThreadDraft,
} from "../drafts";

import {
  Search,
  Plus,
  SlidersHorizontal,
  Folder,
  Users,
  Settings,
  X,
} from "lucide-react";
import { parse } from "../json";
import { NativeConnections } from "../NativeConnections";
import { CreateAgent } from "../CreateAgent";
import {
  FileSheet,
  FolderForm,
  ImportSheet,
  SearchSettings,
} from "../Workspace";
import { ArtifactViewer } from "../ArtifactViewer";
import { Conversation } from "../Conversation";
import { Avatar, Sheet } from "../components";
import { PreviewBanner } from "../PreviewBanner";

import { tabs } from "./AppController";
import type { AppViewProps } from "./AppViewProps";
import { renderResults } from "./Results";
import { renderSessionGate } from "./Session";
import { renderAppPages } from "./AppPages";

export function renderApp(props: AppViewProps) {
  const {
    bootstrapOwner,
    composerOptions,
    setComposerOptions,
    startChat,
    replyQuoted,
    setLatestAgentMessage,
    tab,
    lastNavTap,
    setFeedFilter,
    setFeedHomeKey,
    setTab,
    setProfile,
    setView,
    displayName,
    feedBadgeCount,
    session,
    error,
    check,
    conversation,
    data,
    projectFilter,
    setProjectFilter,
    replyContext,
    runs,
    activeAgent,
    conversationTarget,
    folderChoice,
    contextArtifact,
    selected,
    routePreview,
    busy,
    uploading,
    draft,
    send,
    sendPress,
    composerData,
    availableAgents,
    composerRef,
    composerExpanded,
    sendNotice,
    sentRun,
    setSelected,
    setConversation,
    setSendNotice,
    attachments,
    setContextArtifact,
    setFolderChoice,
    setFolder,
    focusComposer,
    setReplyContext,
    collapseComposer,
    setDraft,
    setComposerExpanded,
    setAttachments,
    composerError,
    setComposerError,
    composerUnavailable,
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
    beginReply,
    open,
    replyToArtifact,
    archiveCard,
    setLaterCard,
    setFiling,
    ownerRef,
    changed,
    setError,
    openCard,
    resultsError,
    items,
    loadResults,
    resultsLoading,
    profile,
    view,
    teamSelection,
    profileWork,
    next,
    setTeamSelection,
    setProject,
    sheet,
    refresh,
    unified,
    openTeamFeed,
    project,
    teamVisibilityChanged,
    setData,
    bootstrap,
    setTeamMessages,
    scopedAgents,
    openSourcedAgent,
    setActiveArtifact,
    revision,
    setSettingsParent,
    setReviewTarget,
    setDismissNotice,
    archivedCard,
    setArchivedCard,
    settingsParent,
    openSettingsPage,
    theme,
    setTheme,
    setSharedDraft,
    setEditError,
    setSearchAgent,
    setSearchScope,
    sendMenu,
    setScheduleAt,
    scheduleAt,
    laterCard,
    openSourceLater,
    closeSheet,
    sharedDraft,
    shareAgent,
    setReturnTo,
    setShareAgent,
    setRevision,
    returnTo,
    folder,
    newAgentPrompt,
    environmentToOpen,
    environmentSetupProvider,
    creationConnections,
    creationFolders,
    setEnvironmentToOpen,
    setEnvironmentSetupProvider,
    setNewAgentPrompt,
    reviewTarget,
    teamPreset,
    setTeamPreset,
    setReturnToTeamDirectory,
    teamMessages,
    actionSource,
    threadSource,
    modelAgent,
    editBusy,
    setEditBusy,
    editError,
    threadData,
    conversationSource,
    messageId,
    setThreadWork,
    setConversationTarget,
    threadDraft,
    restoreToComposer,
    withdrawToComposer,
    activeArtifact,
    filing,
    filingResult,
    setFilingResult,
  } = props;
  const routedComposerStorage = sessionDraft<WorkspaceComposerDraft>(
    session?.user?.id,
    actionSource,
    "composer",
  );
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
          {t.id === "feed" && feedBadgeCount > 0 && (
            <small
              className="running-count"
              aria-label={`${feedBadgeCount} ${feedBadgeCount === 1 ? "item" : "items"} in Feed`}
            >
              {feedBadgeCount > 9 ? "9+" : feedBadgeCount}
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
              : (contextArtifact && resultTarget(contextArtifact))?.agent_id ===
                  activeAgent?.id
                ? (contextArtifact && resultTarget(contextArtifact))?.folder_id
                : activeAgent?.folder_id,
          )) || "Unfiled",
    thread: threadMode
      ? conversationTarget?.title || "This thread"
      : replyContext?.conversationId
        ? replyContext.title || "Its thread"
        : "New thread",
  };
  const { messageComposer, launchComposer } = renderComposer({
    replyQuoted,
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
    composerUnavailable,
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
    profile,
  });
  const { replySaved, resultCard, resultsList } = renderResults({
    beginReply,
    setConversation,
    open,
    replyToArtifact,
    archiveCard,
    setLaterCard,
    setFiling,
    data,
    setProfile,
    ownerRef,
    changed,
    setError,
    openCard,
    resultsError,
    items,
    loadResults,
    resultsLoading,
    profile,
    view,
    projectFilter,
    teamSelection,
    profileWork,
    next,
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
          <LoopLogo />
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
            <LoopLogo />
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
        {!data.preview && (
          <WhenFleetAvailable>
            <FleetCommandReceipts
              owner={session.user.id}
              sources={unified.sources}
            />
          </WhenFleetAvailable>
        )}
        {renderAppPages({
          ...props,
          session,
          projectScope,
          resultsList,
          resultCard,
          replySaved,
          launchComposer,
        })}
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
          {!data.preview && (
            <WhenFleetAvailable>
              <button
                className="text-button"
                onClick={() => {
                  setSettingsParent(false);
                  setSheet("");
                  showFleetCommandReceipts();
                }}
              >
                Check an action receipt
              </button>
            </WhenFleetAvailable>
          )}
          <footer className="drawer-account">
            <Avatar name={displayName} />
            <span>
              <strong>{displayName}</strong>
              <small>Personal workspace</small>
            </span>
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
          targetId={resultTarget(laterCard).id}
          title={resultTarget(laterCard).title}
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
        <Sheet title="Integration tokens" onClose={closeSheet}>
          <CardTokens
            key={session.user.id + ":" + executionSourceId()}
            owner={session.user.id}
            sourceId={executionSourceId()}
          />
          <Webhooks
            key={"webhooks:" + session.user.id + ":" + executionSourceId()}
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
      {sheet === "install" && <InstallHelp onClose={closeSheet} />}
      {sheet === "connections" && (
        <NativeConnections
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
            if (!["share", "teams"].includes(returnTo))
              setSettingsParent(false);
            if (returnTo === "share") {
              setShareAgent(a.id);
              setSheet("share");
            } else setSheet(returnTo === "teams" ? returnTo : "");
            if (
              a.initialRun?.conversation_id &&
              !["share", "teams"].includes(returnTo)
            ) {
              setTeamSelection([]);
              setProfile(null);
              setTab("feed");
              setContextArtifact(null);
              setConversation(a.initialRun.conversation_id);
            } else if (
              !a.initialRun &&
              !["share", "teams"].includes(returnTo)
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
          connections={data.connections}
          onClose={closeSheet}
          onChange={async () =>
            setData(
              await callRoute(workspaceApi.bootstrap, {}, executionSourceId()),
            )
          }
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
                routedComposerStorage.write({
                  selected: agentId,
                  replyContext: null,
                });
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
                const a = await callRoute(
                  workspaceApi.agentUpdate,
                  {
                    params: { id: profile.id },
                    body: {
                      name: String(f.get("name") ?? ""),
                      instructions: String(f.get("instructions") ?? ""),
                      folderId: String(f.get("folder") || "") || null,
                    },
                  },
                  executionSourceId(),
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
              <input
                {...literalEntry}
                name="name"
                defaultValue={profile.name}
              />
            </label>
            <label>
              Agent instructions
              <textarea
                {...proseEntry}
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
              <p role={threadSource.rateLimited ? "status" : "alert"}>
                {threadSource.error}
              </p>
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
            sourceStatus={
              threadSource.error
                ? {
                    message: threadSource.error,
                    rateLimited: threadSource.rateLimited,
                    retry: threadSource.retry,
                  }
                : undefined
            }
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
            onLatestAgentMessage={(latest) => {
              if (viewIdentity === threadIdentityRef.current)
                setLatestAgentMessage(latest);
            }}
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
              resultTarget(activeArtifact).id,
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
              (agent) => agent.id === resultTarget(activeArtifact).agent_id,
            )}
            onClose={() => setActiveArtifact(null)}
            onFile={() => {
              setFiling(activeArtifact);
              setActiveArtifact(null);
            }}
            onConversation={() => {
              const message = activeArtifact.card
                ? activeArtifact.card.source.message_id || undefined
                : parse<any>(activeArtifact.metadata, {}).messageId;
              setConversation(
                resultTarget(activeArtifact).conversation_id,
                message,
                activeArtifact.sourceId ?? executionSourceId(),
              );
              setActiveArtifact(null);
            }}
            onChanged={() => void changed()}
            onReply={() => void replyToArtifact(activeArtifact)}
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
              resultTarget(filing).id,
            ])}
            item={resultTarget(filing)}
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
      {sheet === "fleet" && <FleetSettings onClose={closeSheet} />}
      {sheet === "search-settings" && (
        <SearchSettings connections={data.connections} onClose={closeSheet} />
      )}
    </div>
  );
}
