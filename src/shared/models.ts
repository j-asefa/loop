export type ModelOption = {
  id: string;
  name: string;
  resolvedModel?: string;
  effortLevels?: { value: string; description?: string }[];
  defaultEffort?: string;
};
