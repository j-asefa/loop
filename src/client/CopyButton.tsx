import type { ButtonHTMLAttributes } from "react";

export function CopyButton({
  text,
  onCopied,
  onCopyError,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  text: string;
  onCopied?: () => void;
  onCopyError?: (error: unknown) => void;
}) {
  return (
    <button
      {...props}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          onCopied?.();
        } catch (error) {
          if (onCopyError) onCopyError(error);
          else throw error;
        }
      }}
    />
  );
}
