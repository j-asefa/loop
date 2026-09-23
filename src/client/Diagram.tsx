import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
export function Diagram({ source }: { source: string }) {
  const [zoom, setZoom] = useState(1);
  const [svg, setSvg] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function render() {
      try {
        if (source.length > 30000 || /%%\{|\bclick\s|<\/?[a-z]/i.test(source))
          throw new Error("Interactive directives and HTML are disabled");
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          maxTextSize: 30000,
          flowchart: { htmlLabels: false },
          theme:
            document.documentElement.dataset.theme === "dark"
              ? "dark"
              : "neutral",
        });
        const output = await mermaid.render(
          "diagram-" + crypto.randomUUID(),
          source,
        );
        if (active)
          setSvg(
            DOMPurify.sanitize(output.svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
              FORBID_TAGS: ["foreignObject", "script"],
              FORBID_ATTR: ["style", "onload", "onclick"],
            }),
          );
      } catch {
        if (active)
          setError(
            "Diagram source is available below. This diagram could not be rendered safely.",
          );
      }
    }
    void render();
    return () => {
      active = false;
    };
  }, [source]);
  return error ? (
    <>
      <p className="note">{error}</p>
      <pre>{source}</pre>
    </>
  ) : (
    <div>
      <button onClick={() => setZoom(zoom === 1 ? 1.8 : 1)}>
        {zoom === 1 ? "Enlarge diagram" : "Reset diagram"}
      </button>
      <div className="diagram-viewport">
        <div
          className="diagram"
          style={{ width: `${zoom * 100}%` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}
