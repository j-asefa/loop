export const collapse = (text: string | null | undefined, max: number) =>
  (text || "").replace(/\s+/g, " ").trim().slice(0, max);
