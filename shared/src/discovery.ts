import { z } from 'zod';

/**
 * Discovery: how the HTTP server makes itself findable. The discovery
 * documents (`/.well-known/ai-catalog.json` and `/mcp/server-card`) are always
 * served; these settings only control the mDNS announcement on the LAN.
 */

/** The discovery settings as the engine stores them (`meta.discovery_config`). Server-side only. */
export const discoveryConfigSchema = z.object({
  /** Announce the server over mDNS as `_mcp._tcp`. */
  lan_advertise: z.boolean().default(false),
});
export type DiscoveryConfig = z.infer<typeof discoveryConfigSchema>;

/** `GET /api/settings/discovery` — the stored setting, and whether this server can act on it. */
export const discoverySettingsSchema = z.object({
  /** Announce the server over mDNS as `_mcp._tcp`, so tools on the same network find it without its address. */
  lan_advertise: z.boolean().default(false),
  /** The server listens on a loopback address only (`HOST`), so it is never announced whatever the setting says. */
  loopback_only: z.boolean(),
});
export type DiscoverySettings = z.infer<typeof discoverySettingsSchema>;

/** `PUT /api/settings/discovery` — the whole settings object. */
export const discoverySettingsUpdateSchema = z.object({
  lan_advertise: z.boolean(),
});
export type DiscoverySettingsUpdate = z.infer<typeof discoverySettingsUpdateSchema>;
