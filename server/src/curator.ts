import { randomBytes } from 'node:crypto';
import type { ApiKeySource, CuratorConfig, CuratorSettings, CuratorSettingsUpdate } from '@mcp-zeromem/shared';
import type { ZeroMemEngine } from './engine/index.ts';

/** How long a read of the stored settings is trusted before the store is asked again. */
const CACHE_MS = 5000;

/**
 * The curator settings: stored in the engine (`meta.curator_config`) so the
 * Settings page can change them, with `MCP_ZEROMEM_CURATOR_TOKEN` overriding
 * the stored token. /mcp reads the token and `expose_to_all` on every
 * request, so they are cached briefly and replaced on every write.
 */
export class CuratorSettingsStore {
  private cached: { config: CuratorConfig; at: number } | null = null;
  private readonly engine: ZeroMemEngine;
  private readonly envToken: string | null;

  constructor(engine: ZeroMemEngine, envToken: string | null) {
    this.engine = engine;
    this.envToken = envToken;
  }

  async config(): Promise<CuratorConfig> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) {
      return this.cached.config;
    }
    const config = await this.engine.curatorConfig();
    this.cached = { config, at: Date.now() };
    return config;
  }

  /** The token that grants the curator scope, if any. */
  async token(): Promise<string | null> {
    return this.envToken ?? (await this.config()).token;
  }

  get envOverridesToken(): boolean {
    return this.envToken !== null;
  }

  /** The settings for the UI: the token is reported as set or not, and where it comes from. */
  async view(): Promise<CuratorSettings> {
    const [config, runs] = await Promise.all([this.config(), this.engine.curationRuns({ limit: 1 })]);
    const source: ApiKeySource = this.envToken ? 'env' : config.token ? 'store' : 'none';
    return {
      max_per_call: config.max_per_call,
      max_per_run: config.max_per_run,
      min_age_ms: config.min_age_ms,
      expose_to_all: config.expose_to_all,
      token_set: source !== 'none',
      token_source: source,
      last_run_at: runs.runs[0]?.ended_at ?? null,
      cursor: runs.cursor,
    };
  }

  /** Store new settings; `token` absent keeps the stored one, null clears it. */
  async update(update: CuratorSettingsUpdate): Promise<CuratorSettings> {
    const current = await this.engine.curatorConfig();
    const token = update.token === undefined ? current.token : update.token;
    await this.write({ ...current, ...update, token });
    return this.view();
  }

  /** Mint and store a new token; the caller shows it once. */
  async generateToken(): Promise<{ token: string; settings: CuratorSettings }> {
    const token = randomBytes(24).toString('base64url');
    const current = await this.engine.curatorConfig();
    await this.write({ ...current, token });
    return { token, settings: await this.view() };
  }

  private async write(config: CuratorConfig): Promise<void> {
    const stored = await this.engine.setCuratorConfig(config);
    this.cached = { config: stored, at: Date.now() };
  }
}
