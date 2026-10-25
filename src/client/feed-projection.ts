import {
  reduceFeedPage,
  type FeedIdentity,
  type FeedProjectionPage,
} from "../shared/feed-projection";
import { viewGeneration } from "./viewCache";

/** Keys contain owner, source, selection AND pagination boundary. No newest
 * page response can install a watermark for already retained older pages. */
export class FeedProjectionReader<
  T extends FeedIdentity,
  P extends FeedProjectionPage<T>,
> {
  private pages = new Map<string, { ticket: number; page?: P }>();
  private generation = viewGeneration();
  reset(source?: string) {
    if (source === undefined) this.pages.clear();
    else
      for (const key of this.pages.keys())
        if (JSON.parse(key)[0] === source) this.pages.delete(key);
  }
  async read(
    source: string,
    path: string,
    fetch: (known?: string) => Promise<P>,
  ): Promise<P> {
    if (this.generation !== viewGeneration()) {
      this.reset();
      this.generation = viewGeneration();
    }
    const generation = this.generation,
      key = JSON.stringify([source, path]);
    let state = this.pages.get(key);
    if (!state) {
      state = { ticket: 0 };
      this.pages.set(key, state);
    }
    const ticket = ++state.ticket,
      prior = state.page;
    let known: string | undefined;
    if (prior?.projectionRows && prior.projection) {
      const candidate = JSON.stringify({
        epoch: prior.projection.epoch,
        selection: prior.projectionRows.selection,
        entities: prior.projectionRows.entities,
      });
      if (encodeURIComponent(candidate).length < 7500) known = candidate;
    }
    const incoming = await fetch(known);
    if (
      generation !== viewGeneration() ||
      this.pages.get(key) !== state ||
      ticket !== state.ticket
    )
      throw new DOMException("Obsolete Feed page", "AbortError");
    const page = reduceFeedPage<T, P>(prior, incoming);
    state.page = page;
    // Keep the active entry and a bounded set of retained pagination contexts.
    this.pages.delete(key);
    this.pages.set(key, state);
    if (this.pages.size > 80)
      this.pages.delete(this.pages.keys().next().value!);
    return page;
  }
}
