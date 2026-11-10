import type { Item } from "../shared/protocol.js";

// Bound serialized UTF-8 bytes, including IDs/titles/metadata, across a turn.
export const NATIVE_OUTPUT_BYTES = 4 * 1024 * 1024;
export class NativeOutput {
  private items = new Map<string, Item>();
  private sizes = new Map<string, number>();
  readonly dirty = new Set<string>();
  bytes = 0;
  get(id: string) {
    return this.items.get(id);
  }
  values() {
    return this.items.values();
  }
  set(id: string, item: Item): boolean {
    const encoded = JSON.stringify(item);
    if (JSON.stringify(this.items.get(id)) === encoded) return true;
    const size = Buffer.byteLength(encoded);
    const bytes = this.bytes - (this.sizes.get(id) || 0) + size;
    if (
      bytes > NATIVE_OUTPUT_BYTES ||
      (!this.items.has(id) && this.items.size >= 2000)
    )
      return false;
    this.items.set(id, item);
    this.sizes.set(id, size);
    this.bytes = bytes;
    this.dirty.add(id);
    return true;
  }
  // Replay is display-only: retain the newest window without ending the session.
  replay(item: Item): boolean {
    if (Buffer.byteLength(JSON.stringify(item)) > NATIVE_OUTPUT_BYTES)
      return false;
    while (!this.set(item.id, item)) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) return false;
      this.bytes -= this.sizes.get(oldest)!;
      this.items.delete(oldest);
      this.sizes.delete(oldest);
      this.dirty.delete(oldest);
    }
    return true;
  }
  clear() {
    this.items.clear();
    this.sizes.clear();
    this.dirty.clear();
    this.bytes = 0;
  }
}
