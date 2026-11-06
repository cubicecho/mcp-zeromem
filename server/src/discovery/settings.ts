import { isIPv4, isIPv6 } from 'node:net';
import {
  type DiscoveryConfig,
  type DiscoverySettings,
  type DiscoverySettingsUpdate,
  discoveryConfigSchema,
} from '@mcp-zeromem/shared';
import type { ZeroMemEngine } from '../engine/index.ts';

/** The name every resolver maps to the loopback interface. */
const LOOPBACK_NAME = 'localhost';

/** What every IPv4 loopback address (127.0.0.0/8) starts with. */
const IPV4_LOOPBACK_PREFIX = '127.';

/** The IPv6 loopback address. */
const IPV6_LOOPBACK = '::1';

/** What an IPv4 loopback address looks like when it is mapped into IPv6. */
const MAPPED_IPV4_LOOPBACK_PREFIX = '::ffff:127.';

/**
 * Tells whether a listen address is reachable from this machine only.
 *
 * @param host - The address the server binds, as `HOST` gives it.
 * @returns true for `localhost`, `127.x.x.x` and `::1`.
 */
export function isLoopbackHost(host: string): boolean {
  const address = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (isIPv4(address)) {
    return address.startsWith(IPV4_LOOPBACK_PREFIX);
  }
  if (isIPv6(address)) {
    return address === IPV6_LOOPBACK || address.startsWith(MAPPED_IPV4_LOOPBACK_PREFIX);
  }
  return address === LOOPBACK_NAME;
}

/** What the discovery settings need from the process. */
export interface DiscoverySettingsOptions {
  /** The address the server binds (`HOST`); null when it listens on every interface. */
  listenHost: string | null;
  /** Called after the settings change, so the announcement can follow them. */
  onChange?: () => void;
}

/**
 * The discovery settings: stored in the engine (`meta.discovery_config`) so the Settings page can change them.
 *
 * @remarks
 * The advertiser asks `isAdvertiseWanted` synchronously, so the last value read or written is kept here. Only this
 * process writes it, so the copy cannot go stale behind its back.
 */
export class DiscoverySettingsStore {
  private stored: DiscoveryConfig = discoveryConfigSchema.parse({});
  private readonly engine: ZeroMemEngine;
  private readonly onChange: () => void;
  /** The server binds a loopback address only, so an announcement would point at an address nobody can reach. */
  readonly isLoopbackOnly: boolean;

  /**
   * Builds the store; nothing is read until `load`.
   *
   * @param engine - Where the settings are stored.
   * @param options - The listen address, and who to tell about a change.
   */
  constructor(engine: ZeroMemEngine, options: DiscoverySettingsOptions) {
    this.engine = engine;
    this.onChange = options.onChange ?? (() => undefined);
    this.isLoopbackOnly = options.listenHost !== null && isLoopbackHost(options.listenHost);
  }

  /** Someone turned advertising on, whether or not this server can act on it. */
  get isAdvertiseRequested(): boolean {
    return this.stored.lan_advertise;
  }

  /** The server should be announced: advertising is on and it listens beyond loopback. */
  get isAdvertiseWanted(): boolean {
    return this.isAdvertiseRequested && this.isLoopbackOnly === false;
  }

  /**
   * Reads the settings from the store and keeps them.
   *
   * @returns The settings as stored.
   */
  async load(): Promise<DiscoveryConfig> {
    this.stored = await this.engine.discoveryConfig();
    return this.stored;
  }

  /**
   * Reads the settings for the UI.
   *
   * @returns The stored setting and whether this server can act on it.
   */
  async view(): Promise<DiscoverySettings> {
    const { lan_advertise } = await this.load();
    return { lan_advertise, loopback_only: this.isLoopbackOnly };
  }

  /**
   * Stores new settings and tells `onChange`.
   *
   * @param update - The whole settings object.
   * @returns The settings as the UI sees them after the write.
   */
  async update(update: DiscoverySettingsUpdate): Promise<DiscoverySettings> {
    this.stored = await this.engine.setDiscoveryConfig(update);
    this.onChange();
    return { lan_advertise: this.stored.lan_advertise, loopback_only: this.isLoopbackOnly };
  }
}
