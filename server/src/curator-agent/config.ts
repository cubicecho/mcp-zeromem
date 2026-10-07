import { z } from 'zod';
import type { LlmConfig } from './llm.ts';

/**
 * What `mcp-zeromem-curate` reads from the environment, beside the server's
 * own variables. The server itself never reads these: it runs no agent.
 */
const agentConfigSchema = z.object({
  llm: z.object({
    url: z.string().url('must be the base URL of an OpenAI-compatible API, e.g. http://host:13305/api/v1'),
    model: z.string().min(1, 'is required: the model the endpoint should run'),
    apiKey: z.string().nullable(),
    timeoutMs: z.number().int().min(1000),
  }),
  /** `/mcp` of a running server; without it the store under DATA_DIR is opened in this process. */
  mcpUrl: z.string().url().nullable(),
  maxSteps: z.number().int().min(1).max(500),
});

export interface AgentConfig {
  llm: LlmConfig;
  mcpUrl: string | null;
  maxSteps: number;
}

const ENV_KEYS: Record<string, string> = {
  'llm.url': 'ZEROMEM_CURATOR_LLM_URL',
  'llm.model': 'ZEROMEM_CURATOR_LLM_MODEL',
  'llm.apiKey': 'ZEROMEM_CURATOR_LLM_API_KEY',
  'llm.timeoutMs': 'ZEROMEM_CURATOR_LLM_TIMEOUT_MS',
  mcpUrl: 'ZEROMEM_CURATOR_MCP_URL',
  maxSteps: 'ZEROMEM_CURATOR_MAX_STEPS',
};

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const trimmed = env[key]?.trim();
  return trimmed ? trimmed : undefined;
}

/** Throws with every missing or invalid variable listed at once, like the server's own config. */
export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = agentConfigSchema.safeParse({
    llm: {
      url: envValue(env, 'ZEROMEM_CURATOR_LLM_URL') ?? '',
      model: envValue(env, 'ZEROMEM_CURATOR_LLM_MODEL') ?? '',
      apiKey: envValue(env, 'ZEROMEM_CURATOR_LLM_API_KEY') ?? null,
      // Ten minutes: a local model reads the playbook and a page of candidates at tens of tokens a second.
      timeoutMs: Number(envValue(env, 'ZEROMEM_CURATOR_LLM_TIMEOUT_MS') ?? 600_000),
    },
    mcpUrl: envValue(env, 'ZEROMEM_CURATOR_MCP_URL') ?? null,
    maxSteps: Number(envValue(env, 'ZEROMEM_CURATOR_MAX_STEPS') ?? 40),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${ENV_KEYS[i.path.join('.')] ?? i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid curator configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
