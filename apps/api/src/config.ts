import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),
  AUTH_SECRET: z.string().min(1).default("dev-secret-change-me"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Overturn <login@example.com>"),
  WEB_URL: z.string().default("http://localhost:3000"),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  /** Together AI: open-weight models for challenger replays, fine-tuning and hosting. */
  TOGETHER_API_KEY: z.string().optional(),
  TOGETHER_BASE_URL: z.string().default("https://api.together.xyz/v1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  JOBS_DISABLED: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol("APP_CONFIG");
