import { readFileSync } from 'node:fs';

/**
 * Version reported in /api/status and MCP server info.
 *
 * Read from the root package.json at load time so it tracks the released
 * version — semantic-release bumps that file at release time, and the
 * Dockerfile copies it into the runtime image. The path is two levels up from
 * this module in both dev (`server/src/version.ts`) and prod
 * (`server/dist/version.js`), so it resolves to the repo/app root in both.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_VERSION = readVersion();
