export function isHtmlFile(name: string, mime = "") {
  const type = mime.split(";")[0].trim().toLowerCase();
  return (
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    /\.html?$/i.test(name)
  );
}
