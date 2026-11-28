import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import {
  Bell,
  Bookmark,
  Bot,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  HardDrive,
  Link2,
  LogOut,
  Monitor,
  Moon,
  Plug,
  RefreshCw,
  RotateCcw,
  Search,
  Smartphone,
  Sun,
  Vibrate,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isUncertainOutcomeError, type LoopClient } from "../api/client";
import type { SocketStatus } from "../api/socket";
import type {
  ApiAgent,
  ApiConnection,
  ApiFolder,
  ApiMcpConnection,
  ApiMcpPreferences,
  ApiMemoryStatus,
  ApiPermissionMode,
  ApiSearchPreferences,
  ApiSearchStatus,
  PairedSession,
} from "../api/types";
import type { DevicePrefs, ThemeMode } from "../device-prefs";
import { relativeTime } from "../fixtures";
import { haptics } from "../haptics";
import { LAYERS } from "../layers";
import { agentModelLabel, harnessLabel, modelCatalog } from "../models";
import {
  getNotificationPermissionStatus,
  requestNotificationPermission,
  type NotificationPermissionState,
  type NotificationPrefs,
} from "../notifications";
import { clearWorkspaceCache, inspectWorkspaceCache } from "../offline-cache";
import {
  buildWebSettingsUrl,
  countMcpTools,
  formatCacheSummary,
  isHarnessConnection,
  summarizeConnections,
  summarizeMemoryStatus,
  type OfflineCacheInfo,
  type SettingsBadgeTone,
} from "../settings-helpers";
import type { LoopTheme } from "../theme";
import { AgentAvatar } from "./RichContent";

type SettingsPage =
  | "home"
  | "connections"
  | "tools"
  | "agents"
  | "memory"
  | "notifications"
  | "search"
  | "cache";

const PERMISSION_CHOICES: ReadonlyArray<{
  value: ApiPermissionMode;
  label: string;
  description: string;
}> = [
  {
    value: "default",
    label: "Ask every time",
    description:
      "Every file write, command, and network call waits for your approval.",
  },
  {
    value: "acceptEdits",
    label: "Auto-accept edits",
    description:
      "Claude applies edits inside the project without asking. Commands and other harnesses still ask.",
  },
  {
    value: "bypassPermissions",
    label: "Never ask",
    description:
      "Agents run every tool they choose without waiting for approval.",
  },
];

const PAGE_TITLES: Record<Exclude<SettingsPage, "home">, string> = {
  connections: "Provider connections",
  tools: "Tools & integrations",
  agents: "Manage agents",
  memory: "Shared memory",
  notifications: "Notifications",
  search: "Search preferences",
  cache: "Offline cache & storage",
};

export function SettingsSheet({
  client,
  session,
  socketStatus,
  environmentName,
  agents,
  connections,
  folders,
  theme,
  devicePrefs,
  onChangeDevicePrefs,
  notificationPrefs,
  notificationPrefsLoaded,
  onChangeNotificationPrefs,
  onClose,
  onOpenPairing,
  onSignOut,
  onOpenAgent,
  onAgentUpdated,
  onRefreshWorkspace,
  onCacheCleared,
  onNotify,
}: {
  client: LoopClient | null;
  session: PairedSession | null;
  socketStatus: SocketStatus;
  environmentName: string;
  agents: ApiAgent[];
  connections: ApiConnection[];
  folders: ApiFolder[];
  theme: LoopTheme;
  devicePrefs: DevicePrefs;
  onChangeDevicePrefs: (next: DevicePrefs) => void;
  notificationPrefs: NotificationPrefs;
  notificationPrefsLoaded: boolean;
  onChangeNotificationPrefs: (next: NotificationPrefs) => void;
  onClose: () => void;
  onOpenPairing: () => void;
  onSignOut: () => void;
  onOpenAgent: (agent: ApiAgent) => void;
  onAgentUpdated: (agent: ApiAgent) => void;
  onRefreshWorkspace: () => Promise<void>;
  onCacheCleared: () => void;
  onNotify: (message: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState<SettingsPage>("home");
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError] = useState("");
  const [notifPermission, setNotifPermission] =
    useState<NotificationPermissionState>("undetermined");

  // Lazy-loaded sub-screen data
  const [mcpServers, setMcpServers] = useState<ApiMcpConnection[]>([]);
  const [mcpPrefs, setMcpPrefs] = useState<ApiMcpPreferences | null>(null);
  const [memoryData, setMemoryData] = useState<ApiMemoryStatus | null>(null);
  const [searchStatus, setSearchStatus] = useState<ApiSearchStatus | null>(
    null,
  );
  const [searchPrefs, setSearchPrefs] = useState<ApiSearchPreferences | null>(
    null,
  );
  const [cacheInfo, setCacheInfo] = useState<OfflineCacheInfo | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

  const workspaceGenRef = useRef(0);
  const subLoadGenRef = useRef(0);
  const pageRef = useRef(page);
  pageRef.current = page;

  // Reset workspace-scoped sub-screen state whenever the paired client changes.
  useEffect(() => {
    workspaceGenRef.current += 1;
    subLoadGenRef.current += 1;
    setPage("home");
    setSubLoading(false);
    setSubError("");
    setMcpServers([]);
    setMcpPrefs(null);
    setMemoryData(null);
    setSearchStatus(null);
    setSearchPrefs(null);
    setCacheInfo(null);
    setBusyIds(new Set());
  }, [client]);

  // Handle Android hardware back button cleanly.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (pageRef.current !== "home") {
        setPage("home");
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const setBusy = useCallback((key: string, active: boolean) => {
    setBusyIds((prev) => {
      if (active === prev.has(key)) return prev;
      const next = new Set(prev);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const loadSubPage = useCallback(
    async (target: SettingsPage) => {
      const loadGen = ++subLoadGenRef.current;
      const wsGen = workspaceGenRef.current;
      setSubError("");

      if (target === "notifications") {
        setSubLoading(false);
        const status = await getNotificationPermissionStatus();
        if (
          loadGen === subLoadGenRef.current &&
          wsGen === workspaceGenRef.current
        ) {
          setNotifPermission(status);
        }
        return;
      }

      if (target === "cache") {
        setSubLoading(true);
        try {
          const info = await inspectWorkspaceCache(client?.localDataScope);
          if (
            loadGen === subLoadGenRef.current &&
            wsGen === workspaceGenRef.current
          ) {
            setCacheInfo(info);
          }
        } finally {
          if (loadGen === subLoadGenRef.current) setSubLoading(false);
        }
        return;
      }

      if (
        !client ||
        target === "home" ||
        target === "connections" ||
        target === "agents"
      ) {
        setSubLoading(false);
        return;
      }

      setSubLoading(true);
      try {
        if (target === "tools") {
          const [servers, prefs] = await Promise.all([
            client.mcpList(),
            client.mcpPreferences(),
          ]);
          if (
            loadGen === subLoadGenRef.current &&
            wsGen === workspaceGenRef.current
          ) {
            setMcpServers(servers);
            setMcpPrefs(prefs);
          }
        } else if (target === "memory") {
          const status = await client.memoryStatus();
          if (
            loadGen === subLoadGenRef.current &&
            wsGen === workspaceGenRef.current
          ) {
            setMemoryData(status);
          }
        } else if (target === "search") {
          const [status, prefs] = await Promise.all([
            client.searchStatus(),
            client.searchPreferences(),
          ]);
          if (
            loadGen === subLoadGenRef.current &&
            wsGen === workspaceGenRef.current
          ) {
            setSearchStatus(status);
            setSearchPrefs(prefs);
          }
        }
      } catch (err) {
        if (
          loadGen === subLoadGenRef.current &&
          wsGen === workspaceGenRef.current
        ) {
          setSubError(
            err instanceof Error ? err.message : "Could not load settings.",
          );
        }
      } finally {
        if (loadGen === subLoadGenRef.current) setSubLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void loadSubPage(page);
  }, [page, loadSubPage]);

  // Also read notification permission once on open so the home badge is accurate.
  useEffect(() => {
    let cancelled = false;
    void getNotificationPermissionStatus().then((status) => {
      if (!cancelled) setNotifPermission(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connSummary = useMemo(
    () => summarizeConnections(connections),
    [connections],
  );
  const harnessConnections = useMemo(
    () => connections.filter((c) => isHarnessConnection(c)),
    [connections],
  );
  const apiConnections = useMemo(
    () => connections.filter((c) => !isHarnessConnection(c)),
    [connections],
  );
  const activeAgents = useMemo(
    () => agents.filter((a) => !a.retired_at),
    [agents],
  );
  const retiredAgents = useMemo(
    () => agents.filter((a) => Boolean(a.retired_at)),
    [agents],
  );
  const projects = useMemo(
    () => folders.filter((f) => f.kind === "project"),
    [folders],
  );
  const memorySummary = useMemo(
    () => summarizeMemoryStatus(memoryData),
    [memoryData],
  );
  const webSettingsUrl = useMemo(
    () => buildWebSettingsUrl(session?.origin),
    [session?.origin],
  );
  const embeddingConnection = useMemo(
    () =>
      connections.find(
        (c) =>
          c.provider === "openai" &&
          c.status === "connected" &&
          !isHarnessConnection(c),
      ) ?? null,
    [connections],
  );

  const statusColor =
    socketStatus === "live"
      ? theme.green
      : socketStatus === "connecting" || socketStatus === "reconnecting"
        ? theme.brass
        : theme.muted;

  const notifBadge = useMemo<{
    tone: SettingsBadgeTone;
    label: string;
  }>(() => {
    if (!notificationPrefs.enabled) {
      return { tone: "muted", label: "Muted" };
    }
    if (notifPermission === "granted") {
      return { tone: "ready", label: "Allowed" };
    }
    if (notifPermission === "denied") {
      return { tone: "attention", label: "Blocked" };
    }
    return { tone: "muted", label: "Off" };
  }, [notifPermission, notificationPrefs.enabled]);

  const confirmSignOut = useCallback(() => {
    haptics.warning();
    Alert.alert(
      "Sign out of this workspace?",
      "This removes the paired session and cached snapshot from this phone. Conversations stay on your companion host.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            onClose();
            onSignOut();
          },
        },
      ],
    );
  }, [onClose, onSignOut]);

  const handleRefreshConnection = useCallback(
    async (connection: ApiConnection) => {
      if (!client) return;
      const busyKey = `conn:${connection.id}`;
      if (busyIds.has(busyKey)) return;
      const wsGen = workspaceGenRef.current;
      haptics.light();
      setSubError("");
      setBusy(busyKey, true);
      try {
        await client.refreshConnection(connection.id);
        if (wsGen !== workspaceGenRef.current) return;
        await onRefreshWorkspace();
        if (wsGen !== workspaceGenRef.current) return;
        haptics.success();
        onNotify(`Refreshed ${connection.label || harnessLabel(connection)}`);
      } catch (err) {
        if (wsGen !== workspaceGenRef.current) return;
        haptics.warning();
        setSubError(
          isUncertainOutcomeError(err)
            ? "Connection refresh timed out — pull to refresh to check status."
            : err instanceof Error
              ? err.message
              : "Could not refresh connection.",
        );
      } finally {
        setBusy(busyKey, false);
      }
    },
    [busyIds, client, onNotify, onRefreshWorkspace, setBusy],
  );

  const handleUpdateMcpPrefs = useCallback(
    async (patch: {
      approvalMode?: "ask" | "allow";
      agentPermissionMode?: ApiPermissionMode;
    }) => {
      if (!client || busyIds.has("mcp:prefs")) return;
      const wsGen = workspaceGenRef.current;
      haptics.selection();
      setSubError("");
      setBusy("mcp:prefs", true);
      try {
        const updated = await client.updateMcpPreferences(patch);
        if (wsGen !== workspaceGenRef.current) return;
        setMcpPrefs({
          approvalMode: updated.approvalMode,
          agentPermissionMode: updated.agentPermissionMode,
        });
        haptics.success();
        onNotify("Tool permissions updated");
      } catch (err) {
        if (wsGen !== workspaceGenRef.current) return;
        haptics.warning();
        setSubError(
          isUncertainOutcomeError(err)
            ? "Update status uncertain — re-reading preferences…"
            : err instanceof Error
              ? err.message
              : "Could not update tool permissions.",
        );
        if (isUncertainOutcomeError(err)) {
          void loadSubPage("tools");
        }
      } finally {
        setBusy("mcp:prefs", false);
      }
    },
    [busyIds, client, loadSubPage, onNotify, setBusy],
  );

  const handleToggleMemoryPolicy = useCallback(
    async (scope: string, enabled: boolean) => {
      if (!client) return;
      const busyKey = `mem:${scope}`;
      if (busyIds.has(busyKey)) return;
      const wsGen = workspaceGenRef.current;
      haptics.selection();
      setSubError("");
      setBusy(busyKey, true);
      try {
        await client.updateMemoryPolicy(scope, enabled);
        if (wsGen !== workspaceGenRef.current) return;
        const fresh = await client.memoryStatus();
        if (wsGen !== workspaceGenRef.current) return;
        setMemoryData(fresh);
      } catch (err) {
        if (wsGen !== workspaceGenRef.current) return;
        haptics.warning();
        setSubError(
          err instanceof Error
            ? err.message
            : "Could not update shared memory.",
        );
        if (isUncertainOutcomeError(err)) {
          void loadSubPage("memory");
        }
      } finally {
        setBusy(busyKey, false);
      }
    },
    [busyIds, client, loadSubPage, setBusy],
  );

  const handleToggleAgentRetired = useCallback(
    async (agent: ApiAgent, retired: boolean) => {
      if (!client) return;
      const busyKey = `agent:${agent.id}`;
      if (busyIds.has(busyKey)) return;
      const wsGen = workspaceGenRef.current;
      haptics.medium();
      setSubError("");
      setBusy(busyKey, true);
      try {
        const updated = await client.updateAgent(agent.id, { retired });
        if (wsGen !== workspaceGenRef.current) return;
        onAgentUpdated(updated);
        haptics.success();
        onNotify(
          retired ? `Retired @${agent.name}` : `Restored @${agent.name}`,
        );
      } catch (err) {
        if (wsGen !== workspaceGenRef.current) return;
        haptics.warning();
        setSubError(
          err instanceof Error ? err.message : "Could not update agent status.",
        );
      } finally {
        setBusy(busyKey, false);
      }
    },
    [busyIds, client, onAgentUpdated, onNotify, setBusy],
  );

  const handleToggleSemanticSearch = useCallback(
    async (enabled: boolean) => {
      if (!client || busyIds.has("search:prefs")) return;
      const targetConnId = enabled
        ? searchPrefs?.embedding_connection || embeddingConnection?.id || null
        : null;
      if (enabled && !targetConnId) {
        setSubError(
          "Connect an OpenAI API key in Provider connections on your companion host to enable semantic search.",
        );
        return;
      }
      const wsGen = workspaceGenRef.current;
      haptics.selection();
      setSubError("");
      setBusy("search:prefs", true);
      try {
        await client.updateSearchPreferences({
          embeddingEnabled: enabled,
          connectionId: targetConnId,
        });
        if (wsGen !== workspaceGenRef.current) return;
        await loadSubPage("search");
        if (wsGen !== workspaceGenRef.current) return;
        haptics.success();
        onNotify(enabled ? "Semantic search enabled" : "Keyword search only");
      } catch (err) {
        if (wsGen !== workspaceGenRef.current) return;
        haptics.warning();
        setSubError(
          err instanceof Error
            ? err.message
            : "Could not update search preferences.",
        );
      } finally {
        setBusy("search:prefs", false);
      }
    },
    [
      busyIds,
      client,
      embeddingConnection?.id,
      loadSubPage,
      onNotify,
      searchPrefs?.embedding_connection,
      setBusy,
    ],
  );

  const renderPill = (
    label: string,
    tone: SettingsBadgeTone = "muted",
    dot = false,
  ) => {
    const bg =
      tone === "ready"
        ? theme.greenSoft
        : tone === "attention"
          ? theme.attention
          : theme.soft;
    const fg =
      tone === "ready"
        ? theme.green
        : tone === "attention"
          ? theme.brassText
          : theme.muted;
    const border = tone === "attention" ? theme.attentionLine : "transparent";
    return (
      <View style={[styles.pill, { backgroundColor: bg, borderColor: border }]}>
        {dot ? (
          <View
            style={[
              styles.pillDot,
              {
                backgroundColor:
                  tone === "ready"
                    ? theme.green
                    : tone === "attention"
                      ? theme.brass
                      : theme.muted,
              },
            ]}
          />
        ) : null}
        <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
      </View>
    );
  };

  const renderNavRow = ({
    icon: Icon,
    title,
    description,
    pill,
    onPress,
    trailing,
    first = false,
  }: {
    icon?: typeof Link2;
    title: string;
    description?: string;
    pill?: React.ReactNode;
    onPress?: () => void;
    trailing?: React.ReactNode;
    first?: boolean;
  }) => {
    const body = (
      <>
        {Icon ? (
          <View
            style={[
              styles.rowIcon,
              { backgroundColor: theme.soft, borderColor: theme.line },
            ]}
          >
            <Icon size={16} color={theme.brassText} />
          </View>
        ) : null}
        <View style={styles.rowBody}>
          <Text
            style={[styles.rowTitle, { color: theme.text }]}
            numberOfLines={1}
          >
            {title}
          </Text>
          {description ? (
            <Text
              style={[styles.rowDesc, { color: theme.muted }]}
              numberOfLines={2}
            >
              {description}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowRight}>
          {pill}
          {trailing}
          {onPress && !trailing ? (
            <ChevronRight size={16} color={theme.muted} />
          ) : null}
        </View>
      </>
    );

    const rowStyle = [
      styles.row,
      !first && {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.line,
      },
    ];

    if (!onPress) {
      return <View style={rowStyle}>{body}</View>;
    }
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={() => {
          haptics.light();
          onPress();
        }}
        style={({ pressed }) => [
          ...rowStyle,
          pressed && { backgroundColor: theme.soft },
        ]}
      >
        {body}
      </Pressable>
    );
  };

  const openSubPage = (target: Exclude<SettingsPage, "home">) => {
    setSubError("");
    setPage(target);
  };

  const themeOptions: ReadonlyArray<{
    id: ThemeMode;
    label: string;
    icon: typeof Sun;
  }> = [
    { id: "system", label: "System", icon: Smartphone },
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
  ];

  const isPolicyOn = (scope: string) =>
    memoryData?.policies.find((p) => p.scope === scope)?.enabled !== 0;

  return (
    <View
      style={[
        styles.overlay,
        { backgroundColor: theme.bg, zIndex: LAYERS.settings },
      ]}
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: Math.max(insets.top + 8, 18),
            borderBottomColor: theme.line,
          },
        ]}
      >
        {page === "home" ? (
          <>
            <View style={styles.headerLeft}>
              <Text style={[styles.screenTitle, { color: theme.text }]}>
                Settings
              </Text>
              <Text style={[styles.screenSub, { color: theme.muted }]}>
                Your workspace, at a glance.
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close Settings"
              onPress={() => {
                haptics.light();
                onClose();
              }}
              style={[
                styles.pillBtn,
                {
                  backgroundColor: theme.attention,
                  borderColor: theme.attentionLine,
                },
              ]}
            >
              <Text style={[styles.pillBtnText, { color: theme.brassText }]}>
                Done
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to Settings"
              onPress={() => {
                haptics.light();
                setSubError("");
                setPage("home");
              }}
              style={styles.backBtn}
              hitSlop={8}
            >
              <ChevronLeft size={19} color={theme.text} />
              <Text style={[styles.backBtnText, { color: theme.text }]}>
                Settings
              </Text>
            </Pressable>
            <Text
              style={[styles.subHeaderTitle, { color: theme.text }]}
              numberOfLines={1}
            >
              {PAGE_TITLES[page]}
            </Text>
          </>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom + 36, 44) },
        ]}
      >
        {subError ? (
          <View
            style={[
              styles.noticeCard,
              {
                backgroundColor: theme.orangeSoft,
                borderColor: theme.orange,
              },
            ]}
          >
            <Text style={[styles.noticeText, { color: theme.orange }]}>
              {subError}
            </Text>
          </View>
        ) : null}

        {subLoading ? (
          <ActivityIndicator
            color={theme.brassText}
            style={{ marginVertical: 14 }}
          />
        ) : null}

        {/* HOME */}
        {page === "home" && (
          <>
            {/* Paired Companion Card */}
            <View
              style={[
                styles.card,
                { backgroundColor: theme.surface, borderColor: theme.line },
              ]}
            >
              <View style={styles.wsCard}>
                <View style={styles.wsLeft}>
                  <View style={styles.wsStatusRow}>
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: statusColor },
                      ]}
                    />
                    <Text
                      style={[styles.wsHost, { color: theme.text }]}
                      numberOfLines={1}
                    >
                      {session
                        ? session.origin.replace(/^https?:\/\//, "")
                        : "Offline Demo Deck"}
                    </Text>
                  </View>
                  <Text
                    style={[styles.wsSub, { color: theme.muted }]}
                    numberOfLines={1}
                  >
                    {session
                      ? `${session.deviceName} · ${socketStatus}`
                      : "Pair with `loop pair` to connect your live agents"}
                  </Text>
                </View>

                <View style={styles.wsActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      session ? "Switch workspace" : "Pair workspace"
                    }
                    onPress={() => {
                      haptics.light();
                      onOpenPairing();
                    }}
                    style={[
                      styles.pillBtn,
                      {
                        backgroundColor: theme.attention,
                        borderColor: theme.attentionLine,
                      },
                    ]}
                  >
                    <Link2 size={13} color={theme.brassText} />
                    <Text
                      style={[styles.pillBtnText, { color: theme.brassText }]}
                    >
                      {session ? "Switch" : "Pair"}
                    </Text>
                  </Pressable>
                  {session ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Sign out"
                      onPress={confirmSignOut}
                      style={[
                        styles.iconCircle,
                        {
                          backgroundColor: theme.soft,
                          borderColor: theme.line,
                        },
                      ]}
                    >
                      <LogOut size={14} color={theme.orange} />
                    </Pressable>
                  ) : null}
                </View>
              </View>
            </View>

            {/* Connections */}
            <Text style={[styles.secLabel, { color: theme.muted }]}>
              CONNECTIONS
            </Text>
            <View
              style={[
                styles.card,
                { backgroundColor: theme.surface, borderColor: theme.line },
              ]}
            >
              {renderNavRow({
                first: true,
                icon: Link2,
                title: "Provider connections",
                description: "Accounts & coding harnesses",
                pill: connSummary.label
                  ? renderPill(connSummary.label, connSummary.tone, true)
                  : undefined,
                onPress: () => openSubPage("connections"),
              })}
              {renderNavRow({
                icon: Monitor,
                title: "Execution environment",
                description:
                  environmentName ||
                  (session ? "Companion host" : "Offline demo"),
                pill: session
                  ? renderPill(
                      socketStatus === "live" ? "Live" : socketStatus,
                      socketStatus === "live" ? "ready" : "muted",
                      socketStatus === "live",
                    )
                  : undefined,
              })}
              {renderNavRow({
                icon: Plug,
                title: "Tools & integrations",
                description: "Shared MCP tools & approvals",
                onPress: () => openSubPage("tools"),
              })}
            </View>

            {/* Workspace */}
            <Text style={[styles.secLabel, { color: theme.muted }]}>
              WORKSPACE
            </Text>
            <View
              style={[
                styles.card,
                { backgroundColor: theme.surface, borderColor: theme.line },
              ]}
            >
              {renderNavRow({
                first: true,
                icon: Bot,
                title: "Manage agents",
                description: "Models, instructions & retired agents",
                pill: activeAgents.length
                  ? renderPill(String(activeAgents.length), "muted")
                  : undefined,
                onPress: () => openSubPage("agents"),
              })}
              {renderNavRow({
                icon: Bookmark,
                title: "Shared memory",
                description: "What your agents can recall",
                onPress: () => openSubPage("memory"),
              })}
              {renderNavRow({
                icon: Bell,
                title: "Notifications",
                description: "Device alerts & workspace filters",
                pill: renderPill(notifBadge.label, notifBadge.tone),
                onPress: () => openSubPage("notifications"),
              })}
              {renderNavRow({
                icon: Search,
                title: "Search preferences",
                description: "Keyword & semantic search",
                onPress: () => openSubPage("search"),
              })}
            </View>

            {/* Appearance & Device */}
            <Text style={[styles.secLabel, { color: theme.muted }]}>
              APPEARANCE & DEVICE
            </Text>
            <View
              style={[
                styles.card,
                { backgroundColor: theme.surface, borderColor: theme.line },
              ]}
            >
              <View style={styles.segWrap}>
                <View style={styles.segHead}>
                  <Text style={[styles.rowTitle, { color: theme.text }]}>
                    Theme
                  </Text>
                  <Text style={[styles.segCaption, { color: theme.muted }]}>
                    {theme.isDark ? "Garden at night" : "Sage celadon"}
                  </Text>
                </View>
                <View
                  style={[
                    styles.segmented,
                    { backgroundColor: theme.soft, borderColor: theme.line },
                  ]}
                >
                  {themeOptions.map((opt) => {
                    const active = devicePrefs.themeMode === opt.id;
                    const OptIcon = opt.icon;
                    return (
                      <Pressable
                        key={opt.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        onPress={() => {
                          haptics.selection();
                          onChangeDevicePrefs({
                            ...devicePrefs,
                            themeMode: opt.id,
                          });
                        }}
                        style={[
                          styles.segBtn,
                          active && {
                            backgroundColor: theme.surface,
                            borderColor: theme.line,
                          },
                        ]}
                      >
                        <OptIcon
                          size={13}
                          color={active ? theme.text : theme.muted}
                        />
                        <Text
                          style={[
                            styles.segBtnText,
                            { color: active ? theme.text : theme.muted },
                          ]}
                        >
                          {opt.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {renderNavRow({
                icon: Vibrate,
                title: "Haptic feedback",
                description: "Tactile taps on swipes & approvals",
                trailing: (
                  <Switch
                    accessibilityLabel="Haptic feedback"
                    value={devicePrefs.hapticsEnabled}
                    onValueChange={(val) => {
                      onChangeDevicePrefs({
                        ...devicePrefs,
                        hapticsEnabled: val,
                      });
                      if (val) haptics.selection();
                    }}
                    trackColor={{ false: theme.line, true: theme.brass }}
                  />
                ),
              })}
            </View>

            {/* More */}
            <Text style={[styles.secLabel, { color: theme.muted }]}>MORE</Text>
            <View
              style={[
                styles.card,
                { backgroundColor: theme.surface, borderColor: theme.line },
              ]}
            >
              {renderNavRow({
                first: true,
                icon: HardDrive,
                title: "Offline cache & storage",
                description: session
                  ? "Cached feed snapshot on this device"
                  : "No paired workspace cached",
                onPress: () => openSubPage("cache"),
              })}
              {webSettingsUrl
                ? renderNavRow({
                    icon: ExternalLink,
                    title: "More in web app",
                    description: "Imports, webhooks & Pi packages",
                    onPress: () => {
                      void Linking.openURL(webSettingsUrl).catch(() => {
                        onNotify("Could not open companion web app");
                      });
                    },
                    trailing: <ExternalLink size={15} color={theme.muted} />,
                  })
                : null}
            </View>

            <Text style={[styles.footerNote, { color: theme.muted }]}>
              Personal workspace · Loop Mobile
            </Text>
          </>
        )}

        {/* PROVIDER CONNECTIONS */}
        {page === "connections" && (
          <>
            {connSummary.unhealthy > 0 ? (
              <View
                style={[
                  styles.attnCard,
                  {
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                  },
                ]}
              >
                <Text style={[styles.attnTitle, { color: theme.brassText }]}>
                  {connSummary.label}
                </Text>
                <Text style={[styles.attnBody, { color: theme.text }]}>
                  Refresh a connection to check its latest status, or reconnect
                  it from your companion host.
                </Text>
              </View>
            ) : null}

            {connections.length === 0 ? (
              <Text style={[styles.emptyHint, { color: theme.muted }]}>
                {client
                  ? "No provider connections configured yet. Add harnesses or API keys in Loop on your computer."
                  : "Pair with a live workspace to inspect provider connections."}
              </Text>
            ) : (
              <>
                {harnessConnections.length > 0 ? (
                  <>
                    <Text style={[styles.secLabel, { color: theme.muted }]}>
                      CODING HARNESSES
                    </Text>
                    <View
                      style={[
                        styles.card,
                        {
                          backgroundColor: theme.surface,
                          borderColor: theme.line,
                        },
                      ]}
                    >
                      {harnessConnections.map((conn, idx) => {
                        const ok = conn.status === "connected";
                        const models = modelCatalog(conn);
                        const busy = busyIds.has(`conn:${conn.id}`);
                        const title = conn.label || harnessLabel(conn);
                        const subtitle = ok
                          ? models.length > 0
                            ? `${models.length} ${models.length === 1 ? "model" : "models"} available`
                            : harnessLabel(conn)
                          : conn.status.replaceAll("_", " ");
                        return (
                          <View
                            key={conn.id}
                            style={[
                              styles.row,
                              idx > 0 && {
                                borderTopWidth: StyleSheet.hairlineWidth,
                                borderTopColor: theme.line,
                              },
                            ]}
                          >
                            <View
                              style={[
                                styles.rowIcon,
                                {
                                  backgroundColor: theme.soft,
                                  borderColor: theme.line,
                                },
                              ]}
                            >
                              <Link2 size={16} color={theme.brassText} />
                            </View>
                            <View style={styles.rowBody}>
                              <Text
                                style={[styles.rowTitle, { color: theme.text }]}
                                numberOfLines={1}
                              >
                                {title}
                              </Text>
                              <Text
                                style={[styles.rowDesc, { color: theme.muted }]}
                                numberOfLines={1}
                              >
                                {subtitle}
                              </Text>
                            </View>
                            <View style={styles.rowRight}>
                              {renderPill(
                                ok ? "Connected" : "Reconnect",
                                ok ? "ready" : "attention",
                                true,
                              )}
                              {client ? (
                                <Pressable
                                  accessibilityRole="button"
                                  accessibilityLabel={`Refresh ${title}`}
                                  disabled={busy}
                                  onPress={() =>
                                    void handleRefreshConnection(conn)
                                  }
                                  style={[
                                    styles.iconCircle,
                                    {
                                      backgroundColor: theme.soft,
                                      borderColor: theme.line,
                                      opacity: busy ? 0.55 : 1,
                                    },
                                  ]}
                                >
                                  {busy ? (
                                    <ActivityIndicator
                                      size="small"
                                      color={theme.brassText}
                                    />
                                  ) : (
                                    <RefreshCw
                                      size={13}
                                      color={theme.brassText}
                                    />
                                  )}
                                </Pressable>
                              ) : null}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  </>
                ) : null}

                {apiConnections.length > 0 ? (
                  <>
                    <Text style={[styles.secLabel, { color: theme.muted }]}>
                      LOOP RUNTIME API
                    </Text>
                    <View
                      style={[
                        styles.card,
                        {
                          backgroundColor: theme.surface,
                          borderColor: theme.line,
                        },
                      ]}
                    >
                      {apiConnections.map((conn, idx) => {
                        const ok = conn.status === "connected";
                        const busy = busyIds.has(`conn:${conn.id}`);
                        const title = conn.label || harnessLabel(conn);
                        return (
                          <View
                            key={conn.id}
                            style={[
                              styles.row,
                              idx > 0 && {
                                borderTopWidth: StyleSheet.hairlineWidth,
                                borderTopColor: theme.line,
                              },
                            ]}
                          >
                            <View
                              style={[
                                styles.rowIcon,
                                {
                                  backgroundColor: theme.soft,
                                  borderColor: theme.line,
                                },
                              ]}
                            >
                              <Plug size={16} color={theme.brassText} />
                            </View>
                            <View style={styles.rowBody}>
                              <Text
                                style={[styles.rowTitle, { color: theme.text }]}
                                numberOfLines={1}
                              >
                                {title}
                              </Text>
                              <Text
                                style={[styles.rowDesc, { color: theme.muted }]}
                                numberOfLines={1}
                              >
                                Configured on host · key stays on host
                              </Text>
                            </View>
                            <View style={styles.rowRight}>
                              {renderPill(
                                ok ? "Ready" : conn.status.replaceAll("_", " "),
                                ok ? "ready" : "attention",
                                true,
                              )}
                              {client ? (
                                <Pressable
                                  accessibilityRole="button"
                                  accessibilityLabel={`Refresh ${title}`}
                                  disabled={busy}
                                  onPress={() =>
                                    void handleRefreshConnection(conn)
                                  }
                                  style={[
                                    styles.iconCircle,
                                    {
                                      backgroundColor: theme.soft,
                                      borderColor: theme.line,
                                      opacity: busy ? 0.55 : 1,
                                    },
                                  ]}
                                >
                                  {busy ? (
                                    <ActivityIndicator
                                      size="small"
                                      color={theme.brassText}
                                    />
                                  ) : (
                                    <RefreshCw
                                      size={13}
                                      color={theme.brassText}
                                    />
                                  )}
                                </Pressable>
                              ) : null}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  </>
                ) : null}
              </>
            )}

            <Text style={[styles.subFootnote, { color: theme.muted }]}>
              Credentials stay on your companion host. This phone only reads
              safe connection status and available model lists.
            </Text>
          </>
        )}

        {/* TOOLS & INTEGRATIONS */}
        {page === "tools" &&
          (!client ? (
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              Pair with a live workspace to inspect shared MCP tools and
              approval preferences.
            </Text>
          ) : (
            <>
              {mcpPrefs ? (
                <>
                  <Text style={[styles.secLabel, { color: theme.muted }]}>
                    TOOL APPROVALS
                  </Text>
                  <View
                    style={[
                      styles.card,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    <View style={styles.segWrap}>
                      <View style={styles.segHead}>
                        <Text style={[styles.rowTitle, { color: theme.text }]}>
                          Agent tool calls
                        </Text>
                        <Text
                          style={[styles.segCaption, { color: theme.muted }]}
                        >
                          Workspace default
                        </Text>
                      </View>
                      {PERMISSION_CHOICES.map((choice) => {
                        const active =
                          mcpPrefs.agentPermissionMode === choice.value;
                        const busy = busyIds.has("mcp:prefs");
                        return (
                          <Pressable
                            key={choice.value}
                            accessibilityRole="radio"
                            accessibilityState={{
                              checked: active,
                              disabled: busy,
                            }}
                            disabled={busy}
                            onPress={() => {
                              if (!active) {
                                void handleUpdateMcpPrefs({
                                  agentPermissionMode: choice.value,
                                });
                              }
                            }}
                            style={[
                              styles.choiceTile,
                              {
                                backgroundColor: active
                                  ? theme.attention
                                  : theme.soft,
                                borderColor: active
                                  ? theme.attentionLine
                                  : theme.line,
                                opacity: busy ? 0.6 : 1,
                              },
                            ]}
                          >
                            <View style={styles.choiceHead}>
                              <Text
                                style={[
                                  styles.rowTitle,
                                  {
                                    color: active
                                      ? theme.brassText
                                      : theme.text,
                                  },
                                ]}
                              >
                                {choice.label}
                              </Text>
                              {active ? renderPill("Active", "ready") : null}
                            </View>
                            <Text
                              style={[styles.rowDesc, { color: theme.muted }]}
                            >
                              {choice.description}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    {renderNavRow({
                      icon: Plug,
                      title: "Ask before MCP tools",
                      description:
                        "Require your approval before agents call shared MCP tools",
                      trailing: (
                        <Switch
                          accessibilityLabel="Ask before MCP tools"
                          disabled={busyIds.has("mcp:prefs")}
                          value={mcpPrefs.approvalMode === "ask"}
                          onValueChange={(ask) =>
                            void handleUpdateMcpPrefs({
                              approvalMode: ask ? "ask" : "allow",
                            })
                          }
                          trackColor={{
                            false: theme.line,
                            true: theme.brass,
                          }}
                        />
                      ),
                    })}
                  </View>
                </>
              ) : null}

              <Text style={[styles.secLabel, { color: theme.muted }]}>
                CONNECTED MCP SERVERS
              </Text>
              {mcpServers.length === 0 && !subLoading ? (
                <Text style={[styles.emptyHint, { color: theme.muted }]}>
                  No shared MCP servers installed yet. Add tools from Loop on
                  your computer.
                </Text>
              ) : (
                <View
                  style={[
                    styles.card,
                    { backgroundColor: theme.surface, borderColor: theme.line },
                  ]}
                >
                  {mcpServers.map((srv, idx) => {
                    const count = countMcpTools(srv.tools);
                    const tone: SettingsBadgeTone =
                      srv.status === "connected"
                        ? "ready"
                        : srv.status === "needs_auth"
                          ? "attention"
                          : "muted";
                    const label =
                      srv.status === "connected"
                        ? "Ready"
                        : srv.status === "needs_auth"
                          ? "Needs auth"
                          : srv.status.replaceAll("_", " ");
                    return (
                      <View
                        key={srv.id}
                        style={[
                          styles.row,
                          idx > 0 && {
                            borderTopWidth: StyleSheet.hairlineWidth,
                            borderTopColor: theme.line,
                          },
                        ]}
                      >
                        <View
                          style={[
                            styles.rowIcon,
                            {
                              backgroundColor: theme.soft,
                              borderColor: theme.line,
                            },
                          ]}
                        >
                          <Plug size={16} color={theme.brassText} />
                        </View>
                        <View style={styles.rowBody}>
                          <Text
                            style={[styles.rowTitle, { color: theme.text }]}
                            numberOfLines={1}
                          >
                            {srv.name}
                          </Text>
                          <Text
                            style={[styles.rowDesc, { color: theme.muted }]}
                            numberOfLines={1}
                          >
                            {count} {count === 1 ? "tool" : "tools"} ·{" "}
                            {srv.authType}
                          </Text>
                        </View>
                        {renderPill(label, tone, tone !== "muted")}
                      </View>
                    );
                  })}
                </View>
              )}
            </>
          ))}

        {/* MANAGE AGENTS */}
        {page === "agents" && (
          <>
            <Text style={[styles.subFootnote, { color: theme.muted }]}>
              Tap any active agent to open its profile and change its model or
              effort.
            </Text>
            {activeAgents.length === 0 ? (
              <Text style={[styles.emptyHint, { color: theme.muted }]}>
                No active agents yet.
              </Text>
            ) : (
              <View
                style={[
                  styles.card,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                {activeAgents.map((agent, idx) => {
                  const projectName = folders.find(
                    (f) => f.id === agent.folder_id,
                  )?.name;
                  const modelText = agentModelLabel(agent, connections);
                  return (
                    <Pressable
                      key={agent.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Open @${agent.name}`}
                      onPress={() => {
                        haptics.light();
                        onClose();
                        onOpenAgent(agent);
                      }}
                      style={({ pressed }) => [
                        styles.row,
                        idx > 0 && {
                          borderTopWidth: StyleSheet.hairlineWidth,
                          borderTopColor: theme.line,
                        },
                        pressed && { backgroundColor: theme.soft },
                      ]}
                    >
                      <AgentAvatar name={agent.name} size={36} />
                      <View style={styles.rowBody}>
                        <Text
                          style={[styles.rowTitle, { color: theme.text }]}
                          numberOfLines={1}
                        >
                          @{agent.name}
                        </Text>
                        <Text
                          style={[styles.rowDesc, { color: theme.muted }]}
                          numberOfLines={1}
                        >
                          {[modelText, projectName].filter(Boolean).join(" · ")}
                        </Text>
                      </View>
                      <ChevronRight size={16} color={theme.muted} />
                    </Pressable>
                  );
                })}
              </View>
            )}

            {retiredAgents.length > 0 ? (
              <>
                <Text style={[styles.secLabel, { color: theme.muted }]}>
                  RETIRED AGENTS ({retiredAgents.length})
                </Text>
                <View
                  style={[
                    styles.card,
                    { backgroundColor: theme.surface, borderColor: theme.line },
                  ]}
                >
                  {retiredAgents.map((agent, idx) => {
                    const busy = busyIds.has(`agent:${agent.id}`);
                    return (
                      <View
                        key={agent.id}
                        style={[
                          styles.row,
                          idx > 0 && {
                            borderTopWidth: StyleSheet.hairlineWidth,
                            borderTopColor: theme.line,
                          },
                        ]}
                      >
                        <AgentAvatar name={agent.name} size={34} />
                        <View style={styles.rowBody}>
                          <Text
                            style={[styles.rowTitle, { color: theme.text }]}
                            numberOfLines={1}
                          >
                            @{agent.name}
                          </Text>
                          <Text
                            style={[styles.rowDesc, { color: theme.muted }]}
                            numberOfLines={1}
                          >
                            History preserved
                          </Text>
                        </View>
                        {client ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Restore @${agent.name}`}
                            disabled={busy}
                            onPress={() =>
                              void handleToggleAgentRetired(agent, false)
                            }
                            style={[
                              styles.pillBtn,
                              {
                                backgroundColor: theme.attention,
                                borderColor: theme.attentionLine,
                                opacity: busy ? 0.55 : 1,
                              },
                            ]}
                          >
                            <RotateCcw size={12} color={theme.brassText} />
                            <Text
                              style={[
                                styles.pillBtnText,
                                { color: theme.brassText },
                              ]}
                            >
                              Restore
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              </>
            ) : null}
          </>
        )}

        {/* SHARED MEMORY */}
        {page === "memory" &&
          (!client ? (
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              Pair with a live workspace to manage shared memory.
            </Text>
          ) : (
            <>
              <View
                style={[
                  styles.card,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                {renderNavRow({
                  first: true,
                  icon: Bookmark,
                  title: "Enable shared recall",
                  description:
                    "Let agents recall saved notes & prior results across threads",
                  trailing: (
                    <Switch
                      accessibilityLabel="Enable shared recall"
                      disabled={busyIds.has("mem:workspace") || !memoryData}
                      value={memorySummary.workspaceEnabled}
                      onValueChange={(next) =>
                        void handleToggleMemoryPolicy("workspace", next)
                      }
                      trackColor={{ false: theme.line, true: theme.brass }}
                    />
                  ),
                })}
              </View>

              {projects.length > 0 && memoryData ? (
                <>
                  <Text style={[styles.secLabel, { color: theme.muted }]}>
                    PROJECTS INCLUDED
                  </Text>
                  <View
                    style={[
                      styles.card,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    {projects.map((proj, idx) => {
                      const scope = `project:${proj.id}`;
                      return (
                        <View
                          key={proj.id}
                          style={[
                            styles.row,
                            idx > 0 && {
                              borderTopWidth: StyleSheet.hairlineWidth,
                              borderTopColor: theme.line,
                            },
                          ]}
                        >
                          <View style={styles.rowBody}>
                            <Text
                              style={[styles.rowTitle, { color: theme.text }]}
                              numberOfLines={1}
                            >
                              {proj.name}
                            </Text>
                          </View>
                          <Switch
                            accessibilityLabel={`Include ${proj.name} in shared memory`}
                            disabled={busyIds.has(`mem:${scope}`)}
                            value={isPolicyOn(scope)}
                            onValueChange={(next) =>
                              void handleToggleMemoryPolicy(scope, next)
                            }
                            trackColor={{
                              false: theme.line,
                              true: theme.brass,
                            }}
                          />
                        </View>
                      );
                    })}
                  </View>
                </>
              ) : null}

              {memoryData ? (
                <>
                  <Text style={[styles.secLabel, { color: theme.muted }]}>
                    SAVED SOURCES ({memorySummary.savedCount})
                  </Text>
                  {memoryData.sources.filter((s) => !s.tombstone).length ===
                  0 ? (
                    <Text style={[styles.emptyHint, { color: theme.muted }]}>
                      No memory sources saved yet.
                    </Text>
                  ) : (
                    <View
                      style={[
                        styles.card,
                        {
                          backgroundColor: theme.surface,
                          borderColor: theme.line,
                        },
                      ]}
                    >
                      {memoryData.sources
                        .filter((s) => !s.tombstone)
                        .slice(0, 20)
                        .map((src, idx) => (
                          <View
                            key={src.id}
                            style={[
                              styles.row,
                              idx > 0 && {
                                borderTopWidth: StyleSheet.hairlineWidth,
                                borderTopColor: theme.line,
                              },
                            ]}
                          >
                            <View style={styles.rowBody}>
                              <Text
                                style={[styles.rowTitle, { color: theme.text }]}
                                numberOfLines={1}
                              >
                                {src.title || "Saved source"}
                              </Text>
                              <Text
                                style={[styles.rowDesc, { color: theme.muted }]}
                                numberOfLines={1}
                              >
                                {src.kind === "note" ? "Pinned note" : src.kind}
                              </Text>
                            </View>
                            {renderPill(
                              src.eligible ? "Saved" : "Excluded",
                              src.eligible ? "ready" : "muted",
                            )}
                          </View>
                        ))}
                    </View>
                  )}
                </>
              ) : null}
            </>
          ))}

        {/* NOTIFICATIONS */}
        {page === "notifications" && (
          <>
            <View
              style={[
                styles.card,
                styles.cardPad,
                { backgroundColor: theme.surface, borderColor: theme.line },
              ]}
            >
              <View style={styles.cardTop}>
                <View style={styles.rowLeft}>
                  <Bell size={15} color={theme.brassText} />
                  <Text style={[styles.rowTitle, { color: theme.text }]}>
                    Device alerts
                  </Text>
                </View>
                {renderPill(
                  notifPermission === "granted"
                    ? "Allowed"
                    : notifPermission === "denied"
                      ? "Blocked"
                      : notifPermission === "unavailable"
                        ? "Unavailable"
                        : "Not enabled",
                  notifPermission === "granted"
                    ? "ready"
                    : notifPermission === "denied"
                      ? "attention"
                      : "muted",
                  notifPermission === "granted",
                )}
              </View>
              <Text style={[styles.cardSub, { color: theme.muted }]}>
                Receive local alerts while Loop is open or connected when agents
                need approval, finish work, or send a reply. Tapping an alert
                opens its conversation.
              </Text>
              {notifPermission !== "granted" &&
              notifPermission !== "unavailable" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    notifPermission === "denied"
                      ? "Open system notification settings"
                      : "Enable notifications"
                  }
                  onPress={() => {
                    haptics.light();
                    if (notifPermission === "denied") {
                      void Linking.openSettings().catch(() => {});
                    } else {
                      void requestNotificationPermission().then((next) =>
                        setNotifPermission(next),
                      );
                    }
                  }}
                  style={[
                    styles.pillBtn,
                    {
                      alignSelf: "flex-start",
                      marginTop: 4,
                      backgroundColor: theme.attention,
                      borderColor: theme.attentionLine,
                    },
                  ]}
                >
                  <Bell size={13} color={theme.brassText} />
                  <Text
                    style={[styles.pillBtnText, { color: theme.brassText }]}
                  >
                    {notifPermission === "denied"
                      ? "Open Settings"
                      : "Enable notifications"}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            <Text style={[styles.secLabel, { color: theme.muted }]}>
              {session
                ? `WORKSPACE ALERTS · ${session.origin.replace(/^https?:\/\//, "").toUpperCase()}`
                : "WORKSPACE ALERTS"}
            </Text>
            <View
              style={[
                styles.card,
                { backgroundColor: theme.surface, borderColor: theme.line },
              ]}
            >
              {(
                [
                  {
                    key: "enabled" as const,
                    label: "Enable alerts for this workspace",
                    sub: "Master switch for live notifications",
                  },
                  {
                    key: "needsYou" as const,
                    label: "Approvals & decisions",
                    sub: "Tool approvals and agent questions",
                  },
                  {
                    key: "completed" as const,
                    label: "Completed results",
                    sub: "New finished cards in your feed",
                  },
                  {
                    key: "replies" as const,
                    label: "Agent replies",
                    sub: "Direct replies waiting in your inbox",
                  },
                ] as const
              ).map((item, idx) => {
                const disabled =
                  !notificationPrefsLoaded ||
                  (item.key !== "enabled" && !notificationPrefs.enabled);
                return (
                  <View
                    key={item.key}
                    style={[
                      styles.row,
                      idx > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: theme.line,
                      },
                      { opacity: disabled ? 0.5 : 1 },
                    ]}
                  >
                    <View style={styles.rowBody}>
                      <Text style={[styles.rowTitle, { color: theme.text }]}>
                        {item.label}
                      </Text>
                      <Text style={[styles.rowDesc, { color: theme.muted }]}>
                        {item.sub}
                      </Text>
                    </View>
                    <Switch
                      accessibilityLabel={item.label}
                      disabled={disabled}
                      value={notificationPrefs[item.key]}
                      onValueChange={(val) => {
                        haptics.selection();
                        onChangeNotificationPrefs({
                          ...notificationPrefs,
                          [item.key]: val,
                        });
                      }}
                      trackColor={{ false: theme.line, true: theme.brass }}
                    />
                  </View>
                );
              })}
            </View>
          </>
        )}

        {/* SEARCH PREFERENCES */}
        {page === "search" &&
          (!client ? (
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              Pair with a live workspace to inspect search preferences.
            </Text>
          ) : (
            <>
              <View
                style={[
                  styles.card,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                {renderNavRow({
                  first: true,
                  icon: Search,
                  title: "Semantic search",
                  description:
                    searchStatus?.enabled || searchPrefs?.embedding_enabled
                      ? "Combines keyword and semantic matches"
                      : embeddingConnection
                        ? "Use OpenAI embeddings alongside keyword search"
                        : "Keyword search active (connect an OpenAI API key on host for semantic search)",
                  trailing: (
                    <Switch
                      accessibilityLabel="Semantic search"
                      disabled={
                        busyIds.has("search:prefs") ||
                        (!searchPrefs?.embedding_enabled &&
                          !embeddingConnection)
                      }
                      value={Boolean(
                        searchStatus?.enabled || searchPrefs?.embedding_enabled,
                      )}
                      onValueChange={(val) =>
                        void handleToggleSemanticSearch(val)
                      }
                      trackColor={{ false: theme.line, true: theme.brass }}
                    />
                  ),
                })}
                {searchStatus
                  ? renderNavRow({
                      title: "Index status",
                      description:
                        searchStatus.detail ||
                        `${searchStatus.indexed} of ${searchStatus.total} items indexed`,
                      pill: renderPill(
                        searchStatus.state,
                        searchStatus.state === "ready" ? "ready" : "muted",
                      ),
                    })
                  : null}
              </View>
            </>
          ))}

        {/* OFFLINE CACHE & STORAGE */}
        {page === "cache" && (
          <>
            <View
              style={[
                styles.card,
                { backgroundColor: theme.surface, borderColor: theme.line },
              ]}
            >
              {renderNavRow({
                first: true,
                icon: HardDrive,
                title: "Offline feed snapshot",
                description: cacheInfo?.savedAt
                  ? `Updated ${relativeTime(cacheInfo.savedAt)}`
                  : "No snapshot saved for this workspace",
                pill: renderPill(formatCacheSummary(cacheInfo), "muted"),
              })}
            </View>

            {client && cacheInfo?.exists ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear offline cache"
                onPress={() => {
                  haptics.medium();
                  clearWorkspaceCache(client.localDataScope);
                  onCacheCleared();
                  setCacheInfo({
                    exists: false,
                    bytes: 0,
                    savedAt: null,
                    cardCount: 0,
                  });
                  onNotify("Offline cache cleared");
                }}
                style={[
                  styles.pillBtn,
                  {
                    alignSelf: "flex-start",
                    paddingHorizontal: 14,
                    paddingVertical: 9,
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                  },
                ]}
              >
                <Text style={[styles.pillBtnText, { color: theme.brassText }]}>
                  Clear offline cache
                </Text>
              </Pressable>
            ) : null}

            <Text style={[styles.subFootnote, { color: theme.muted }]}>
              Clearing cache removes temporary offline feed snapshots on this
              phone. Drafts, conversations, and saved results stay safely on
              your companion host.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  headerLeft: {
    flex: 1,
    gap: 2,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  screenSub: {
    fontSize: 12.5,
    fontWeight: "500",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 4,
    paddingRight: 8,
  },
  backBtnText: {
    fontSize: 14.5,
    fontWeight: "700",
  },
  subHeaderTitle: {
    fontSize: 15.5,
    fontWeight: "700",
    flexShrink: 1,
  },
  content: {
    padding: 16,
    gap: 12,
  },
  secLabel: {
    fontSize: 11.5,
    fontWeight: "700",
    letterSpacing: 0.5,
    paddingHorizontal: 4,
    paddingTop: 2,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  cardPad: {
    padding: 14,
    gap: 8,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardSub: {
    fontSize: 13,
    lineHeight: 19,
  },
  wsCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: 13,
  },
  wsLeft: {
    flex: 1,
    gap: 3,
  },
  wsStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  wsHost: {
    fontSize: 14.5,
    fontWeight: "700",
    flexShrink: 1,
  },
  wsSub: {
    fontSize: 12,
  },
  wsActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pillBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillBtnText: {
    fontSize: 12.5,
    fontWeight: "700",
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 14.5,
    fontWeight: "600",
  },
  rowDesc: {
    fontSize: 12,
    lineHeight: 17,
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  pillText: {
    fontSize: 11,
    fontWeight: "700",
  },
  segWrap: {
    padding: 13,
    gap: 9,
  },
  segHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  segCaption: {
    fontSize: 12,
    fontWeight: "500",
  },
  segmented: {
    flexDirection: "row",
    gap: 4,
    borderRadius: 12,
    borderWidth: 1,
    padding: 3,
  },
  segBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "transparent",
  },
  segBtnText: {
    fontSize: 12.5,
    fontWeight: "700",
  },
  choiceTile: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 11,
    gap: 4,
  },
  choiceHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  attnCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    gap: 4,
  },
  attnTitle: {
    fontSize: 13.5,
    fontWeight: "700",
  },
  attnBody: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  noticeCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 11,
  },
  noticeText: {
    fontSize: 12.5,
    fontWeight: "600",
    lineHeight: 18,
  },
  emptyHint: {
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 28,
    lineHeight: 20,
  },
  subFootnote: {
    fontSize: 12.5,
    lineHeight: 18,
    paddingHorizontal: 2,
  },
  footerNote: {
    textAlign: "center",
    fontSize: 11.5,
    fontWeight: "600",
    paddingVertical: 4,
  },
});
