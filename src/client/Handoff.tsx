import { useMemo, useState } from "react";
import { Copy, Share2 } from "lucide-react";
import QRCode from "qrcode-terminal/vendor/QRCode/index.js";
import { Sheet } from "./components";

/** Square SVG QR code. Medium error correction keeps phone scans reliable. */
export function QrCode({ value, size = 216 }: { value: string; size?: number }) {
  const path = useMemo(() => {
    const code = new QRCode(-1, 0);
    code.addData(value);
    code.make();
    const count = code.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row++)
      for (let col = 0; col < count; col++)
        if (code.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
    return { d, count: count + 8 };
  }, [value]);
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label="QR code for this link"
      width={size}
      height={size}
      viewBox={`0 0 ${path.count} ${path.count}`}
      shapeRendering="crispEdges"
    >
      <rect width={path.count} height={path.count} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

/**
 * Move between phone and computer: scan the code with the other device's
 * camera, or share/copy the link. Links only open for already paired devices
 * or signed-in sessions; they carry no credentials.
 */
export function HandoffSheet({
  path,
  title,
  onClose,
}: {
  path: string;
  title: string;
  onClose: () => void;
}) {
  const url = new URL(path, location.origin).toString();
  const [notice, setNotice] = useState("");
  return (
    <Sheet title="Open on another device" onClose={onClose} className="handoff-sheet">
      <p className="note">
        Scan with your other device’s camera to continue “{title}” there. It
        opens only on devices already paired with or signed in to this
        workspace.
      </p>
      <div className="handoff-code">
        <QrCode value={url} />
      </div>
      <div className="handoff-actions">
        {"share" in navigator && (
          <button
            type="button"
            className="secondary"
            onClick={() => void navigator.share({ title, url }).catch(() => {})}
          >
            <Share2 size={17} /> Share
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setNotice("Link copied.");
            } catch {
              setNotice(url);
            }
          }}
        >
          <Copy size={17} /> Copy link
        </button>
      </div>
      {notice && (
        <p role="status" className="field-hint handoff-notice">
          {notice}
        </p>
      )}
    </Sheet>
  );
}

/** Share a deep link with the system share sheet, falling back to the clipboard. */
export async function shareLink(path: string, title: string) {
  const url = new URL(path, location.origin).toString();
  if ("share" in navigator) {
    try {
      await navigator.share({ title, url });
      return "";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "Link copied.";
  } catch {
    return "Could not copy the link.";
  }
}
