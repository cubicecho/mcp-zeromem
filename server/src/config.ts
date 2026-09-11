import path from 'node:path';
import { embedderChoiceSchema, remoteEmbedderSpecSchema } from '@mcp-zeromem/shared';
import { z } from 'zod';
import { authDisabledByEnv } from './auth.ts';

/**
 * All configuration is environment-driven. The only state is the store under
 * `DATA_DIR`, which is also the engine's `ZEROMEM_HOME` — the two are the same
 * directory by construction, so a hook process on the host and this server
 * are guaranteed to be looking at one SQLite file.
 */
const configSchema = z.object({
  /** Where the store lives; also exported to the engine as its home. */
  dataDir: z.string().min(1),
  port: z.number().int().positive(),
  /** Bearer token guarding /mcp and the mutating REST routes; null when auth is off. */
  authToken: z.string().min(1).nullable(),
  /** Hide the write tools from the MCP listing and refuse the REST writes. */
  readOnly: z.boolean(),
  /** Which embedder opens the store; `auto` falls back to hashing, loudly, when ONNX cannot load. */
  embedder: embedderChoiceSchema,
  /**
   * A store remembers which embedder built it, and opening it with another
   * one is refused: it would drop every vector and re-embed the corpus. This
   * says that is intended.
   */
  allowEmbedderSwitch: z.boolean(),
  /**
   * The OpenAI-compatible endpoint `embedder: openai` refers to. It seeds a
   * fresh store or, under `allowEmbedderSwitch`, replaces the store's
   * embedder; an existing store is otherwise followed and this is ignored.
   */
  remoteEmbedder: remoteEmbedderSpecSchema.omit({ kind: true, api_key: true, dim: true, max_chars: true }).nullable(),
  /**
   * Bearer token for a remote endpoint. Overrides the key saved in the store
   * from the UI, and is never written to the store or returned by the API.
   */
  embeddingApiKey: z.string().min(1).nullable(),
  /**
   * The session the connected client is having, when the transport knows it
   * (a stdio server spawned per conversation): recall leaves it out by
   * default so memory does not echo the conversation in progress.
   */
  sessionId: z.string().min(1).nullable(),
});

export type Config = z.infer<typeof configSchema>;

/** Every setting an embedder endpoint takes from the environment. */
const REMOTE_ENV = {
  url: 'ZEROMEM_EMBEDDING_URL',
  model: 'ZEROMEM_EMBEDDING_MODEL',
  query_prefix: 'ZEROMEM_EMBEDDING_QUERY_PREFIX',
  document_prefix: 'ZEROMEM_EMBEDDING_DOCUMENT_PREFIX',
  timeout_ms: 'ZEROMEM_EMBEDDING_TIMEOUT_MS',
} as const;

/** Read a value, treating an empty/whitespace-only env var as unset. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * Parse a boolean env var, falling back to `fallback` when unset. An
 * unrecognized value returns `undefined` so schema validation rejects it — a
 * typo like `ZEROMEM_READ_ONLY=ture` must not silently mean "off".
 */
function envBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean | undefined {
  const raw = envValue(env, key)?.toLowerCase();
  if (raw === undefined) {
    return fallback;
  }
  if (TRUTHY.has(raw)) {
    return true;
  }
  if (FALSY.has(raw)) {
    return false;
  }
  return undefined;
}

export interface LoadOptions {
  /**
   * The stdio transport has no port to guard, so the auth requirement does
   * not apply to it: the client is whoever spawned the process.
   */
  transport?: 'http' | 'stdio';
}

/**
 * Build the config from the environment. Throws with every missing/invalid
 * variable listed at once — a half-configured server can only fail later at
 * the first tool call, where the error is far harder to read.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadOptions = {}): Config {
  const embedder = envValue(env, 'ZEROMEM_EMBEDDER') ?? 'auto';
  const parsed = configSchema.safeParse({
    dataDir: path.resolve(envValue(env, 'DATA_DIR') ?? './data'),
    port: Number(envValue(env, 'PORT') ?? 3000),
    authToken: envValue(env, 'MCP_ZEROMEM_TOKEN') ?? null,
    readOnly: envBoolean(env, 'ZEROMEM_READ_ONLY', false),
    embedder,
    allowEmbedderSwitch: envBoolean(env, 'ZEROMEM_ALLOW_EMBEDDER_SWITCH', false),
    remoteEmbedder: remoteEmbedderFromEnv(env),
    embeddingApiKey: envValue(env, 'ZEROMEM_EMBEDDING_API_KEY') ?? null,
    sessionId: envValue(env, 'ZEROMEM_SESSION_ID') ?? null,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${envKeyFor(i.path.map(String))}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  if (parsed.data.embedder === 'openai' && parsed.data.remoteEmbedder === null) {
    throw new Error(
      'Invalid configuration:\n' +
        `  ZEROMEM_EMBEDDER=openai needs ${REMOTE_ENV.url} and ${REMOTE_ENV.model} to say which endpoint and model.`,
    );
  }
  assertHomeMatches(parsed.data, env);
  if ((options.transport ?? 'http') === 'http') {
    assertAuthConfigured(parsed.data, env);
  }
  return parsed.data;
}

/**
 * `ZEROMEM_HOME`, when set, must be the data dir. The engine and the `zm`
 * hook binary both read `ZEROMEM_HOME`; if it pointed somewhere else the
 * server would serve one store while the hooks fed another, and every recall
 * would be quietly incomplete.
 */
function assertHomeMatches(config: Config, env: NodeJS.ProcessEnv): void {
  const home = envValue(env, 'ZEROMEM_HOME');
  if (home === undefined || path.resolve(home) === config.dataDir) {
    return;
  }
  throw new Error(
    'Invalid configuration:\n' +
      `  ZEROMEM_HOME (${path.resolve(home)}) differs from DATA_DIR (${config.dataDir}). ` +
      'They must be the same directory, or unset ZEROMEM_HOME and let the server derive it.',
  );
}

/**
 * Refuse to start unauthenticated unless that was asked for explicitly.
 *
 * An open `/mcp` here is every conversation this store has ever seen, readable
 * and deletable by anyone who can reach the port. Leaving the token unset is
 * indistinguishable from misspelling it, so it has to be stated, via
 * `SECURE_LOCAL_NET=true`.
 */
function assertAuthConfigured(config: Config, env: NodeJS.ProcessEnv): void {
  if (config.authToken || authDisabledByEnv(env)) {
    return;
  }
  throw new Error(
    'Invalid configuration:\n' +
      '  MCP_ZEROMEM_TOKEN: not set, so /mcp would expose the whole memory store to anyone who can reach this port.\n' +
      '  Set MCP_ZEROMEM_TOKEN to a secret of your choosing, or set SECURE_LOCAL_NET=true to confirm ' +
      'you intend an unauthenticated server on a trusted network.',
  );
}

/**
 * The endpoint from the environment, or null when neither the URL nor the
 * model is set. Setting only one of them is a mistake and is reported as such.
 */
function remoteEmbedderFromEnv(env: NodeJS.ProcessEnv): unknown {
  const url = envValue(env, REMOTE_ENV.url);
  const model = envValue(env, REMOTE_ENV.model);
  if (url === undefined && model === undefined) {
    return null;
  }
  const timeout = envValue(env, REMOTE_ENV.timeout_ms);
  return {
    url,
    model,
    query_prefix: env[REMOTE_ENV.query_prefix] ?? '',
    document_prefix: env[REMOTE_ENV.document_prefix] ?? '',
    timeout_ms: timeout === undefined ? undefined : Number(timeout),
  };
}

/** The env var behind a validation issue's path, so the message names what the operator edits. */
function envKeyFor(path: string[]): string {
  const [field, sub] = path;
  if (field === 'remoteEmbedder' && sub !== undefined && sub in REMOTE_ENV) {
    return REMOTE_ENV[sub as keyof typeof REMOTE_ENV];
  }
  return ENV_KEYS[field ?? ''] ?? path.join('.');
}

/** Config field → the env var that sets it, so validation errors name what the operator actually edits. */
const ENV_KEYS: Record<string, string> = {
  dataDir: 'DATA_DIR',
  port: 'PORT',
  authToken: 'MCP_ZEROMEM_TOKEN',
  readOnly: 'ZEROMEM_READ_ONLY',
  embedder: 'ZEROMEM_EMBEDDER',
  allowEmbedderSwitch: 'ZEROMEM_ALLOW_EMBEDDER_SWITCH',
  remoteEmbedder: 'ZEROMEM_EMBEDDING_URL',
  embeddingApiKey: 'ZEROMEM_EMBEDDING_API_KEY',
  sessionId: 'ZEROMEM_SESSION_ID',
};
