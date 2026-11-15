export function downloadText(
  name: string,
  text: string,
  type: string,
  revokeAfterMs = 1000,
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  if (revokeAfterMs === 0) URL.revokeObjectURL(url);
  else setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}
