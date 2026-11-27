import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import * as DocumentPicker from "expo-document-picker";
import { File as ExpoFile } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  AlertCircle,
  Camera,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Mic,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LoopClient } from "../api/client";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";

export const MAX_ATTACHMENTS = 8;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type PendingAttachment = {
  localId: string;
  name: string;
  mime: string;
  size?: number;
  uri?: string;
  isImage: boolean;
  deleteAfterUpload?: boolean;
  status: "uploading" | "ready" | "error";
  uploadedId?: string;
  error?: string;
};

export type PickedFile = {
  uri: string;
  name: string;
  mime: string;
  size?: number;
  /** Delete the local temp file once upload settles (used for ephemeral voice recordings). */
  deleteAfterUpload?: boolean;
};

function deleteTempUploadFile(uri?: string): void {
  if (!uri) return;
  try {
    const file = new ExpoFile(uri);
    if (file.exists) file.delete();
  } catch {
    // Best-effort temp cleanup.
  }
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function guessNameFromUri(uri: string, fallbackExt = "bin"): string {
  const clean = uri.split("?")[0] ?? "";
  const tail = clean.split("/").pop();
  if (tail && tail.includes(".")) return tail;
  return `attachment-${Date.now()}.${fallbackExt}`;
}

export function useAttachments(
  client: LoopClient | null | undefined,
  opts?: { agentId?: string | null; folderId?: string | null },
) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const updateAttachments = useCallback(
    (updater: (prev: PendingAttachment[]) => PendingAttachment[]) => {
      const next = updater(attachmentsRef.current);
      attachmentsRef.current = next;
      setAttachments(next);
      return next;
    },
    [],
  );

  useEffect(() => {
    return () => {
      for (const att of attachmentsRef.current) {
        if (att.deleteAfterUpload && att.status !== "ready") {
          deleteTempUploadFile(att.uri);
        }
      }
    };
  }, []);

  const enqueueFiles = useCallback(
    async (files: PickedFile[]) => {
      if (!files.length) return;
      // Compute remaining slots synchronously against the ref so overlapping picks never exceed MAX_ATTACHMENTS.
      const room = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
      const batch = files.slice(0, room);
      const overflow = files.slice(room);
      for (const skipped of overflow) {
        if (skipped.deleteAfterUpload) deleteTempUploadFile(skipped.uri);
      }
      if (!batch.length) return;

      const pending: PendingAttachment[] = batch.map((file, idx) => {
        const tooBig = Boolean(file.size && file.size > MAX_UPLOAD_BYTES);
        const isImage = file.mime.startsWith("image/");
        return {
          localId: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          mime: file.mime,
          size: file.size,
          uri: file.uri,
          isImage,
          deleteAfterUpload: file.deleteAfterUpload,
          status: tooBig ? "error" : client ? "uploading" : "ready",
          uploadedId: client ? undefined : `demo-file-${Date.now()}-${idx}`,
          error: tooBig ? "Max 25 MB per file" : undefined,
        };
      });

      updateAttachments((prev) =>
        [...prev, ...pending].slice(0, MAX_ATTACHMENTS),
      );
      if (!client) {
        for (const src of batch) {
          if (src.deleteAfterUpload) deleteTempUploadFile(src.uri);
        }
        haptics.light();
        return;
      }

      await Promise.all(
        pending.map(async (item, idx) => {
          if (item.status === "error") return;
          const src = batch[idx];
          try {
            const uploaded = await client.uploadFile(
              {
                uri: src.uri,
                name: src.name,
                mimeType: src.mime,
              },
              {
                ...(opts?.agentId ? { agentId: opts.agentId } : {}),
                ...(opts?.folderId ? { folderId: opts.folderId } : {}),
              },
            );
            if (src.deleteAfterUpload) {
              deleteTempUploadFile(src.uri);
            }
            haptics.light();
            updateAttachments((prev) =>
              prev.map((a) =>
                a.localId === item.localId
                  ? {
                      ...a,
                      name: uploaded.name || a.name,
                      mime: uploaded.mime || a.mime,
                      size: uploaded.size ?? a.size,
                      status: "ready",
                      uploadedId: uploaded.id,
                    }
                  : a,
              ),
            );
          } catch (err) {
            haptics.warning();
            updateAttachments((prev) =>
              prev.map((a) =>
                a.localId === item.localId
                  ? {
                      ...a,
                      status: "error",
                      error:
                        err instanceof Error ? err.message : "Upload failed",
                    }
                  : a,
              ),
            );
          }
        }),
      );
    },
    [client, opts?.agentId, opts?.folderId, updateAttachments],
  );

  const pickFromPhotos = useCallback(async () => {
    setPickerOpen(false);
    const remaining = Math.max(
      0,
      MAX_ATTACHMENTS - attachmentsRef.current.length,
    );
    if (remaining === 0) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.length) return;
    const files: PickedFile[] = result.assets.map((asset) => {
      const mime =
        asset.mimeType || (asset.type === "video" ? "video/mp4" : "image/jpeg");
      const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
      return {
        uri: asset.uri,
        name: asset.fileName || guessNameFromUri(asset.uri, ext),
        mime,
        size: asset.fileSize ?? undefined,
      };
    });
    await enqueueFiles(files);
  }, [enqueueFiles]);

  const takePhoto = useCallback(async () => {
    setPickerOpen(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const mime = asset.mimeType || "image/jpeg";
    await enqueueFiles([
      {
        uri: asset.uri,
        name: asset.fileName || guessNameFromUri(asset.uri, "jpg"),
        mime,
        size: asset.fileSize ?? undefined,
      },
    ]);
  }, [enqueueFiles]);

  const pickDocument = useCallback(async () => {
    setPickerOpen(false);
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.length) return;
    const files: PickedFile[] = result.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name || guessNameFromUri(asset.uri),
      mime: asset.mimeType || "application/octet-stream",
      size: asset.size ?? undefined,
    }));
    await enqueueFiles(files);
  }, [enqueueFiles]);

  const removeAttachment = useCallback(
    (localId: string) => {
      haptics.light();
      const target = attachmentsRef.current.find((a) => a.localId === localId);
      if (target?.deleteAfterUpload && target.status !== "ready") {
        deleteTempUploadFile(target.uri);
      }
      updateAttachments((prev) => prev.filter((a) => a.localId !== localId));
    },
    [updateAttachments],
  );

  const retryAttachment = useCallback(
    async (localId: string) => {
      if (!client) return;
      const target = attachmentsRef.current.find((a) => a.localId === localId);
      if (!target || target.status !== "error" || !target.uri) return;
      if (target.size && target.size > MAX_UPLOAD_BYTES) return;
      updateAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId
            ? { ...a, status: "uploading", error: undefined }
            : a,
        ),
      );
      try {
        const uploaded = await client.uploadFile(
          {
            uri: target.uri,
            name: target.name,
            mimeType: target.mime,
          },
          {
            ...(opts?.agentId ? { agentId: opts.agentId } : {}),
            ...(opts?.folderId ? { folderId: opts.folderId } : {}),
          },
        );
        if (target.deleteAfterUpload) {
          deleteTempUploadFile(target.uri);
        }
        haptics.light();
        updateAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  name: uploaded.name || a.name,
                  mime: uploaded.mime || a.mime,
                  size: uploaded.size ?? a.size,
                  status: "ready",
                  uploadedId: uploaded.id,
                  error: undefined,
                }
              : a,
          ),
        );
      } catch (err) {
        haptics.warning();
        updateAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  status: "error",
                  error: err instanceof Error ? err.message : "Upload failed",
                }
              : a,
          ),
        );
      }
    },
    [client, opts?.agentId, opts?.folderId, updateAttachments],
  );

  const clearAttachments = useCallback(() => {
    for (const att of attachmentsRef.current) {
      if (att.deleteAfterUpload && att.status !== "ready") {
        deleteTempUploadFile(att.uri);
      }
    }
    updateAttachments(() => []);
  }, [updateAttachments]);

  const uploading = useMemo(
    () => attachments.some((a) => a.status === "uploading"),
    [attachments],
  );

  const hasErrors = useMemo(
    () => attachments.some((a) => a.status === "error"),
    [attachments],
  );

  const readyIds = useMemo(
    () =>
      attachments
        .filter((a) => a.status === "ready" && a.uploadedId)
        .map((a) => a.uploadedId!),
    [attachments],
  );

  const readyNames = useMemo(
    () => attachments.filter((a) => a.status === "ready").map((a) => a.name),
    [attachments],
  );

  return {
    attachments,
    pickerOpen,
    setPickerOpen,
    uploading,
    hasErrors,
    readyIds,
    readyNames,
    canAddMore: attachments.length < MAX_ATTACHMENTS,
    addFiles: enqueueFiles,
    pickFromPhotos,
    takePhoto,
    pickDocument,
    removeAttachment,
    retryAttachment,
    clearAttachments,
  };
}

export function AttachmentChipStrip({
  attachments,
  theme,
  onRemove,
  onRetry,
  locked = false,
}: {
  attachments: PendingAttachment[];
  theme: LoopTheme;
  onRemove: (localId: string) => void;
  onRetry?: (localId: string) => void;
  locked?: boolean;
}) {
  if (!attachments.length) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.stripContent}
      style={styles.strip}
    >
      {attachments.map((att) => (
        <View
          key={att.localId}
          style={[
            styles.chip,
            {
              backgroundColor: theme.surface,
              borderColor:
                att.status === "error"
                  ? theme.orange
                  : att.status === "ready"
                    ? theme.attentionLine
                    : theme.line,
            },
          ]}
        >
          {att.isImage && att.uri ? (
            <Image source={{ uri: att.uri }} style={styles.thumb} />
          ) : (
            <View
              style={[styles.fileIconWrap, { backgroundColor: theme.soft }]}
            >
              {att.status === "error" ? (
                <AlertCircle size={15} color={theme.orange} />
              ) : att.mime.startsWith("audio/") ? (
                <Mic size={15} color={theme.brassText} />
              ) : (
                <FileText size={15} color={theme.brassText} />
              )}
            </View>
          )}

          <Pressable
            disabled={locked || att.status !== "error" || !onRetry}
            onPress={() => onRetry?.(att.localId)}
            style={styles.chipMeta}
          >
            <Text
              style={[styles.chipName, { color: theme.text }]}
              numberOfLines={1}
            >
              {att.name}
            </Text>
            <Text
              style={[
                styles.chipSub,
                {
                  color: att.status === "error" ? theme.orange : theme.muted,
                },
              ]}
              numberOfLines={1}
            >
              {att.status === "uploading"
                ? "Uploading…"
                : att.status === "error"
                  ? onRetry
                    ? `${att.error || "Failed"} · Tap to retry`
                    : att.error || "Failed"
                  : formatFileSize(att.size) || "Attached"}
            </Text>
          </Pressable>

          {att.status === "uploading" ? (
            <ActivityIndicator size="small" color={theme.brassText} />
          ) : locked ? null : (
            <Pressable
              accessibilityLabel={`Remove ${att.name}`}
              hitSlop={8}
              onPress={() => onRemove(att.localId)}
              style={[styles.removeBtn, { backgroundColor: theme.soft }]}
            >
              <X size={12} color={theme.muted} />
            </Pressable>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

export function AttachmentSourceSheet({
  visible,
  theme,
  onClose,
  onPickPhotos,
  onTakePhoto,
  onPickFile,
}: {
  visible: boolean;
  theme: LoopTheme;
  onClose: () => void;
  onPickPhotos: () => void;
  onTakePhoto: () => void;
  onPickFile: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={[styles.modalBackdrop, { backgroundColor: "rgba(0,0,0,0.48)" }]}
        onPress={onClose}
      >
        <Pressable
          onPress={() => {}}
          style={[
            styles.sheet,
            {
              backgroundColor: theme.surface,
              borderColor: theme.line,
              paddingBottom: Math.max(insets.bottom + 14, 22),
            },
          ]}
        >
          <View style={styles.sheetHead}>
            <Text style={[styles.sheetTitle, { color: theme.text }]}>
              Attach to reply
            </Text>
            <Pressable
              hitSlop={8}
              onPress={() => {
                haptics.light();
                onClose();
              }}
            >
              <X size={18} color={theme.muted} />
            </Pressable>
          </View>

          <Pressable
            onPress={() => {
              haptics.selection();
              onPickPhotos();
            }}
            style={({ pressed }) => [
              styles.optionRow,
              {
                backgroundColor: pressed ? theme.raised : theme.soft,
                borderColor: theme.line,
              },
            ]}
          >
            <View
              style={[styles.optionIcon, { backgroundColor: theme.attention }]}
            >
              <ImageIcon size={18} color={theme.brassText} />
            </View>
            <View style={styles.optionText}>
              <Text style={[styles.optionTitle, { color: theme.text }]}>
                Photo library
              </Text>
              <Text style={[styles.optionSub, { color: theme.muted }]}>
                Screenshots, photos, or images (multi-select)
              </Text>
            </View>
          </Pressable>

          <Pressable
            onPress={() => {
              haptics.selection();
              onTakePhoto();
            }}
            style={({ pressed }) => [
              styles.optionRow,
              {
                backgroundColor: pressed ? theme.raised : theme.soft,
                borderColor: theme.line,
              },
            ]}
          >
            <View
              style={[styles.optionIcon, { backgroundColor: theme.attention }]}
            >
              <Camera size={18} color={theme.brassText} />
            </View>
            <View style={styles.optionText}>
              <Text style={[styles.optionTitle, { color: theme.text }]}>
                Take photo
              </Text>
              <Text style={[styles.optionSub, { color: theme.muted }]}>
                Snap a whiteboard, document, or screen
              </Text>
            </View>
          </Pressable>

          <Pressable
            onPress={() => {
              haptics.selection();
              onPickFile();
            }}
            style={({ pressed }) => [
              styles.optionRow,
              {
                backgroundColor: pressed ? theme.raised : theme.soft,
                borderColor: theme.line,
              },
            ]}
          >
            <View
              style={[styles.optionIcon, { backgroundColor: theme.attention }]}
            >
              <FolderOpen size={18} color={theme.brassText} />
            </View>
            <View style={styles.optionText}>
              <Text style={[styles.optionTitle, { color: theme.text }]}>
                Choose file
              </Text>
              <Text style={[styles.optionSub, { color: theme.muted }]}>
                PDFs, logs, code, CSVs, or iCloud Drive (up to 25 MB)
              </Text>
            </View>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexGrow: 0,
    marginBottom: 8,
  },
  stripContent: {
    gap: 8,
    paddingHorizontal: 2,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 5,
    paddingLeft: 6,
    paddingRight: 8,
    borderRadius: 14,
    borderWidth: 1,
    maxWidth: 210,
  },
  thumb: {
    width: 32,
    height: 32,
    borderRadius: 8,
  },
  fileIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  chipMeta: {
    flexShrink: 1,
    gap: 1,
  },
  chipName: {
    fontSize: 12.5,
    fontWeight: "600",
  },
  chipSub: {
    fontSize: 10.5,
    fontWeight: "500",
  },
  removeBtn: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 10,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  optionIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  optionTitle: {
    fontSize: 15,
    fontWeight: "600",
  },
  optionSub: {
    fontSize: 12.5,
  },
});
