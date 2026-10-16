/** Provider-reported usage for the latest completed generation, including retries. */
export type BriefGenerationUsage = {
  at: number;
  model: string | null;
  outcome: "published" | "unchanged" | "failed" | "discarded";
  attempts: number;
  reported_attempts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};
