import { z } from "zod";

export const PersonalFilesQuery = z.object({
  q: z.string().trim().max(200).default(""),
  before: z.coerce.number<string>().int().positive().optional(),
  agent: z.string().uuid().optional(),
  project: z.string().uuid().optional(),
  type: z.enum(["all", "image", "video", "html", "other"]).default("all"),
});
const PersonalFile = z.object({
  id: z.string(),
  title: z.string(),
  metadata: z.string(),
  created_at: z.number(),
  conversation_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  project_name: z.string().nullable(),
  cursor: z.number(),
});
const Choice = z.object({ id: z.string(), name: z.string() });
export const PersonalFilesPage = z.object({
  items: z.array(PersonalFile),
  next: z.number().nullable(),
  agents: z.array(Choice),
  projects: z.array(Choice),
});
type PersonalFile = z.infer<typeof PersonalFile>;
export type PersonalFilesPage = z.infer<typeof PersonalFilesPage>;
