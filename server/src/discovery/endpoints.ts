import { hostname } from 'node:os';
import { type AdvertisedEndpoint, airIdentifier, createServerCard, type KeyValueInput } from '@cubicecho/mcp-discovery';
import { SERVER_VERSION } from '../version.ts';

/** The reverse-DNS namespace every card's name starts with; the host's slug is appended to it. */
const CARD_NAMESPACE = 'io.github.cubicecho.zeromem';

/** What follows the host's slug in the catalog entry's `urn:air` publisher. */
const AIR_PUBLISHER = 'zeromem';

/** The project's source, shown on the card. */
const REPOSITORY = { url: 'https://github.com/cubicecho/mcp-zeromem', source: 'github' } as const;

/** The path of the streamable-HTTP MCP endpoint. */
const MCP_PATH = '/mcp';

/** The endpoint's stable name under the host, the last part of its card name and `urn:air` id. */
const ENDPOINT_NAME = 'memory';

/** The card's description; a Server Card allows 100 characters. */
const DESCRIPTION = 'Conversational memory for agents: recall what was said, with no model in the loop.';

/** The slug of a hostname that has no letter or digit left once cleaned. */
const FALLBACK_HOST_SLUG = 'host';

/** The header a client must send when bearer auth is on; its value is never in the card. */
const AUTH_HEADER: KeyValueInput = {
  name: 'Authorization',
  description: 'Bearer <token>: MCP_ZEROMEM_TOKEN, or the curator token for the curator tools',
  isRequired: true,
  isSecret: true,
};

/** What the endpoints are built from. */
export interface DiscoveryEndpointOptions {
  /** `/mcp` asks for a bearer token, so the card declares the `Authorization` header. */
  isAuthRequired: boolean;
  /**
   * The machine's hostname, which keeps card names apart when two servers share a network.
   *
   * @defaultValue `os.hostname()`
   */
  host?: string;
}

/**
 * Cuts a hostname down to what a card name and a `urn:air` id allow: lowercase letters, digits and hyphens.
 *
 * @param name - The machine's hostname.
 * @returns The first label, cleaned, e.g. `nas` for `NAS` and `my-box` for `my_box.lan`.
 */
export function hostSlug(name: string): string {
  const [first = ''] = name.toLowerCase().split('.');
  return first.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || FALLBACK_HOST_SLUG;
}

/**
 * Lists the MCP endpoints this server makes discoverable: `/mcp`, the only HTTP one.
 *
 * @param options - Whether auth is on, and optionally the hostname.
 * @returns The endpoint, with a card builder that names the URL the request came in on.
 *
 * @remarks
 * The curator token opens the same endpoint with more tools, so it is not a second entry.
 */
export function discoveryEndpoints(options: DiscoveryEndpointOptions): AdvertisedEndpoint[] {
  const { isAuthRequired, host = hostname() } = options;
  const slug = hostSlug(host);
  const headers = isAuthRequired ? [AUTH_HEADER] : [];
  return [
    {
      path: MCP_PATH,
      identifier: airIdentifier(`${slug}.${AIR_PUBLISHER}`, ENDPOINT_NAME),
      card: ({ endpointUrl }) =>
        createServerCard({
          name: `${CARD_NAMESPACE}.${slug}/${ENDPOINT_NAME}`,
          version: SERVER_VERSION,
          title: `MCP Zeromem on ${host}`,
          description: DESCRIPTION,
          repository: REPOSITORY,
          remotes: [{ type: 'streamable-http', url: endpointUrl, headers }],
        }),
    },
  ];
}
