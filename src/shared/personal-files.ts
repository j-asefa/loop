export type PersonalFile = {
  id: string;
  title: string;
  metadata: string;
  created_at: number;
  conversation_id: string | null;
  agent_name: string | null;
  project_name: string | null;
  cursor: number;
};
export type PersonalFilesPage = {
  items: PersonalFile[];
  next: number | null;
  agents: { id: string; name: string }[];
  projects: { id: string; name: string }[];
};
