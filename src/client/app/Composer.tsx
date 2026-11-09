import { proseEntry } from "../textEntry";
import { AutofillBoundary } from "../AutofillBoundary";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  ArrowUp,
  ArrowUpRight,
  X,
  Plus,
  ChevronDown,
  Reply as ReplyIcon,
  Clock3,
  AlarmClock,
  SlidersHorizontal,
} from "lucide-react";
import {
  workspaceApi,
  type Bootstrap as BootstrapResponse,
} from "../../shared/workspace-api";
import type { Agent, Artifact, RunView as Run } from "../../shared/types";
import { MAX_MESSAGE_FILES, type UploadedFile } from "../../shared/uploads";
import { callRoute } from "../workspace-api";
import type { useSourceRoute } from "../SourceContext";
import { executionSourceId } from "../sourceRouting";
import type { CardArtifact } from "../card-actions";
import type { ComposerContext } from "../composerContext";
import { composerLaunchRecipient } from "../composerLaunch";
import type { ThreadWork } from "../Conversation";
import { AttachmentList, UploadButton } from "../Attachments";
import { HarnessPicker } from "../HarnessPicker";
import { VoiceButton } from "../Voice";
import { RichText, Sheet } from "../components";
import { ActionSheet, type useLongPress } from "../ThreadTools";
import { agentModelName, effortName } from "../modelChoices";
import { notify } from "../toast";
import {
  GLOBAL_DRAFT,
  saveThreadDraft as writeThreadDraft,
  clearAcceptedDraft,
  threadDraft as readThreadDraft,
} from "../drafts";
import { settleFailure, type SendReceipt } from "../sendIntent";
import {
  prepareStoredSend,
  settleStoredSend,
  type PreparedSend,
} from "../sendReceiptStore";
import {
  dayLabel,
  laterChoices,
  localInputValue,
  preview,
  timeLabel,
} from "../threadView";

type SendNotice = {
  runId: string;
  conversationId: string | null;
  agentId: string;
  agentName: string;
  steering: boolean;
};
type ComposerProps = {
  session: { user?: { id?: string } } | null | undefined;
  draftId(id: string, source?: string): string;
  conversation: string | null;
  conversationTarget: ComposerContext | null;
  replyContext: ComposerContext | null;
  /** False when the reply answers the agent's latest message; undefined
   * until its thread's fresh snapshot says, which keeps the quote. */
  replyQuoted: boolean | undefined;
  contextArtifact: Artifact | null;
  draft: string;
  attachments: UploadedFile[];
  busy: boolean;
  uploading: boolean;
  selected: string;
  folder: string;
  project: string;
  projectFilter: string;
  folderChoice: string | undefined;
  profile: Agent | null;
  teamSelection: string[];
  activeAgent: Agent | undefined;
  routePreview: {
    signature?: string;
    agent?: Pick<Agent, "id" | "name"> | null;
    reason?: string;
  } | null;
  composerData: Pick<BootstrapResponse, "agents" | "connections" | "folders"> &
    Partial<Pick<BootstrapResponse, "teams">>;
  data: Pick<BootstrapResponse, "agents">;
  availableAgents: Agent[];
  threadIdentity: string;
  viewIdentity: string;
  actionSource: string;
  draftRef: RefObject<string>;
  attachmentsRef: RefObject<UploadedFile[]>;
  threadIdentityRef: RefObject<string>;
  composerIdentityRef: RefObject<string>;
  ownerRef: RefObject<string | undefined>;
  composerRef: RefObject<HTMLElement | null>;
  runsGeneration: RefObject<number>;
  pendingDraftSave: RefObject<{
    key: string;
    owner: string | undefined;
    text: string;
    files: UploadedFile[];
    timer: ReturnType<typeof setTimeout>;
  } | null>;
  request: { current: SendReceipt };
  receiptStorageKey: string;
  draftKey: string;
  threadApi: ReturnType<typeof useSourceRoute>;
  setDraft: Dispatch<SetStateAction<string>>;
  setAttachments: Dispatch<SetStateAction<UploadedFile[]>>;
  setRuns: Dispatch<SetStateAction<Run[]>>;
  setReplyContext: Dispatch<SetStateAction<ComposerContext | null>>;
  setContextArtifact(value: Artifact | null): void;
  setComposerExpanded(value: boolean): void;
  setComposerError(value: string): void;
  setBusy(value: boolean): void;
  setUploading(value: boolean): void;
  setNewAgentPrompt(value: string): void;
  setFolder(value: string): void;
  setSheet(value: string): void;
  setError(value: string): void;
  setFilingResult(value: unknown): void;
  setFiling(value: CardArtifact | null): void;
  setRoutePreview(value: unknown): void;
  setSendNotice(value: SendNotice | null): void;
  setThreadNotice(value: string): void;
  setDismissNotice(value: string): void;
  setSelected(value: string): void;
  setConversation(id: string | null): void;
  setFolderChoice(value: string | undefined): void;
  setModelAgent(value: Agent | null): void;
  setSendMenu(value: boolean): void;
  setScheduleAt(value: string | null): void;
  changed(): Promise<void>;
  refresh(): Promise<void>;
  withdrawToComposer(runId: string): Promise<unknown>;
  saveThreadDraft(
    id: string,
    text: string,
    files: UploadedFile[],
    owner?: string,
  ): void;
  openSourceLater(
    section: "scheduled" | "reminders",
    focusId: string | undefined,
    source: string,
  ): void;
  collapseComposer(): void;
  focusComposer(): void;
  send(options?: { queue?: boolean; sendAt?: number }): Promise<void>;
  sendPress: ReturnType<typeof useLongPress>;
  threadMode: boolean;
  steersActive: boolean;
  destination: { agent: string; project: string; thread: string };
  composerExpanded: boolean;
  workspaceReady: boolean;
  composerOptions: boolean;
  setComposerOptions: Dispatch<SetStateAction<boolean>>;
  startChat(): void;
  sendNotice: SendNotice | null;
  sentRun: Run | undefined;
  composerError: string;
  composerUnavailable?: string;
  threadWork: ThreadWork | null;
  threadNotice: string;
  sendMenu: boolean;
  scheduleAt: string | null;
};

export function useComposerDraft({
  draftId,
  conversation,
  session,
  draftRef,
  attachmentsRef,
  setDraft,
  setAttachments,
  setComposerExpanded,
  setComposerError,
  setBusy,
  setUploading,
  draft,
  attachments,
}: Pick<
  ComposerProps,
  | "draftId"
  | "conversation"
  | "session"
  | "draftRef"
  | "attachmentsRef"
  | "setDraft"
  | "setAttachments"
  | "setComposerExpanded"
  | "setComposerError"
  | "setBusy"
  | "setUploading"
  | "draft"
  | "attachments"
>) {
  // Each thread keeps its own unsent draft (and the global composer keeps its
  // own), so switching threads never carries text into the wrong one.
  const draftKey = draftId(conversation || GLOBAL_DRAFT);
  const draftOwner = useRef({ key: draftKey, owner: session?.user?.id });
  const draftLoadedFor = useRef<string | null>(null);
  const pendingDraftSave = useRef<{
    key: string;
    owner: string | undefined;
    text: string;
    files: UploadedFile[];
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  useLayoutEffect(() => {
    if (!session?.user?.id) {
      draftLoadedFor.current = null;
      return;
    }
    const previous = draftOwner.current;
    if (
      previous.key === draftKey &&
      previous.owner === session.user.id &&
      draftLoadedFor.current === draftKey
    )
      return;
    if (previous.owner && draftLoadedFor.current === previous.key)
      writeThreadDraft(
        previous.key,
        draftRef.current,
        attachmentsRef.current,
        previous.owner,
      );
    draftOwner.current = { key: draftKey, owner: session.user.id };
    const next = readThreadDraft(draftKey, session.user.id);
    setDraft(next.text);
    setAttachments(next.files);
    setComposerExpanded(false);
    setComposerError("");
    setBusy(false);
    setUploading(false);
    draftLoadedFor.current = draftKey;
  }, [draftKey, session?.user?.id]);
  // Bind the pending save to the committed composer before it can send.
  // Acceptance cancels it synchronously, before a passive cleanup could run.
  useLayoutEffect(() => {
    if (draftLoadedFor.current !== draftKey) return;
    const owner = session?.user?.id;
    const pending = {
      key: draftKey,
      owner,
      text: draft,
      files: attachments,
      timer: setTimeout(() => {
        if (pendingDraftSave.current === pending)
          pendingDraftSave.current = null;
        writeThreadDraft(draftKey, draft, attachments, owner);
      }, 400),
    };
    pendingDraftSave.current = pending;
    return () => {
      clearTimeout(pending.timer);
      if (pendingDraftSave.current === pending) pendingDraftSave.current = null;
    };
  }, [draft, attachments, draftKey, session?.user?.id]);
  // Flush before reload/backgrounding even when the short typing debounce has
  // not fired. The captured owner/source prevents an unscoped session draft
  // from being restored into whichever conversation opens next.
  useEffect(() => {
    const flush = () => {
      const previous = draftOwner.current;
      if (previous.owner && draftLoadedFor.current === previous.key)
        writeThreadDraft(
          previous.key,
          draftRef.current,
          attachmentsRef.current,
          previous.owner,
        );
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);
  return { draftKey, draftOwner, draftLoadedFor, pendingDraftSave };
}

export function useComposerSend({
  replyQuoted,
  busy,
  uploading,
  draft,
  conversation,
  conversationTarget,
  viewIdentity,
  threadIdentityRef,
  threadIdentity,
  composerIdentityRef,
  draftRef,
  attachmentsRef,
  attachments,
  setNewAgentPrompt,
  setFolder,
  projectFilter,
  project,
  setSheet,
  replyContext,
  contextArtifact,
  setError,
  threadApi,
  setFilingResult,
  setFiling,
  setDraft,
  changed,
  selected,
  routePreview,
  folder,
  setBusy,
  setRoutePreview,
  activeAgent,
  setComposerError,
  composerUnavailable,
  ownerRef,
  composerData,
  profile,
  teamSelection,
  folderChoice,
  draftId,
  request,
  receiptStorageKey,
  pendingDraftSave,
  draftKey,
  openSourceLater,
  actionSource,
  setAttachments,
  setReplyContext,
  collapseComposer,
  runsGeneration,
  setRuns,
  setSendNotice,
  saveThreadDraft,
  setContextArtifact,
  withdrawToComposer,
  refresh,
  setThreadNotice,
  setDismissNotice,
}: Pick<
  ComposerProps,
  | "busy"
  | "uploading"
  | "draft"
  | "conversation"
  | "conversationTarget"
  | "viewIdentity"
  | "threadIdentityRef"
  | "threadIdentity"
  | "composerIdentityRef"
  | "draftRef"
  | "attachmentsRef"
  | "attachments"
  | "setNewAgentPrompt"
  | "setFolder"
  | "projectFilter"
  | "project"
  | "setSheet"
  | "replyContext"
  | "replyQuoted"
  | "contextArtifact"
  | "setError"
  | "threadApi"
  | "setFilingResult"
  | "setFiling"
  | "setDraft"
  | "changed"
  | "selected"
  | "routePreview"
  | "folder"
  | "setBusy"
  | "setRoutePreview"
  | "activeAgent"
  | "setComposerError"
  | "composerUnavailable"
  | "ownerRef"
  | "composerData"
  | "profile"
  | "teamSelection"
  | "folderChoice"
  | "draftId"
  | "request"
  | "receiptStorageKey"
  | "pendingDraftSave"
  | "draftKey"
  | "openSourceLater"
  | "actionSource"
  | "setAttachments"
  | "setReplyContext"
  | "collapseComposer"
  | "runsGeneration"
  | "setRuns"
  | "setSendNotice"
  | "saveThreadDraft"
  | "setContextArtifact"
  | "withdrawToComposer"
  | "refresh"
  | "setThreadNotice"
  | "setDismissNotice"
>) {
  async function send(options: { queue?: boolean; sendAt?: number } = {}) {
    if (composerUnavailable) {
      setComposerError(composerUnavailable);
      return;
    }
    if (
      busy ||
      uploading ||
      !draft.trim() ||
      (conversation && !conversationTarget)
    )
      return;
    const currentView = () => viewIdentity === threadIdentityRef.current;
    const sameComposer = () =>
      threadIdentity === composerIdentityRef.current &&
      draftRef.current === draft &&
      JSON.stringify(attachmentsRef.current.map((file) => file.id)) ===
        JSON.stringify(attachments.map((file) => file.id));
    if (/^@new\b/i.test(draft.trim())) {
      // "@new …" creates an agent and starts it with the rest of the message.
      setNewAgentPrompt(draft.trim().replace(/^@new\s*/i, ""));
      setFolder(projectFilter || project || "");
      setSheet("create");
      return;
    }
    if (
      !replyContext &&
      !conversation &&
      /^(put|move|file|organize)\b[\s\S]*\b(in|into|to)\b/i.test(draft)
    ) {
      if (!contextArtifact) {
        setError(
          "Open the output you want to organize first, then enter your filing instruction.",
        );
        return;
      }
      try {
        const result = await threadApi(workspaceApi.artifactMove, {
          params: { id: contextArtifact.id },
          body: { command: draft },
        });
        setFilingResult(result);
        setFiling(contextArtifact);
        setDraft("");
        await changed();
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    if (
      selected === "__route__" &&
      routePreview?.signature !== JSON.stringify([draft, folder])
    ) {
      setBusy(true);
      try {
        const result = await threadApi(workspaceApi.routingPreview, {
          body: { input: draft, folderId: folder || undefined },
        });
        if (!currentView() || !sameComposer()) return;
        setRoutePreview({
          ...result,
          signature: JSON.stringify([draft, folder]),
        });
        if (!result.agent) setSheet("create");
      } catch (e) {
        if (currentView() && sameComposer()) setError((e as Error).message);
      } finally {
        if (currentView()) setBusy(false);
      }
      return;
    }
    if (!activeAgent) {
      setSheet("create");
      return;
    }
    if (!draft.trim()) return;
    setBusy(true);
    setComposerError("");
    const owner = ownerRef.current;
    let sentReceipt: SendReceipt | undefined;
    try {
      let recipient = activeAgent;
      if (draft.trim().startsWith("@")) {
        const route = await threadApi(workspaceApi.sharePreview, {
          body: { question: draft },
        });
        if (!currentView() || !sameComposer()) return;
        recipient = composerData.agents.find((a) => a.id === route.agent?.id)!;
        if (!recipient) throw new Error("Choose an accessible @agent.");
      }
      const managerTeam = composerData.teams?.find(
        (t) =>
          t.manager_id === recipient.id &&
          (profile || !teamSelection.length || teamSelection.includes(t.id)),
      );
      const reply =
        replyContext?.agentId === recipient.id ? replyContext : undefined;
      const currentConversation =
        conversation && conversationTarget?.agentId === recipient.id
          ? conversationTarget.conversationId
          : undefined;
      const conversationId =
        reply?.conversationId ||
        currentConversation ||
        (managerTeam
          ? managerTeam.conversation_id || undefined
          : contextArtifact?.agent_id === recipient.id
            ? contextArtifact.conversation_id || undefined
            : teamSelection.length === 1 &&
                composerData.teams?.find((t) => t.id === teamSelection[0])
                  ?.manager_id === recipient.id
              ? composerData.teams.find((t) => t.id === teamSelection[0])!
                  .conversation_id || undefined
              : undefined);
      const signature = JSON.stringify([
        recipient.id,
        draft,
        folderChoice,
        conversationId,
        reply?.messageId,
        reply?.excerpt ? reply.content : null,
        attachments.map((file) => file.id),
      ]);
      // The send's mode and exact time travel with its key: a retry after a
      // lost response repeats the same request rather than a changed one.
      // Another tab, or this app before a restart, may hold this exact
      // message's uncertain receipt; it wins over this composer's own.
      const sendPrepared = async (plan: PreparedSend) => {
        const quotedId = plan.receipt.unquoted ? undefined : reply?.messageId;
        request.current = plan.receipt;
        sentReceipt = plan.receipt;
        const reconciled = plan.reconciled
          ? plan.intent.mode === "schedule"
            ? ` Your earlier request went through as first sent: scheduled for ${dayLabel(plan.intent.sendAt!).toLowerCase()} at ${timeLabel(plan.intent.sendAt!)}. Change it in Later → Scheduled.`
            : " Your earlier request went through as first sent."
          : "";
        options =
          plan.intent.mode === "schedule"
            ? { sendAt: plan.intent.sendAt! }
            : plan.intent.mode === "queue"
              ? { queue: true }
              : {};
        const body = {
          agentId: recipient.id,
          conversationId,
          replyToMessageId: quotedId,
          replyExcerpt: quotedId && reply?.excerpt ? reply.content : undefined,
          input: draft,
          idempotencyKey: request.current.key,
          attachmentIds: attachments.map((file) => file.id),
          folderId:
            folderChoice !== undefined
              ? folderChoice || null
              : conversationId
                ? undefined
                : recipient.folder_id || undefined,
        };
        const settleAccepted = async () => {
          const pending = pendingDraftSave.current;
          if (
            pending?.key === draftKey &&
            pending.owner === owner &&
            pending.text === draft &&
            JSON.stringify(pending.files.map((file) => file.id)) ===
              JSON.stringify(attachments.map((file) => file.id))
          ) {
            clearTimeout(pending.timer);
            pendingDraftSave.current = null;
          }
          clearAcceptedDraft(draftKey, draft, attachments, owner);
          if (
            request.current.key === sentReceipt!.key &&
            request.current.attempt === sentReceipt!.attempt
          )
            request.current = { signature: "", key: "", unquoted: false };
          await settleStoredSend(
            localStorage,
            receiptStorageKey,
            sentReceipt!,
            null,
          );
          window.dispatchEvent(new Event("loop-source-refresh"));
          window.dispatchEvent(new Event("loop-later-change"));
        };
        if (options.sendAt) {
          const row = await threadApi(workspaceApi.scheduledSendCreate, {
            body: { ...body, sendAt: options.sendAt },
          });
          await settleAccepted();
          if (owner !== ownerRef.current) return;
          const when = `${dayLabel(options.sendAt).toLowerCase()} at ${timeLabel(options.sendAt)}`;
          const text = draft;
          // Undo cancels it while it is still waiting; once it has been sent,
          // the server refuses and says so.
          notify({
            text: `Scheduled for @${recipient.name}, ${when}.${!sameComposer() ? " Your current draft has been kept." : ""}${reconciled}`,
            link: {
              label: "View",
              onSelect: () =>
                openSourceLater("scheduled", row.id, actionSource),
            },
            undo: async () => {
              await threadApi(workspaceApi.scheduledSendCancel, {
                params: { id: row.id },
              });
              window.dispatchEvent(new Event("loop-scheduled-change"));
              if (currentView())
                setDraft((current) => (current.trim() ? current : text));
            },
          });
          window.dispatchEvent(new Event("loop-scheduled-change"));
          if (!sameComposer()) return;
          setDraft("");
          setAttachments([]);
          setReplyContext(
            conversation && conversationTarget ? conversationTarget : null,
          );
          if (!conversation) collapseComposer();
          return;
        }
        const accepted = await callRoute(
          workspaceApi.submit,
          {
            body: {
              ...body,
              ...(options.queue ? { queue: true } : {}),
            },
          },
          actionSource,
        );
        await settleAccepted();
        if (owner !== ownerRef.current) return;
        try {
          localStorage.setItem(
            `loop-last-recipient:${JSON.stringify([owner, actionSource || "laptop"])}`,
            accepted.agent_id || recipient.id,
          );
        } catch {
          // Storage restrictions must not turn an accepted send into an error.
        }
        const unchanged = sameComposer();
        if (!unchanged)
          notify({
            text: `${options.queue ? "Queued for" : "Sent to"} @${recipient.name}. Your current draft has been kept.${reconciled}`,
          });
        // Publish the confirmed receipt before any background refresh. Discard
        // older reads so a response started before this send cannot erase it.
        ++runsGeneration.current;
        if (
          actionSource === executionSourceId() &&
          accepted.agent_id &&
          accepted.state
        )
          setRuns((old) => [
            { ...old.find((run) => run.id === accepted.id), ...accepted },
            ...old.filter((run) => run.id !== accepted.id),
          ]);
        if (!unchanged) return;
        if (!conversation)
          setSendNotice({
            runId: accepted.id,
            conversationId: accepted.conversation_id || conversationId || null,
            agentId: recipient.id,
            agentName: recipient.name,
            steering: Boolean(accepted.steeringId),
          });
        setDraft("");
        setAttachments([]);
        if (conversationId) saveThreadDraft(conversationId, "", []);
        // Stay in the thread after sending; its reply context returns to the
        // conversation itself rather than the quoted message.
        setReplyContext(
          conversation && conversationTarget ? conversationTarget : null,
        );
        setContextArtifact(null);
        if (options.queue && conversation)
          notify({
            text: "Queued after the current task." + reconciled,
            // Undo takes it back to a draft, only while it has not started.
            undo: async () => {
              await withdrawToComposer(accepted.id);
              void refresh();
            },
          });
        else if (reconciled && conversation) setThreadNotice(reconciled.trim());
        else if (reconciled) setDismissNotice(reconciled.trim());
        if (!conversation) collapseComposer();
        else document.querySelector<HTMLTextAreaElement>("#composer")?.blur();
        void refresh().catch((e) => setError(e.message));
      };
      const plan = await prepareStoredSend(
        localStorage,
        receiptStorageKey,
        signature,
        request.current,
        {
          mode: options.sendAt ? "schedule" : options.queue ? "queue" : "send",
          sendAt: options.sendAt ?? null,
        },
        !!reply?.messageId && !reply.excerpt && replyQuoted === false,
        () => owner === ownerRef.current && currentView() && sameComposer(),
        sendPrepared,
      );
      await plan?.completion;
    } catch (e) {
      // A refusal means nothing was accepted, so a different choice may be
      // sent next; anything else stays pending and is retried as first sent.
      if (sentReceipt) {
        const failed = settleFailure(
          sentReceipt,
          (e as { status?: number }).status,
          (e as { executionOutcome?: string }).executionOutcome,
        );
        if (
          request.current.key === sentReceipt.key &&
          request.current.attempt === sentReceipt.attempt
        )
          request.current = failed;
        await settleStoredSend(
          localStorage,
          receiptStorageKey,
          sentReceipt,
          failed,
        );
      }
      if (owner === ownerRef.current && currentView() && sameComposer())
        setComposerError((e as Error).message);
    } finally {
      if (currentView()) setBusy(false);
    }
  }
  return send;
}

// Keep the JSX in App's render tree; this pure builder adds no component boundary.
export function renderComposer({
  replyContext,
  replyQuoted,
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
  workspaceReady,
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
}: Pick<
  ComposerProps,
  | "profile"
  | "replyContext"
  | "replyQuoted"
  | "contextArtifact"
  | "conversation"
  | "threadMode"
  | "selected"
  | "routePreview"
  | "busy"
  | "uploading"
  | "draft"
  | "activeAgent"
  | "conversationTarget"
  | "send"
  | "sendPress"
  | "composerData"
  | "availableAgents"
  | "composerRef"
  | "composerExpanded"
  | "sendNotice"
  | "workspaceReady"
  | "composerOptions"
  | "setComposerOptions"
  | "startChat"
  | "sentRun"
  | "setSelected"
  | "setConversation"
  | "setSendNotice"
  | "attachments"
  | "session"
  | "setContextArtifact"
  | "setFolderChoice"
  | "setFolder"
  | "focusComposer"
  | "destination"
  | "data"
  | "setReplyContext"
  | "collapseComposer"
  | "steersActive"
  | "setDraft"
  | "setComposerExpanded"
  | "setAttachments"
  | "composerError"
  | "setComposerError"
  | "composerUnavailable"
  | "folderChoice"
  | "threadIdentity"
  | "setUploading"
  | "viewIdentity"
  | "threadIdentityRef"
  | "attachmentsRef"
  | "setSheet"
  | "setModelAgent"
  | "setSendMenu"
  | "threadWork"
  | "threadNotice"
  | "setThreadNotice"
>) {
  // Undecided shows the quote: a send before the thread's fresh snapshot
  // keeps the reference, so the composer shows what will be sent.
  const quoted =
    replyQuoted !== false &&
    replyContext?.content &&
    (replyContext.messageId || replyContext.artifactId || !conversation)
      ? replyContext
      : null;
  const sendButton = (
    <button
      className={"send-button" + (threadMode ? " round" : "")}
      aria-label={
        selected === "__route__" && !routePreview
          ? "Preview route"
          : replyContext || conversation
            ? "Send reply"
            : "Send message"
      }
      title={
        composerUnavailable ||
        (threadMode ? undefined : "Hold for more send options")
      }
      disabled={
        !!composerUnavailable ||
        busy ||
        uploading ||
        !draft.trim() ||
        !!activeAgent?.retired_at ||
        !!(conversation && !conversationTarget)
      }
      onClick={() => void send()}
      {...sendPress}
    >
      {!threadMode &&
        (busy
          ? "Sending…"
          : selected === "__route__" && !routePreview
            ? "Preview"
            : "Send")}
      <ArrowUp size={19} />
    </button>
  );
  const launchComposer = () => {
    if (!(conversation ? composerData.agents : availableAgents).length) {
      startChat();
      return;
    }
    if (!draft.trim() && !attachments.length && !replyContext) {
      let last: string | null = null;
      try {
        last = localStorage.getItem(
          `loop-last-recipient:${JSON.stringify([session?.user?.id, executionSourceId() || "laptop"])}`,
        );
      } catch {
        // Storage unavailable: the profile default below still applies, and
        // otherwise the current recipient is kept.
      }
      // On an agent's profile page, "+" addresses that agent; elsewhere the
      // last recipient is restored.
      const agent = composerLaunchRecipient(
        availableAgents,
        conversation ? null : profile,
        last,
      );
      if (agent) {
        setSelected(agent.id);
        setContextArtifact(null);
        setFolderChoice(undefined);
        setFolder(agent.folder_id || "");
      }
    }
    focusComposer();
  };
  const messageComposer =
    (conversation ? composerData.agents : availableAgents).length > 0 ? (
      <section
        ref={composerRef}
        className={
          "composer-dock " +
          (composerExpanded ? "expanded" : "collapsed") +
          (threadMode ? " thread-mode" : "")
        }
      >
        {sendNotice && !composerExpanded && !conversation && (
          <div className="send-confirmation" role="status">
            <span>
              {sendNotice.steering
                ? "Follow-up accepted for"
                : sentRun?.state === "queued"
                  ? "Queued for"
                  : ["running", "pausing", "waiting_children"].includes(
                        sentRun?.state || "",
                      )
                    ? "Running with"
                    : "Message sent to"}{" "}
              <strong>@{sendNotice.agentName}</strong>
            </span>
            {sendNotice.conversationId && (
              <button
                className="text-button"
                onClick={() => {
                  setSelected(sendNotice.agentId);
                  setConversation(sendNotice.conversationId);
                  setSendNotice(null);
                }}
              >
                View conversation <ArrowUpRight size={16} />
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Dismiss send confirmation"
              onClick={() => setSendNotice(null)}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {!composerExpanded && !threadMode && (
          <button
            className={"composer-launch" + (draft ? " has-draft" : "")}
            onClick={launchComposer}
            aria-label="Compose a message"
            aria-expanded={false}
            title={
              (draft
                ? `Continue draft to @${activeAgent?.name || "agent"}`
                : activeAgent
                  ? `New task for @${activeAgent.name}`
                  : "New task") +
              (activeAgent ? ` · ${destination.project}` : "")
            }
          >
            <Plus size={26} aria-hidden="true" />
          </button>
        )}
        <div className="composer" hidden={!composerExpanded && !threadMode}>
          <div className="composer-body">
            {!threadMode && (
              <div className="composer-heading">
                <label className="composer-field">
                  <span className="sr-only">Send to</span>
                  <select
                    aria-label="Agent recipient"
                    disabled={busy || uploading}
                    value={
                      selected === "__route__"
                        ? "__route__"
                        : activeAgent?.id || ""
                    }
                    onChange={(e) => {
                      setSelected(e.target.value);
                      setReplyContext(null);
                      setContextArtifact(null);
                      setFolderChoice(undefined);
                      const agent = data.agents.find(
                        (a) => a.id === e.target.value,
                      );
                      if (agent) setFolder(agent.folder_id || "");
                    }}
                  >
                    {!availableAgents.length && (
                      <option value="">Choose your first agent</option>
                    )}
                    {(composerOptions || selected === "__route__") && (
                      <option value="__route__">Let Loop choose</option>
                    )}
                    {activeAgent?.retired_at && (
                      <option value={activeAgent.id} disabled>
                        @{activeAgent.name} · Retired
                      </option>
                    )}
                    {availableAgents.map((a) => (
                      <option value={a.id} key={a.id}>
                        @{a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="composer-collapse text-button"
                  onPointerDown={(event) => {
                    // Keep the keyboard layout until the click; an early blur
                    // can move Minimize away from mouseup in mobile WebKit.
                    if (event.pointerType === "mouse" && event.button === 0)
                      event.preventDefault();
                  }}
                  onClick={collapseComposer}
                  aria-label="Collapse composer"
                >
                  <ChevronDown size={18} /> Minimize
                </button>
              </div>
            )}
            {!threadMode &&
              activeAgent &&
              selected !== "__route__" &&
              (steersActive ||
                replyContext ||
                !["Unfiled", "Workspace"].includes(destination.project)) && (
                <p className="composer-destination">
                  {steersActive
                    ? "Continues the current task"
                    : replyContext
                      ? destination.thread
                      : destination.project}
                </p>
              )}
            {activeAgent?.retired_at && (
              <p className="note">
                This agent is retired. Restore it from its profile to send new
                work.
              </p>
            )}
            {selected === "__route__" && routePreview && (
              <p className="route-preview">
                {routePreview.agent
                  ? "Recipient: @" + routePreview.agent.name + " · "
                  : ""}
                {routePreview.reason}
              </p>
            )}
            {quoted && (
              <div className="composer-reply-chip">
                <ReplyIcon size={16} aria-hidden="true" />
                <details className="composer-quote-toggle">
                  <summary>
                    Replying to {quoted.excerpt ? "part of " : ""}
                    {quoted.mine
                      ? "your message"
                      : "@" +
                        (activeAgent?.name || "agent") +
                        (quoted.excerpt ? "'s message" : "")}
                    : <span>{preview(quoted.content!, 80)}</span>
                  </summary>
                  <div
                    className="composer-quote"
                    role="region"
                    aria-label="Original message"
                    tabIndex={0}
                  >
                    <RichText content={quoted.content!} compact />
                  </div>
                </details>
                <button
                  className="icon-button"
                  aria-label="Clear reply context"
                  onClick={() =>
                    setReplyContext(
                      conversation && conversationTarget
                        ? conversationTarget
                        : null,
                    )
                  }
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {!replyContext && contextArtifact && (
              <div className="context-strip">
                <span>About: {contextArtifact.title}</span>
                <button
                  aria-label="Clear conversation context"
                  onClick={() => setContextArtifact(null)}
                >
                  ×
                </button>
              </div>
            )}
            <div className="composer-main">
              <AutofillBoundary>
                <textarea
                  {...proseEntry}
                  id="composer"
                  aria-label={
                    replyContext || conversation
                      ? "Reply to agent"
                      : "Message your agent"
                  }
                  disabled={busy}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={() => {
                    if (threadMode) setComposerExpanded(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setComposerExpanded(false);
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={
                    threadMode
                      ? `Reply to ${(activeAgent?.name || "agent").replace(/^./, (c) => c.toUpperCase())}…`
                      : "Ask anything…"
                  }
                  rows={threadMode ? 1 : 2}
                />
              </AutofillBoundary>
              {draft.length > 0 && (
                <button
                  type="button"
                  className="icon-button composer-clear"
                  aria-label="Clear message"
                  disabled={busy}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setDraft("");
                    document.getElementById("composer")?.focus();
                  }}
                >
                  <X size={18} aria-hidden="true" />
                </button>
              )}
              {threadMode && sendButton}
            </div>
            <AttachmentList
              files={attachments}
              onRemove={(id) =>
                setAttachments(attachments.filter((file) => file.id !== id))
              }
            />
            {composerUnavailable && (
              <p className="field-hint" role="status">
                {composerUnavailable}
              </p>
            )}
            {composerError && (
              <div className="composer-error error" role="alert">
                {composerError}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setComposerError("")}
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
          <div className="composer-actions">
            <UploadButton
              key={threadIdentity}
              menu
              folderId={folderChoice ?? activeAgent?.folder_id}
              agentId={activeAgent?.id}
              disabled={busy}
              remaining={MAX_MESSAGE_FILES - attachments.length}
              onBusy={setUploading}
              onUploaded={(file) => {
                if (viewIdentity !== threadIdentityRef.current) return;
                attachmentsRef.current = [...attachmentsRef.current, file];
                setAttachments(attachmentsRef.current);
              }}
            />
            <VoiceButton value={draft} onChange={setDraft} disabled={busy} />
            <button
              type="button"
              className="icon-button composer-options-toggle"
              aria-label="Chat options"
              title="Chat options"
              aria-expanded={composerOptions}
              aria-controls="composer-options"
              onClick={() => setComposerOptions((open) => !open)}
            >
              <SlidersHorizontal size={18} />
            </button>
            <HarnessPicker
              compact
              showTrigger={composerOptions}
              conversationId={
                replyContext?.conversationId || (conversation ?? undefined)
              }
              agentId={selected === "__route__" ? undefined : activeAgent?.id}
              value={draft}
              onChange={setDraft}
              focusInput={() => document.getElementById("composer")?.focus()}
            />
            {!threadMode && sendButton}
          </div>
          <div
            id="composer-options"
            className="composer-options"
            hidden={!composerOptions}
          >
            {activeAgent?.provider === "pi" && (
              <button
                type="button"
                className="text-button pi-active-trigger"
                onClick={() => setSheet("pi-active")}
              >
                Active in this chat
              </button>
            )}
            <button
              type="button"
              className="composer-model"
              aria-label="Select model and effort"
              aria-haspopup="dialog"
              disabled={!activeAgent}
              onClick={() => activeAgent && setModelAgent(activeAgent)}
            >
              {activeAgent ? (
                <>
                  <span className="composer-model-label">
                    <span className="composer-model-name">
                      {agentModelName(activeAgent, composerData.connections)}
                    </span>
                    {!threadMode && (
                      <small className="composer-effort">
                        {effortName(activeAgent.effort)} effort
                      </small>
                    )}
                  </span>
                  <ChevronDown size={15} />
                </>
              ) : (
                "Select an agent"
              )}
            </button>
            {/* In a thread the clock appears with a draft, like send. */}
            {(!threadMode || draft.trim()) && (
              <button
                type="button"
                className="icon-button composer-later"
                aria-label="Send later"
                title="Send later or after the current task"
                disabled={!draft.trim() || busy}
                onClick={() => setSendMenu(true)}
              >
                <Clock3 size={18} />
              </button>
            )}
          </div>
          {threadMode && threadWork && draft.trim() && (
            <p className="field-hint composer-intent">
              {threadWork.steerable
                ? `Send steers @${destination.agent}’s current task.`
                : `Send waits for @${destination.agent}’s current task.`}
            </p>
          )}
          {threadNotice && threadMode && (
            <p className="field-hint composer-notice" role="status">
              {threadNotice}
              <button
                type="button"
                className="text-button"
                onClick={() => setThreadNotice("")}
              >
                OK
              </button>
            </p>
          )}
        </div>
      </section>
    ) : workspaceReady && !conversation ? (
      <section className="composer-dock collapsed">
        <button
          className="composer-launch"
          onClick={startChat}
          aria-label="Compose a message"
        >
          <Plus size={26} aria-hidden="true" />
        </button>
      </section>
    ) : null;
  return { messageComposer, launchComposer };
}

export function renderComposerSendSheets({
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
}: Pick<
  ComposerProps,
  | "sendMenu"
  | "setSendMenu"
  | "threadMode"
  | "threadWork"
  | "destination"
  | "send"
  | "steersActive"
  | "setScheduleAt"
  | "scheduleAt"
  | "draft"
  | "busy"
  | "setComposerError"
>) {
  return (
    <>
      {sendMenu && (
        <ActionSheet
          title="Send options"
          onClose={() => setSendMenu(false)}
          actions={[
            threadMode && threadWork?.steerable
              ? {
                  id: "steer",
                  label: "Steer current task",
                  hint: `Delivered to @${destination.agent} now, while it works`,
                  icon: <ArrowUp size={20} />,
                  onSelect: () => void send(),
                }
              : {
                  id: "now",
                  label: "Send now",
                  hint:
                    threadMode && threadWork
                      ? `@${destination.agent} can’t take messages mid-task, so this waits for the current task`
                      : steersActive
                        ? `Goes to @${destination.agent}’s current task, which it steers`
                        : undefined,
                  icon: <ArrowUp size={20} />,
                  onSelect: () => void send(),
                },
            {
              id: "queue",
              label:
                threadMode && threadWork
                  ? "Queue after this task"
                  : "Queue after current work",
              hint: "Held until the agent’s earlier work ends, and while it is paused. Edit, cancel or move it back to a draft until it starts.",
              icon: <Clock3 size={20} />,
              onSelect: () => void send({ queue: true }),
            },
            {
              id: "later",
              label: "Send later at a time…",
              hint: "Choose when. Edit or cancel it in Later → Scheduled.",
              icon: <AlarmClock size={20} />,
              onSelect: () =>
                setScheduleAt(localInputValue(Date.now() + 3600_000)),
            },
          ]}
        >
          <p className="send-destination">
            To <strong>@{destination.agent}</strong> ·{" "}
            <strong>{destination.project}</strong> · {destination.thread}
          </p>
        </ActionSheet>
      )}
      {scheduleAt !== null && (
        <Sheet title="Send later" onClose={() => setScheduleAt(null)}>
          <dl className="send-summary">
            <dt>To</dt>
            <dd>@{destination.agent}</dd>
            <dt>Project</dt>
            <dd>{destination.project}</dd>
            <dt>Thread</dt>
            <dd>{destination.thread}</dd>
            <dt>Message</dt>
            <dd className="send-summary-text">{preview(draft, 140)}</dd>
          </dl>
          <div className="chip-row" role="group" aria-label="Quick times">
            {laterChoices(Date.now())
              .filter((choice) => choice.condition === "time")
              .map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className="chip"
                  aria-pressed={
                    !!choice.dueAt &&
                    scheduleAt === localInputValue(choice.dueAt)
                  }
                  onClick={() => setScheduleAt(localInputValue(choice.dueAt!))}
                >
                  {choice.label}
                </button>
              ))}
          </div>
          <label>
            Send at (your time,{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone})
            <input
              type="datetime-local"
              value={scheduleAt}
              min={localInputValue(Date.now())}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
          </label>
          <p className="field-hint">
            Loop sends it once, at that time, to the agent above. If it can’t be
            sent then, it stays in Needs you and Later → Scheduled with the
            reason, and is never retried on its own. This is not a reminder: use
            Remind me to bring something back to yourself.
          </p>
          <button
            className="primary"
            disabled={!scheduleAt || busy}
            onClick={() => {
              const at = new Date(scheduleAt).getTime();
              if (!(at > Date.now())) {
                setComposerError("Choose a time in the future.");
                setScheduleAt(null);
                return;
              }
              setScheduleAt(null);
              void send({ sendAt: at });
            }}
          >
            <AlarmClock size={17} /> Schedule for{" "}
            {scheduleAt && new Date(scheduleAt).getTime() > 0
              ? `${dayLabel(new Date(scheduleAt).getTime()).toLowerCase()} at ${timeLabel(new Date(scheduleAt).getTime())}`
              : "…"}
          </button>
        </Sheet>
      )}
    </>
  );
}
