/**
 * CLI configuration. All base URLs are env-overridable so a developer can
 * point at a staging deployment without a rebuild.
 *
 * Defaults per file 17_renaiss_cli_indexapi_research.md:
 *   - PullCast backend  : https://api.pullcast.xyz (fallback http://localhost:3700)
 *   - Renaiss main API  : https://api.renaiss.xyz
 *   - Renaiss OS Index  : https://api.renaissos.com
 */

export interface CliConfig {
  pullcastApiUrl: string;
  renaissApiUrl: string;
  renaissIndexUrl: string;
}

const trimTrailingSlash = (s: string): string => s.replace(/\/+$/, '');

export function loadConfig(): CliConfig {
  const pullcastApiUrl = trimTrailingSlash(
    process.env.PULLCAST_API_URL || 'https://api.pullcast.xyz'
  );
  const renaissApiUrl = trimTrailingSlash(
    process.env.RENAISS_API_URL || 'https://api.renaiss.xyz'
  );
  const renaissIndexUrl = trimTrailingSlash(
    process.env.RENAISS_INDEX_URL || 'https://api.renaissos.com'
  );
  return { pullcastApiUrl, renaissApiUrl, renaissIndexUrl };
}
