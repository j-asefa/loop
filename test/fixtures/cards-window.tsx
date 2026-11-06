import { createRoot } from "react-dom/client";
import { useState } from "react";
import { useCards } from "../../src/client/useCards";
import { SourceProvider } from "../../src/client/SourceContext";
import { workspaceCapabilities } from "../../src/shared/capabilities";
import { setViewOwner } from "../../src/client/viewCache";
function Collection({ query }: { query: string }) {
  const { items, error, loading, load } = useCards({ view: "saved", q: query });
  return (
    <>
      <div role="alert">{error}</div>
      {loading && <p role="status">Loading cards</p>}
      <button disabled={loading} onClick={() => void load(true)}>
        More cards
      </button>
      <ul>
        {items.map((item) => (
          <li key={item.card.id}>{item.card.content}</li>
        ))}
      </ul>
    </>
  );
}
function App() {
  const [owner, setOwner] = useState("owner-a"),
    [source, setSource] = useState(""),
    [query, setQuery] = useState("first");
  setViewOwner(owner);
  return (
    <>
      <button onClick={() => setOwner("owner-b")}>Switch owner</button>
      <button onClick={() => setSource("docker:fixture")}>Switch source</button>
      <button onClick={() => setSource("")}>Return to source</button>
      <button onClick={() => setQuery("second")}>Switch filter</button>
      <SourceProvider sourceId={source} capabilities={workspaceCapabilities()}>
        <Collection query={query} />
      </SourceProvider>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
