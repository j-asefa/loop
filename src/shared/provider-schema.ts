import { z } from "zod";
import { apiProviders, harnesses } from "./harnesses.js";

export const ProviderSchema = z.enum([
  ...new Set([
    ...apiProviders,
    ...Object.values(harnesses).map((harness) => harness.provider),
  ]),
]);
