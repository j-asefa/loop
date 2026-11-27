import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  Directory as ExpoDirectory,
  File as ExpoFile,
  Paths,
} from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  ArrowUpRight,
  Eye,
  FileCode2,
  FileText,
  Film,
  Image as ImageIcon,
  MessageSquare,
  Music,
  Paperclip,
  RefreshCw,
  Share2,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LoopClient } from "../api/client";
import {
  formatFileBytes,
  isHtmlFile,
  isMarkdownFile,
  isPreviewableImageMime,
  isPreviewableTextMime,
  normalizeMime,
  parseArtifactFileMetadata,
  sanitizeDownloadFilename,
  type PublishedFileItem,
} from "../api/files";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";
import { RichContent } from "./RichContent";

const MAX_INLINE_TEXT_CHARS = 100_000;

function FileTypeIcon({
  mime,
  name,
  size = 18,
  color,
}: {
  mime: string;
  name: string;
  size?: number;
  color: string;
}) {
  const normalized = normalizeMime(mime, name);
  if (normalized.startsWith("image/")) {
    return <ImageIcon size={size} color={color} />;
  }
  if (normalized.startsWith("video/")) {
    return <Film size={size} color={color} />;
  }
  if (normalized.startsWith("audio/")) {
    return <Music size={size} color={color} />;
  }
  if (
    normalized === "application/json" ||
    normalized === "application/yaml" ||
    normalized === "application/xml" ||
    normalized === "text/html"
  ) {
    return <FileCode2 size={size} color={color} />;
  }
  return <FileText size={size} color={color} />;
}

/**
 * Displays files published by an agent during a run (`GET /api/runs/:id/files`),
 * matching the PWA's `<RunFiles>` cards with inline image thumbnails and tap-to-preview.
 */
export const PublishedFilesStrip = React.memo(function PublishedFilesStrip({
  files,
  client,
  theme,
  onOpenFile,
  showImageThumbnails = true,
}: {
  files: PublishedFileItem[];
  client?: LoopClient | null;
  theme: LoopTheme;
  onOpenFile?: (file: PublishedFileItem) => void;
  showImageThumbnails?: boolean;
}) {
  if (!files.length) return null;

  return (
    <View style={[styles.stripWrap, { borderTopColor: theme.line }]}>
      <View style={styles.stripHead}>
        <Paperclip size={13} color={theme.brassText} />
        <Text style={[styles.stripTitle, { color: theme.brassText }]}>
          {files.length === 1
            ? "Published file"
            : `${files.length} published files`}
        </Text>
      </View>

      <View style={styles.stripList}>
        {files.map((file) => {
          const isImage =
            showImageThumbnails &&
            Boolean(client) &&
            isPreviewableImageMime(file.mime, file.name);
          const sizeLabel = formatFileBytes(file.size);
          let thumbUri: string | null = null;
          if (isImage && client) {
            try {
              thumbUri = client.sameOriginFileUrl(file.path, "preview=1");
            } catch {
              thumbUri = null;
            }
          }

          return (
            <Pressable
              key={file.id}
              accessibilityLabel={`Open file ${file.name}`}
              onPress={() => {
                haptics.light();
                onOpenFile?.(file);
              }}
              style={({ pressed }) => [
                styles.fileCard,
                {
                  backgroundColor: pressed ? theme.raised : theme.soft,
                  borderColor: theme.line,
                },
              ]}
            >
              {thumbUri && client ? (
                <Image
                  source={{
                    uri: thumbUri,
                    headers: client.fileRequestHeaders(),
                  }}
                  style={[
                    styles.fileThumb,
                    { backgroundColor: theme.raised, borderColor: theme.line },
                  ]}
                  resizeMode="cover"
                />
              ) : null}
              <View style={styles.fileCardRow}>
                <View
                  style={[
                    styles.fileIconBadge,
                    { backgroundColor: theme.attention },
                  ]}
                >
                  <FileTypeIcon
                    mime={file.mime}
                    name={file.name}
                    size={17}
                    color={theme.brassText}
                  />
                </View>
                <View style={styles.fileCardMeta}>
                  <Text
                    style={[styles.fileCardName, { color: theme.text }]}
                    numberOfLines={1}
                  >
                    {file.name || file.title}
                  </Text>
                  <Text
                    style={[styles.fileCardSub, { color: theme.muted }]}
                    numberOfLines={1}
                  >
                    {[
                      file.mime && file.mime !== "application/octet-stream"
                        ? file.mime
                        : "File",
                      sizeLabel,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                <ArrowUpRight size={16} color={theme.brassText} />
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
});

export function FilePreviewModal({
  file,
  client,
  theme,
  onClose,
  onOpenConversation,
}: {
  file: PublishedFileItem;
  client: LoopClient;
  theme: LoopTheme;
  onClose: () => void;
  onOpenConversation?: (conv: {
    conversationId: string;
    title: string;
    agentName: string;
  }) => void;
}) {
  const insets = useSafeAreaInsets();
  const [resolvedName, setResolvedName] = useState(
    file.name || file.title || "Published file",
  );
  const [resolvedMime, setResolvedMime] = useState(
    normalizeMime(file.mime, file.name || file.title),
  );
  const [resolvedSize, setResolvedSize] = useState(file.size || 0);
  const [resolvedConvId, setResolvedConvId] = useState(
    file.conversationId ?? null,
  );
  const [resolvedAgentName, setResolvedAgentName] = useState(
    file.agentName ?? null,
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [localFile, setLocalFile] = useState<ExpoFile | null>(null);
  const [canQuickLook, setCanQuickLook] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    setError("");
    setActionError("");
    setLocalFile(null);
    setCanQuickLook(false);
    setTextContent(null);
    setTextTruncated(false);

    void (async () => {
      try {
        let name = file.name || file.title || "Published file";
        let mime = normalizeMime(file.mime, name);
        let size = file.size || 0;
        let convId = file.conversationId ?? null;
        let agentName = file.agentName ?? null;

        // When opened from a bare /?artifact=<id> link, fetch metadata first for the real filename & MIME
        if (
          file.artifactId &&
          (!size || mime === "application/octet-stream" || !name.includes("."))
        ) {
          try {
            const detail = await client.artifactDetail(file.artifactId);
            if (cancelled) return;
            const parsed = parseArtifactFileMetadata(
              detail.metadata,
              detail.title || name,
            );
            name = parsed.name || detail.title || name;
            mime = parsed.mime || mime;
            size = parsed.size || size;
            convId = detail.conversation_id ?? convId;
            agentName = detail.agent_name ?? agentName;
            setResolvedName(name);
            setResolvedMime(mime);
            setResolvedSize(size);
            setResolvedConvId(convId);
            setResolvedAgentName(agentName);
          } catch {
            // Continue downloading bytes directly
          }
        }

        const safeFolderKey =
          (file.id || "file").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) ||
          "file";
        const dir = new ExpoDirectory(Paths.cache, "loop-files", safeFolderKey);
        dir.create({ intermediates: true, idempotent: true });

        const safeName = sanitizeDownloadFilename(name, file.id);
        const destination = new ExpoFile(dir, safeName);
        const downloadUrl = client.sameOriginFileUrl(file.path);

        const downloaded = await ExpoFile.downloadFileAsync(
          downloadUrl,
          destination,
          {
            headers: client.fileRequestHeaders(),
            idempotent: true,
            signal: controller.signal,
          },
        );
        if (cancelled) return;

        const actualSize =
          typeof downloaded.size === "number" && downloaded.size > 0
            ? downloaded.size
            : size;
        const effectiveMime = normalizeMime(
          downloaded.type || mime,
          downloaded.name || name,
        );
        setResolvedName(name);
        setResolvedMime(effectiveMime);
        setResolvedSize(actualSize);
        setLocalFile(downloaded);

        const quickLookSupported = await downloaded
          .canPreview({ mimeType: effectiveMime })
          .catch(() => false);
        if (!cancelled) setCanQuickLook(quickLookSupported);

        if (isPreviewableTextMime(effectiveMime, name)) {
          try {
            const raw = await downloaded.text();
            if (!cancelled) {
              if (raw.length > MAX_INLINE_TEXT_CHARS) {
                setTextContent(raw.slice(0, MAX_INLINE_TEXT_CHARS));
                setTextTruncated(true);
              } else {
                setTextContent(raw);
                setTextTruncated(false);
              }
            }
          } catch {
            // Fall back to Quick Look / Share card
          }
        }
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Could not download this file. Try again.";
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, file, attempt]);

  const isImage = isPreviewableImageMime(resolvedMime, resolvedName);
  const isMarkdown = isMarkdownFile(resolvedMime, resolvedName);
  const isHtml = isHtmlFile(resolvedMime, resolvedName);
  const sizeLabel = formatFileBytes(resolvedSize);

  async function handleQuickLook() {
    if (!localFile || previewing) return;
    setActionError("");
    setPreviewing(true);
    haptics.light();
    try {
      await localFile.preview({
        title: resolvedName,
        mimeType: resolvedMime,
      });
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : "Quick Look could not open this file. Use Save or share instead.",
      );
    } finally {
      setPreviewing(false);
    }
  }

  async function handleShare() {
    if (!localFile || sharing) return;
    setActionError("");
    setSharing(true);
    haptics.medium();
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        setActionError("Sharing is not available on this device.");
        return;
      }
      await Sharing.shareAsync(localFile.uri, {
        mimeType: resolvedMime,
        dialogTitle: resolvedName,
      });
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not share this file.",
      );
    } finally {
      setSharing(false);
    }
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.modalRoot, { backgroundColor: theme.bg }]}>
        {/* Header */}
        <View
          style={[
            styles.modalHeader,
            {
              paddingTop: Math.max(insets.top + 8, 18),
              backgroundColor: theme.surface,
              borderBottomColor: theme.line,
            },
          ]}
        >
          <View
            style={[
              styles.headerIconBadge,
              { backgroundColor: theme.attention },
            ]}
          >
            <FileTypeIcon
              mime={resolvedMime}
              name={resolvedName}
              size={18}
              color={theme.brassText}
            />
          </View>
          <View style={styles.headerMeta}>
            <Text
              style={[styles.headerTitle, { color: theme.text }]}
              numberOfLines={1}
            >
              {resolvedName}
            </Text>
            <Text
              style={[styles.headerSub, { color: theme.muted }]}
              numberOfLines={1}
            >
              {[
                resolvedAgentName ? `@${resolvedAgentName}` : null,
                resolvedMime !== "application/octet-stream"
                  ? resolvedMime
                  : "File",
                sizeLabel || null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Close file preview"
            onPress={() => {
              haptics.light();
              onClose();
            }}
            style={[
              styles.closeBtn,
              { backgroundColor: theme.soft, borderColor: theme.line },
            ]}
          >
            <X size={18} color={theme.text} />
          </Pressable>
        </View>

        {/* Body */}
        <View style={styles.modalBody}>
          {loading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={theme.brass} />
              <Text style={[styles.statusText, { color: theme.muted }]}>
                Downloading file…
              </Text>
            </View>
          ) : error ? (
            <View style={styles.centered}>
              <FileTypeIcon
                mime={resolvedMime}
                name={resolvedName}
                size={42}
                color={theme.muted}
              />
              <Text style={[styles.errorText, { color: theme.orange }]}>
                {error}
              </Text>
              <Pressable
                onPress={() => {
                  haptics.light();
                  setAttempt((n) => n + 1);
                }}
                style={[
                  styles.retryBtn,
                  {
                    backgroundColor: theme.soft,
                    borderColor: theme.line,
                  },
                ]}
              >
                <RefreshCw size={15} color={theme.text} />
                <Text style={[styles.retryBtnText, { color: theme.text }]}>
                  Try again
                </Text>
              </Pressable>
            </View>
          ) : isImage && localFile ? (
            <ScrollView
              contentContainerStyle={styles.imageScroll}
              maximumZoomScale={4}
              minimumZoomScale={1}
            >
              <Image
                source={{ uri: localFile.uri }}
                style={styles.fullImage}
                resizeMode="contain"
              />
            </ScrollView>
          ) : textContent !== null ? (
            <ScrollView
              style={styles.flex}
              contentContainerStyle={styles.textScroll}
            >
              {isMarkdown ? (
                <RichContent content={textContent} theme={theme} selectable />
              ) : (
                <Text
                  selectable
                  style={[styles.monoPreview, { color: theme.text }]}
                >
                  {textContent}
                </Text>
              )}
              {textTruncated ? (
                <Text style={[styles.truncatedNote, { color: theme.muted }]}>
                  Preview shortened to 100 KB. Use Save or share to open the
                  full file.
                </Text>
              ) : null}
            </ScrollView>
          ) : (
            <View style={styles.centered}>
              <View
                style={[
                  styles.placeholderIcon,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.line,
                  },
                ]}
              >
                <FileTypeIcon
                  mime={resolvedMime}
                  name={resolvedName}
                  size={44}
                  color={theme.brassText}
                />
              </View>
              <Text style={[styles.placeholderTitle, { color: theme.text }]}>
                {resolvedName}
              </Text>
              <Text style={[styles.placeholderHint, { color: theme.muted }]}>
                {isHtml
                  ? "HTML document ready to open in Quick Look or save to Files."
                  : canQuickLook
                    ? "Ready to preview natively in Quick Look or save to Files."
                    : "Ready to save to Files or open in another app."}
              </Text>
            </View>
          )}
        </View>

        {/* Bottom Action Dock */}
        <View
          style={[
            styles.footer,
            {
              paddingBottom: Math.max(insets.bottom + 12, 20),
              backgroundColor: theme.surface,
              borderTopColor: theme.line,
            },
          ]}
        >
          {actionError ? (
            <Text style={[styles.actionError, { color: theme.orange }]}>
              {actionError}
            </Text>
          ) : null}

          <View style={styles.footerRow}>
            {resolvedConvId && onOpenConversation ? (
              <Pressable
                onPress={() => {
                  haptics.light();
                  onClose();
                  onOpenConversation({
                    conversationId: resolvedConvId,
                    title: resolvedName,
                    agentName: resolvedAgentName || "agent",
                  });
                }}
                style={[
                  styles.secondaryBtn,
                  { backgroundColor: theme.soft, borderColor: theme.line },
                ]}
              >
                <MessageSquare size={16} color={theme.text} />
                <Text style={[styles.secondaryBtnText, { color: theme.text }]}>
                  Thread
                </Text>
              </Pressable>
            ) : null}

            {localFile && canQuickLook ? (
              <Pressable
                disabled={previewing}
                onPress={() => void handleQuickLook()}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  {
                    backgroundColor: theme.soft,
                    borderColor: theme.line,
                    opacity: pressed || previewing ? 0.7 : 1,
                  },
                ]}
              >
                <Eye size={16} color={theme.text} />
                <Text style={[styles.secondaryBtnText, { color: theme.text }]}>
                  {previewing ? "Opening…" : "Quick Look"}
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              disabled={!localFile || sharing}
              onPress={() => void handleShare()}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: theme.brass,
                  opacity: !localFile || sharing ? 0.45 : pressed ? 0.85 : 1,
                },
              ]}
            >
              <Share2 size={16} color={theme.onBrass} />
              <Text style={[styles.primaryBtnText, { color: theme.onBrass }]}>
                {sharing ? "Opening…" : "Save or share"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stripWrap: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  stripHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  stripTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  stripList: {
    gap: 8,
  },
  fileCard: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  fileThumb: {
    width: "100%",
    height: 168,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fileCardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  fileIconBadge: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  fileCardMeta: {
    flex: 1,
    gap: 2,
  },
  fileCardName: {
    fontSize: 14,
    fontWeight: "600",
  },
  fileCardSub: {
    fontSize: 11.5,
  },
  modalRoot: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerIconBadge: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  headerMeta: {
    flex: 1,
    gap: 2,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  headerSub: {
    fontSize: 12,
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBody: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 12,
  },
  statusText: {
    fontSize: 14,
  },
  errorText: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  retryBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },
  imageScroll: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  fullImage: {
    width: "100%",
    height: 460,
  },
  textScroll: {
    padding: 16,
    paddingBottom: 32,
  },
  monoPreview: {
    fontFamily: "Courier",
    fontSize: 13,
    lineHeight: 20,
  },
  truncatedNote: {
    marginTop: 16,
    fontSize: 12,
    fontStyle: "italic",
  },
  placeholderIcon: {
    width: 84,
    height: 84,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderTitle: {
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
  },
  placeholderHint: {
    fontSize: 13.5,
    textAlign: "center",
    lineHeight: 20,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  actionError: {
    fontSize: 12.5,
    textAlign: "center",
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },
  primaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: "700",
  },
});
