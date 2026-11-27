import { resolveLoopFileTarget } from "./api/files";

export interface InlineLinkLikeToken {
  kind: string;
  text?: string;
  url?: string;
  isLocalFile?: boolean;
  children?: InlineLinkLikeToken[];
}

/**
 * Returns true if any inline token (including tokens nested inside bold, italic,
 * or strikethrough spans) renders an interactive `<Text onPress>` link.
 */
export function hasInteractiveInlineLink(
  tokens: readonly InlineLinkLikeToken[],
  workspaceOrigin?: string | null,
  hasOpenFileHandler = true,
): boolean {
  for (const tok of tokens) {
    if (tok.kind === "link" && typeof tok.url === "string") {
      if (resolveLoopFileTarget(tok.url, workspaceOrigin)) {
        if (hasOpenFileHandler) return true;
        continue;
      }
      if (!tok.isLocalFile && /^https?:\/\//i.test(tok.url)) {
        return true;
      }
    }
    if (
      tok.children &&
      hasInteractiveInlineLink(
        tok.children,
        workspaceOrigin,
        hasOpenFileHandler,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Determines whether an inline `<Text>` paragraph should enable native `selectable`.
 *
 * On Android, `TextView.setTextIsSelectable(true)` installs `ArrowKeyMovementMethod`
 * and can intercept single-tap presses on nested `<Text onPress>` links. Disabling
 * inline `selectable` only on Android blocks that contain interactive links preserves
 * URL and file-link taps while keeping plain blocks selectable and full-message
 * selection available via the Select text sheet.
 *
 * On iOS, `RCTParagraphComponentView` attaches a `UILongPressGestureRecognizer`, so
 * single taps on nested links are unaffected.
 */
export function resolveInlineTextSelectable(opts: {
  selectable: boolean;
  platformOs: string;
  hasInteractiveLinks: boolean;
}): boolean {
  if (!opts.selectable) return false;
  if (opts.platformOs === "android" && opts.hasInteractiveLinks) {
    return false;
  }
  return true;
}

/**
 * Returns true when FilePreviewModal's Select text toggle actually changes the
 * underlying view:
 * - On iOS, switches both Markdown and plain-text previews to a read-only multiline
 *   `TextInput` for drag-handle partial selection.
 * - On Android/other platforms, switches rendered Markdown (`RichContent`) to a single
 *   selectable `<Text>` view; plain-text previews already render a single `<Text selectable>`,
 *   so hiding the toggle avoids a no-op button.
 */
export function shouldShowPreviewSelectToggle(opts: {
  hasTextContent: boolean;
  isMarkdown: boolean;
  platformOs: string;
}): boolean {
  if (!opts.hasTextContent) return false;
  return opts.platformOs === "ios" || opts.isMarkdown;
}

export interface CopySessionCallbacks {
  onSuccess: () => void;
  onReset: () => void;
  onError?: () => void;
  resetDelayMs?: number;
  /** Increment the session token before starting so an older in-flight copy is superseded. */
  restartSession?: boolean;
}

/**
 * Coordinates async clipboard writes with a reset timer and monotonic session token
 * so closing a sheet, switching messages, or unmounting never flashes stale "Copied"
 * feedback or leaks a reset timeout.
 */
export class CopySessionTracker {
  private session = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  invalidate(): void {
    this.session += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async copy(
    writeClipboard: () => Promise<unknown>,
    callbacks: CopySessionCallbacks,
  ): Promise<boolean> {
    if (callbacks.restartSession) {
      this.invalidate();
      callbacks.onReset();
    }
    const token = this.session;
    try {
      await writeClipboard();
    } catch {
      if (this.session === token) {
        callbacks.onError?.();
      }
      return false;
    }
    if (this.session !== token) {
      return false;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    callbacks.onSuccess();
    const delay = callbacks.resetDelayMs ?? 1600;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.session === token) {
        callbacks.onReset();
      }
    }, delay);
    return true;
  }
}
