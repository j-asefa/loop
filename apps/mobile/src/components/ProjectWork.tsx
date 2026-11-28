import {
  beadDraftScope,
  prepareBeadComment,
  workPageIndex,
  workSelection,
  type BeadDraft,
} from "../bead-work-state";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import type {
  BeadCloseDraft,
  BeadDetail,
  BeadWorkItem,
  BeadWorkState,
  BeadWriteStatus,
} from "../../../../src/shared/bead-schemas";
import { LoopApiError, randomUuid, type LoopClient } from "../api/client";
import {
  clearDraft,
  loadDraftEntry,
  saveDraft,
  saveDraftAndFlush,
  settlePendingReplyDraft,
} from "../drafts";
import type { LoopTheme } from "../theme";
import { RichContent } from "./RichContent";
import { SelectionTextInput } from "./SelectionTextInput";
import { SpotlightTrack, spotlightGeometry } from "./SpotlightTrack";

export type WorkTarget = {
  projectId: string;
  beadId?: string;
  sourceMessageId?: string;
  title?: string;
};

export type WorkResult = {
  conversationId: string;
  messageId?: string;
  title: string;
};

const labels: Record<BeadWorkItem["status"], string> = {
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  closed: "Closed",
};

function WorkButton({
  label,
  onPress,
  theme,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  theme: LoopTheme;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.button,
        {
          borderColor: theme.line,
          backgroundColor: theme.raised,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text style={{ color: theme.text, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function checkWrite(outcome: BeadWriteStatus) {
  if (outcome.status === "unknown")
    throw new Error("Outcome unknown. Check again using the same request.");
  if (outcome.status === "refused")
    throw new Error("Work changed or is unavailable. Refresh and try again.");
}

export function ProjectWork({
  client,
  project,
  theme,
  target,
  onOpenResult,
}: {
  client: LoopClient;
  project: string;
  theme: LoopTheme;
  target?: WorkTarget;
  onOpenResult: (target: WorkResult) => void;
}) {
  const [work, setWork] = useState<BeadWorkState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<BeadWorkItem["status"]>("ready");
  const [opened, setOpened] = useState(target?.beadId || "");
  useEffect(() => {
    if (target?.beadId) setOpened(target.beadId);
  }, [target]);
  const [adding, setAdding] = useState(!!target?.sourceMessageId);
  const [sourceMessage, setSourceMessage] = useState(target?.sourceMessageId);
  const [title, setTitle] = useState(
    target?.sourceMessageId ? target.title || "" : "",
  );
  const [description, setDescription] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const createScope = work?.enabled
    ? JSON.stringify(["bead-create", project, work.storeId])
    : "";
  useEffect(() => {
    if (!createScope) return;
    let active = true;
    void loadDraftEntry(client.localDataScope, createScope)
      .then((entry) => {
        if (!active || !entry?.pendingKey) return;
        const saved = JSON.parse(entry.text);
        setTitle(saved.title);
        setDescription(saved.description);
        setSourceMessage(saved.sourceMessageId);
        setCreatePending(true);
        setAdding(true);
      })
      .catch((error: Error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [client, createScope]);
  const refresh = useCallback(async () => {
    try {
      const next = await client.projectWork(project);
      setWork(next);
      setError("");
    } catch (error) {
      setWork(undefined);
      setError(error instanceof Error ? error.message : "Work is unavailable.");
    }
  }, [client, project]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function mutate(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Work is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  const visible = work?.enabled
    ? work.items.filter((bead) => bead.status === filter)
    : [];
  const openedItem = work?.enabled
    ? work.items.find(({ id }) => id === opened)
    : undefined;
  const slides =
    openedItem && !visible.some(({ id }) => id === opened)
      ? [openedItem, ...visible]
      : visible;
  const activeStatus = work?.enabled && openedItem?.status;
  useEffect(() => {
    if (target?.beadId && activeStatus) {
      setFilter(activeStatus);
    }
  }, [target?.beadId, activeStatus]);

  return (
    <View style={styles.section}>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.text }}>
          {error}
        </Text>
      ) : null}
      {!work && !error ? <ActivityIndicator color={theme.muted} /> : null}
      {!work && error ? (
        <WorkButton
          theme={theme}
          label="Retry Work"
          onPress={() => void refresh()}
        />
      ) : null}
      {work?.enabled === false && (
        <WorkButton
          theme={theme}
          label="Enable Beads"
          disabled={busy}
          onPress={() =>
            void mutate(async () => {
              await client.enableProjectWork(project);
            })
          }
        />
      )}
      {work?.enabled && (
        <>
          <View style={styles.row}>
            {(Object.keys(labels) as (keyof typeof labels)[]).map((status) => (
              <WorkButton
                key={status}
                theme={theme}
                label={labels[status]}
                disabled={filter === status}
                onPress={() => setFilter(status)}
              />
            ))}
          </View>
          <View style={styles.row}>
            <WorkButton
              theme={theme}
              label={adding ? "Hide new bead" : "New bead"}
              onPress={() => setAdding(!adding)}
            />
            <WorkButton
              theme={theme}
              label="Refresh"
              onPress={() => void refresh()}
            />
          </View>
          {adding && (
            <View style={styles.section}>
              <TextInput
                accessibilityLabel="Bead title"
                placeholder="Title"
                placeholderTextColor={theme.muted}
                value={title}
                maxLength={256}
                editable={!createPending && !busy}
                onChangeText={setTitle}
                style={[
                  styles.input,
                  { color: theme.text, borderColor: theme.line },
                ]}
              />
              <TextInput
                accessibilityLabel="Bead description"
                placeholder="Description"
                placeholderTextColor={theme.muted}
                value={description}
                multiline
                maxLength={16000}
                editable={!createPending && !busy}
                onChangeText={setDescription}
                style={[
                  styles.input,
                  { color: theme.text, borderColor: theme.line },
                ]}
              />
              <WorkButton
                theme={theme}
                label={
                  createPending
                    ? "Check new bead"
                    : sourceMessage
                      ? "Create bead from result"
                      : "Create bead"
                }
                disabled={busy || !title.trim()}
                onPress={() =>
                  void mutate(async () => {
                    const pending = await loadDraftEntry(
                      client.localDataScope,
                      createScope,
                    );
                    const draft = pending?.pendingKey
                      ? (JSON.parse(pending.text) as {
                          title: string;
                          description: string;
                          sourceMessageId?: string;
                        })
                      : { title, description, sourceMessageId: sourceMessage };
                    const requestId = pending?.pendingKey || randomUuid();
                    await saveDraftAndFlush(
                      client.localDataScope,
                      createScope,
                      JSON.stringify(draft),
                      { key: requestId },
                    );
                    setCreatePending(true);
                    const result = await client.createProjectBead(project, {
                      ...draft,
                      storeId: work.storeId,
                      requestId,
                    });
                    if (result.status !== "unknown") {
                      clearDraft(client.localDataScope, createScope);
                      setCreatePending(false);
                    }
                    checkWrite(result);
                    setAdding(false);
                    setSourceMessage(undefined);
                    setTitle("");
                    setDescription("");
                    setFilter("ready");
                    setOpened(result.beadId);
                  })
                }
              />
              {createPending && (
                <WorkButton
                  theme={theme}
                  label="Discard new bead draft"
                  disabled={busy}
                  onPress={() => {
                    clearDraft(client.localDataScope, createScope);
                    setCreatePending(false);
                  }}
                />
              )}
            </View>
          )}
          {visible.length === 0 ? (
            <Text style={{ color: theme.muted }}>
              No {labels[filter].toLowerCase()} beads
            </Text>
          ) : null}
          {visible.map((bead) => (
            <Pressable
              key={bead.id}
              accessibilityRole="button"
              onPress={() => setOpened(bead.id)}
              style={[
                styles.listCard,
                { backgroundColor: theme.surface, borderColor: theme.line },
              ]}
            >
              <Text style={[styles.title, { color: theme.text }]}>
                {bead.title}
              </Text>
              {bead.blockedBy.length > 0 && (
                <Text style={{ color: theme.muted }}>
                  Waiting on {bead.blockedBy.join(", ")}
                </Text>
              )}
            </Pressable>
          ))}
        </>
      )}
      {opened && slides.length > 0 && (
        <BeadSpotlight
          client={client}
          project={project}
          theme={theme}
          slides={slides}
          active={opened}
          onSelect={setOpened}
          onClose={() => setOpened("")}
          onRefresh={refresh}
          onOpenResult={(link) => {
            setOpened("");
            onOpenResult(link);
          }}
        />
      )}
    </View>
  );
}

function BeadSpotlight({
  client,
  project,
  theme,
  slides,
  active,
  onSelect,
  onClose,
  onRefresh,
  onOpenResult,
}: {
  client: LoopClient;
  project: string;
  theme: LoopTheme;
  slides: BeadWorkItem[];
  active: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onOpenResult: (target: WorkResult) => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const geometry = spotlightGeometry(width);
  const scroll = useRef<Animated.ScrollView>(null);
  const index = Math.max(
    0,
    slides.findIndex(({ id }) => id === active),
  );
  const centered = useRef(index);
  const lastSlides = useRef(slides);
  useEffect(() => {
    if (centered.current === index && lastSlides.current === slides) return;
    centered.current = index;
    lastSlides.current = slides;
    scroll.current?.scrollTo({
      x: index * geometry.snapInterval,
      animated: false,
    });
  }, [slides, index, geometry.snapInterval]);
  const select = useCallback(
    (offset: number) => {
      const next = Math.max(
        0,
        Math.min(slides.length - 1, Math.round(offset / geometry.snapInterval)),
      );
      if (next === centered.current) return;
      centered.current = next;
      onSelect(slides[next].id);
    },
    [geometry.snapInterval, onSelect, slides],
  );
  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <GestureHandlerRootView style={styles.flex}>
        <View
          style={[
            styles.spotlight,
            {
              backgroundColor: theme.bg,
              paddingTop: insets.top + 12,
              paddingBottom: insets.bottom + 10,
            },
          ]}
        >
          <View style={styles.spotlightHeader}>
            <Pressable
              accessibilityLabel="Close bead Spotlight"
              onPress={onClose}
              style={styles.button}
            >
              <ArrowLeft size={20} color={theme.text} />
            </Pressable>
            <Text style={[styles.title, { color: theme.text }]}>Work</Text>
            <Text style={{ color: theme.muted }}>
              {index + 1} / {slides.length}
            </Text>
          </View>
          <SpotlightTrack
            ref={scroll}
            snapInterval={geometry.snapInterval}
            sidePadding={geometry.sidePadding}
            onLayout={() =>
              scroll.current?.scrollTo({
                x: index * geometry.snapInterval,
                animated: false,
              })
            }
            onMomentumScrollEnd={(event) =>
              select(event.nativeEvent.contentOffset.x)
            }
            onScrollEndDrag={(event) => {
              if (!event.nativeEvent.velocity?.x)
                select(event.nativeEvent.contentOffset.x);
            }}
          >
            {slides.map((bead, position) => (
              <View
                key={bead.id}
                style={[
                  styles.card,
                  {
                    width: geometry.cardWidth,
                    borderColor: theme.line,
                    backgroundColor: theme.surface,
                  },
                ]}
              >
                {bead.id === active ? (
                  <WorkDetail
                    key={bead.id}
                    client={client}
                    project={project}
                    bead={bead.id}
                    theme={theme}
                    title={bead.title}
                    onRefresh={onRefresh}
                    onOpenResult={onOpenResult}
                  />
                ) : Math.abs(position - index) === 1 ? (
                  <Pressable
                    style={styles.section}
                    accessibilityLabel={"Open " + bead.title}
                    onPress={() => onSelect(bead.id)}
                  >
                    <Text style={[styles.title, { color: theme.text }]}>
                      {bead.title}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </SpotlightTrack>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function WorkDetail({
  client,
  project,
  bead,
  title,
  theme,
  onRefresh,
  onOpenResult,
}: {
  client: LoopClient;
  project: string;
  bead: string;
  title: string;
  theme: LoopTheme;
  onRefresh: () => Promise<void>;
  onOpenResult: (target: WorkResult) => void;
}) {
  const [detail, setDetail] = useState<BeadDetail>();
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [excerpt, setExcerpt] = useState("");
  const [draft, setDraft] = useState<BeadDraft>({ text: "" });
  const [loaded, setLoaded] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [closeDraft, setCloseDraft] = useState<BeadCloseDraft>();
  const refresh = useCallback(async () => {
    const result = await client.projectBead(project, bead);
    setDetail(result);
    return result;
  }, [client, project, bead]);
  useEffect(() => {
    void refresh().catch((error: Error) => setError(error.message));
    void client
      .projectBeadAgents(project)
      .then(setAgents)
      .catch(() => {});
  }, [client, project, refresh]);
  const scope = detail
    ? beadDraftScope({
        projectId: project,
        storeId: detail.storeId,
        beadId: bead,
      })
    : "";
  const closeScope = scope && "bead-close:" + scope;
  useEffect(() => {
    if (!scope) return;
    let live = true;
    void Promise.all([
      loadDraftEntry(client.localDataScope, scope),
      loadDraftEntry(client.localDataScope, closeScope),
    ])
      .then(([entry, close]) => {
        if (!live) return;
        if (entry) {
          const saved = JSON.parse(entry.text);
          setDraft({
            text: saved.text,
            excerpt: saved.excerpt,
            requestId: entry.pendingKey,
          });
        }
        if (close?.pendingKey) {
          const saved = JSON.parse(close.text) as Partial<BeadCloseDraft>;
          if (
            typeof saved.reason === "string" &&
            (saved.generation === null || typeof saved.generation === "string")
          ) {
            setCloseDraft({
              reason: saved.reason,
              generation: saved.generation,
              requestId: close.pendingKey,
            });
            setReason(saved.reason);
          }
        }
        setLoaded(true);
      })
      .catch((error: Error) => {
        if (live) setError(error.message);
      });
    return () => {
      live = false;
    };
  }, [client, scope, closeScope]);

  function updateDraft(next: BeadDraft) {
    setDraft(next);
    saveDraft(client.localDataScope, scope, JSON.stringify(next));
  }
  async function write(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Work is unavailable.");
    } finally {
      await refresh().catch(() => {});
      await onRefresh();
      setBusy(false);
    }
  }
  const inputStyle = [
    styles.input,
    { color: theme.text, borderColor: theme.line },
  ];
  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.section}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.text }}>
          {error}
        </Text>
      ) : null}
      {!detail ? (
        <WorkButton
          theme={theme}
          label="Refresh bead"
          onPress={() =>
            void refresh().catch((error: Error) => setError(error.message))
          }
        />
      ) : (
        <>
          <Text style={{ color: theme.muted }}>{labels[detail.status]}</Text>
          {selecting ? (
            <>
              <SelectionTextInput
                value={detail.description}
                onChangeText={() => {}}
                onSelectionChange={({ nativeEvent: { selection } }) => {
                  setExcerpt(
                    workSelection(
                      detail.description,
                      selection.start,
                      selection.end,
                    ),
                  );
                }}
                style={[inputStyle, styles.selectionInput]}
              />
              {excerpt.length > 4000 ? (
                <Text style={{ color: theme.muted }}>
                  Select up to 4,000 characters.
                </Text>
              ) : null}
              <View style={styles.row}>
                <WorkButton
                  theme={theme}
                  label="Use selection"
                  disabled={!excerpt.trim() || excerpt.length > 4000}
                  onPress={() => {
                    updateDraft({ ...draft, excerpt: excerpt.trim() });
                    setSelecting(false);
                  }}
                />
                <WorkButton
                  theme={theme}
                  label="Cancel selection"
                  onPress={() => setSelecting(false)}
                />
              </View>
            </>
          ) : (
            <>
              <RichContent
                content={detail.description}
                theme={theme}
                workspaceOrigin={client.origin}
              />
              {detail.description && loaded && !draft.requestId ? (
                <WorkButton
                  theme={theme}
                  label="Comment on selection"
                  onPress={() => {
                    setExcerpt("");
                    setSelecting(true);
                  }}
                />
              ) : null}
            </>
          )}
          {detail.blockedBy.length > 0 ? (
            <Text style={{ color: theme.muted }}>
              Waiting on {detail.blockedBy.join(", ")}
            </Text>
          ) : null}
          {detail.dependencies.length > 0 ? (
            <Text style={{ color: theme.muted }}>
              Dependencies {detail.dependencies.join(", ")}
            </Text>
          ) : null}
          {detail.closeReason ? (
            <Text style={{ color: theme.text }}>{detail.closeReason}</Text>
          ) : null}
          {detail.sourceResult && (
            <WorkButton
              theme={theme}
              label={"Source result · " + detail.sourceResult.title}
              onPress={() => onOpenResult(detail.sourceResult!)}
            />
          )}
          {detail.linkedRuns.map((run) => (
            <View key={run.requestId} style={styles.section}>
              {run.conversationId && (
                <WorkButton
                  theme={theme}
                  label={run.result?.title || "Open linked thread"}
                  onPress={() =>
                    onOpenResult(
                      run.result || {
                        conversationId: run.conversationId!,
                        title,
                      },
                    )
                  }
                />
              )}
              {run.pulls.map((url) => (
                <WorkButton
                  key={url}
                  theme={theme}
                  label={url.split("/").slice(-3).join("/")}
                  onPress={() => void Linking.openURL(url)}
                />
              ))}
            </View>
          ))}
          {detail.assignment && detail.status !== "closed" && (
            <>
              <Text style={{ color: theme.text }}>
                {detail.assignment.recovery === "run"
                  ? "The linked run has an unconfirmed outcome. Open its thread for details."
                  : detail.assignment.recovery
                    ? "Checking " + detail.assignment.recovery + " recovery"
                    : "Assigned to @" +
                      (agents.find(
                        ({ id }) => id === detail.assignment!.agentId,
                      )?.name || "project agent")}
              </Text>
              <View style={styles.row}>
                {(["resume", "release", "recover"] as const)
                  .filter((action) =>
                    action === "resume"
                      ? detail.assignment!.canResume
                      : action === "release"
                        ? detail.assignment!.canRelease
                        : detail.assignment!.recovery === "claim" ||
                          detail.assignment!.recovery === "release",
                  )
                  .map((action) => (
                    <WorkButton
                      key={action}
                      theme={theme}
                      label={
                        action === "resume"
                          ? "Resume start"
                          : action === "release"
                            ? "Release"
                            : "Check recovery"
                      }
                      disabled={busy}
                      onPress={() =>
                        void write(async () => {
                          await client.changeBeadAssignment(project, bead, {
                            storeId: detail.storeId,
                            generation: detail.assignment!.generation,
                            action,
                          });
                        })
                      }
                    />
                  ))}
              </View>
            </>
          )}
          {detail.status === "ready" &&
            !detail.assignment &&
            agents.length > 0 && (
              <>
                <Text style={styles.fieldLabel}>Work on this</Text>
                <View style={styles.row}>
                  {agents.map((agent) => (
                    <WorkButton
                      key={agent.id}
                      theme={theme}
                      label={"@" + agent.name}
                      disabled={busy}
                      onPress={() =>
                        void write(async () => {
                          const key = JSON.stringify([
                            "bead-start",
                            scope,
                            agent.id,
                          ]);
                          const pending = await loadDraftEntry(
                            client.localDataScope,
                            key,
                          );
                          const requestId = pending?.pendingKey || randomUuid();
                          await saveDraftAndFlush(
                            client.localDataScope,
                            key,
                            agent.id,
                            { key: requestId },
                          );
                          const assignment = await client.startBead(
                            project,
                            bead,
                            {
                              storeId: detail.storeId,
                              agentId: agent.id,
                              requestId,
                            },
                          );
                          clearDraft(client.localDataScope, key);
                          if (assignment.state === "refused")
                            throw new Error(
                              "This bead is no longer ready to start.",
                            );
                          if (assignment.state === "released")
                            throw new Error(
                              "The previous assignment was released. Start again to make a new assignment.",
                            );
                        })
                      }
                    />
                  ))}
                </View>
              </>
            )}
          {loaded &&
            (detail.status !== "closed" || closeDraft) &&
            (reason === null ? (
              <WorkButton
                theme={theme}
                label="Close bead"
                disabled={busy}
                onPress={() => setReason("")}
              />
            ) : (
              <>
                <TextInput
                  value={reason}
                  accessibilityLabel="Close reason"
                  placeholder="Reason"
                  placeholderTextColor={theme.muted}
                  maxLength={2000}
                  style={inputStyle}
                  editable={!closeDraft}
                  onChangeText={setReason}
                />
                <WorkButton
                  theme={theme}
                  label={closeDraft ? "Check close" : "Confirm close"}
                  disabled={busy || !reason.trim()}
                  onPress={() =>
                    void write(async () => {
                      const draft = closeDraft ?? {
                        requestId: randomUuid(),
                        generation: detail.assignment?.generation ?? null,
                        reason,
                      };
                      await saveDraftAndFlush(
                        client.localDataScope,
                        closeScope,
                        JSON.stringify(draft),
                        { key: draft.requestId },
                      );
                      setCloseDraft(draft);
                      const settle = () => {
                        if (
                          settlePendingReplyDraft(
                            client.localDataScope,
                            closeScope,
                            draft.requestId,
                          ) === "settled"
                        )
                          setCloseDraft(undefined);
                      };
                      try {
                        const result = await client.closeBead(project, bead, {
                          storeId: detail.storeId,
                          ...draft,
                        });
                        if (result.status !== "unknown") settle();
                        checkWrite(result);
                      } catch (error) {
                        if (
                          error instanceof LoopApiError &&
                          [400, 404, 409, 422].includes(error.status)
                        )
                          settle();
                        throw error;
                      }
                    })
                  }
                />
              </>
            ))}
          <Text style={[styles.fieldLabel, { color: theme.text }]}>
            Comments
          </Text>
          {detail.comments.map((comment) => (
            <View
              key={comment.id}
              style={[styles.comment, { borderColor: theme.line }]}
            >
              <Text style={{ color: theme.muted }}>
                {comment.author} ·{" "}
                {new Date(comment.createdAt).toLocaleString()}
              </Text>
              <RichContent content={comment.text} theme={theme} />
            </View>
          ))}
          {loaded && (
            <>
              {draft.excerpt ? (
                <Text style={{ color: theme.muted }}>“{draft.excerpt}”</Text>
              ) : null}
              <TextInput
                value={draft.text}
                accessibilityLabel="Comment"
                placeholder="Comment"
                placeholderTextColor={theme.muted}
                maxLength={8000}
                style={inputStyle}
                multiline
                editable={!draft.requestId && !busy}
                onChangeText={(text) => updateDraft({ ...draft, text })}
              />
              {draft.requestId && (
                <WorkButton
                  theme={theme}
                  label="Discard draft"
                  disabled={busy}
                  onPress={() => {
                    clearDraft(client.localDataScope, scope);
                    setDraft({ text: "" });
                  }}
                />
              )}
              <WorkButton
                theme={theme}
                label={draft.requestId ? "Check comment" : "Post comment"}
                disabled={busy || !draft.text.trim()}
                onPress={() =>
                  void write(async () => {
                    const attempt = prepareBeadComment(
                      {
                        projectId: project,
                        storeId: detail.storeId,
                        beadId: bead,
                      },
                      draft,
                      randomUuid,
                    );
                    await saveDraftAndFlush(
                      client.localDataScope,
                      attempt.scope,
                      JSON.stringify(attempt.draft),
                      { key: attempt.draft.requestId },
                    );
                    setDraft(attempt.draft);
                    const unlock = () => {
                      const editable = {
                        ...attempt.draft,
                        requestId: undefined,
                      };
                      const outcome = settlePendingReplyDraft(
                        client.localDataScope,
                        attempt.scope,
                        attempt.draft.requestId,
                        { text: JSON.stringify(editable) },
                      );
                      if (outcome === "settled") setDraft(editable);
                    };
                    try {
                      const result = await client.commentOnBead(
                        attempt.target.projectId,
                        attempt.target.beadId,
                        { storeId: attempt.target.storeId, ...attempt.draft },
                      );
                      if (result.status === "refused") unlock();
                      checkWrite(result);
                      const settlement = settlePendingReplyDraft(
                        client.localDataScope,
                        attempt.scope,
                        attempt.draft.requestId,
                      );
                      if (settlement === "settled") setDraft({ text: "" });
                    } catch (error) {
                      if (
                        error instanceof LoopApiError &&
                        [400, 404, 409, 422].includes(error.status)
                      )
                        unlock();
                      throw error;
                    }
                  })
                }
              />
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  section: { gap: 10, padding: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  button: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 10,
    alignSelf: "flex-start",
  },
  listCard: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4 },
  title: { fontSize: 18, fontWeight: "700" },
  fieldLabel: { fontSize: 15, fontWeight: "700" },
  input: { borderWidth: 1, borderRadius: 10, padding: 10 },
  selectionInput: { minHeight: 120 },
  spotlight: { flex: 1 },
  spotlightHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
  },
  card: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 20,
    overflow: "hidden",
    marginVertical: 12,
  },
  comment: { borderTopWidth: StyleSheet.hairlineWidth, gap: 4, paddingTop: 8 },
});
