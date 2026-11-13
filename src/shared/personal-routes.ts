import { PersonalDecisionId, requestId } from "./contract-ids.js";
import { z } from "zod";
import { PersonalFilesQuery, PersonalFilesPage } from "./personal-files.js";
import {
  PersonalDecisionsQuery,
  PersonalDecisionsPageSchema,
  PersonalApprovalSchema,
} from "./personal-decisions.js";
import {
  ProfileInput,
  PublicProfile,
  PersonalPromptsQuery,
  PersonalPromptsPage,
} from "./personal-schemas.js";
import { endpoint, base } from "./route-contract.js";

export const personalRoutes = {
  personalFiles: endpoint({
    ...base,
    operation: "personalFiles",
    method: "GET",
    path: "/me/files",
    query: PersonalFilesQuery,
    response: PersonalFilesPage,
  }),
  personalDecisions: endpoint({
    ...base,
    operation: "personalDecisions",
    method: "GET",
    path: "/me/decisions",
    query: PersonalDecisionsQuery,
    response: PersonalDecisionsPageSchema,
  }),
  personalApproval: endpoint({
    ...base,
    operation: "personalApproval",
    method: "GET",
    path: "/me/approvals/:id",
    params: z.object({ id: requestId(PersonalDecisionId).min(1).max(200) }),
    response: PersonalApprovalSchema,
  }),
  personalProfile: endpoint({
    ...base,
    operation: "personalProfile",
    method: "GET",
    path: "/me/profile",
    response: PublicProfile,
  }),
  personalProfileUpdate: endpoint({
    ...base,
    operation: "personalProfileUpdate",
    method: "PUT",
    path: "/me/profile",
    body: ProfileInput,
    response: PublicProfile,
  }),
  personalPrompts: endpoint({
    ...base,
    operation: "personalPrompts",
    method: "GET",
    path: "/me/prompts",
    query: PersonalPromptsQuery,
    response: PersonalPromptsPage,
  }),
} as const;
