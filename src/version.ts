/**
 * Shared reader for the package version.
 *
 * Read from package.json so callers stay in sync with the published package
 * (previously the server version was hard-coded to '0.0.1', which gave clients no way to
 * tell the running version — see #3). This file sits directly under src/ (dev via tsx)
 * and under dist/ (built via tsc), so package.json is always one level up.
 * If it cannot be read, fall back to '0.0.0' rather than failing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch (e) {
    // Reaching here means the build layout is broken (package.json is expected one level up
    // from this file in both dev and dist). Warn on stderr rather than silently reporting a
    // bogus version — the whole point (#3) is that the reported version is trustworthy.
    // stdout is reserved for JSON-RPC, so write only to stderr.
    process.stderr.write(
      `[lockage] warning: could not read version from package.json, falling back to 0.0.0 (${String(e)})\n`,
    );
  }
  return '0.0.0';
}
