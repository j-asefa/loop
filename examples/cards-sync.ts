import { createCardClient } from "../src/shared/card-client.js";
import { CardSelectionSchema } from "../src/shared/cards.js";
import { CardCollection, type CardSnapshot } from "../src/shared/card-sync.js";

export async function syncExample(
  environment: Record<string, string | undefined> = process.env,
) {
  const baseUrl = environment.CARDS_BASE_URL;
  const token = environment.CARDS_TOKEN;
  if (!baseUrl || !token)
    throw new Error("Set CARDS_BASE_URL and CARDS_TOKEN in the environment");
  const selection = CardSelectionSchema.parse({
    view: environment.CARDS_VIEW || "results",
    project: environment.CARDS_PROJECT || undefined,
    agent: environment.CARDS_AGENT || undefined,
    teams: environment.CARDS_TEAMS || undefined,
    q: environment.CARDS_QUERY?.trim() || undefined,
  });
  if (selection.view === "results" && selection.q !== undefined)
    throw new Error("CARDS_QUERY requires CARDS_VIEW=saved or CARDS_VIEW=sent");
  const source = new URL(baseUrl).origin;
  const collection = new CardCollection(
    createCardClient({ baseUrl, token }),
    selection,
  );
  return async () => {
    const entries = await collection.sync();
    const projects = new Map<
      string,
      { id: string; name: string; cards: { id: string; entry: CardSnapshot }[] }
    >();
    for (const entry of entries) {
      const id = entry.card.context.project_id;
      const key =
        id === null
          ? source + "#unfiled"
          : source + "#project=" + encodeURIComponent(id);
      if (!projects.has(key))
        projects.set(key, {
          id: key,
          name: entry.card.context.project_name || "Unfiled",
          cards: [],
        });
      projects
        .get(key)!
        .cards.push({ id: source + "#" + entry.card.id, entry });
    }
    return { source, selection, projects: [...projects.values()] };
  };
}
if (import.meta.main) {
  try {
    const read = await syncExample();
    console.log(JSON.stringify(await read(), null, 2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Cards synchronization failed",
    );
    process.exitCode = 1;
  }
}
