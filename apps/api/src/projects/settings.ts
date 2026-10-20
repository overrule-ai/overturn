import { type ProjectSettings, projectSettingsSchema } from "@overturn-ai/shared";

/** Settings as stored (jsonb, possibly older shape) → current defaults filled in. */
export function parseSettings(raw: unknown): ProjectSettings {
  const parsed = projectSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : projectSettingsSchema.parse({});
}
