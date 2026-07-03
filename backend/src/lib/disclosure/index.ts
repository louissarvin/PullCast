/**
 * Disclosure helper. The SAFETY judging criterion in one file.
 *
 * Every Discord embed, share card, AI response MUST route through here so we
 * cannot accidentally publish data without the beta + experimental + not
 * financial advice markers required by file 17 Section 7.
 *
 * NEVER mutate these constants at runtime. NEVER stringify them through a
 * formatter that could elide the trailing period.
 */

const LOG_PREFIX = '[disclosure]';

/**
 * Full disclosure text. Used on the primary surface of every embed and on the
 * share card watermark slot when there is room (1200x630).
 */
export const DISCLOSURE_TEXT_FULL =
  'Beta data from Renaiss API and Renaiss Index API (experimental). Sources cited. Not financial advice.' as const;

/**
 * Short disclosure for tight surfaces (compact embed, narrow share card,
 * inline mention). Always pairs with a sourceCitation block on AI responses.
 */
export const DISCLOSURE_TEXT_SHORT = 'Beta data. Not financial advice.' as const;

/**
 * Bottom-right watermark string for rendered share cards. Two short lines
 * keep the corner unobtrusive while still surfacing the brand + the beta
 * marker.
 */
export const DISCLOSURE_WATERMARK = 'Beta · pullcast.xyz' as const;

/**
 * Wrap any payload with a top-level `_disclosure` marker. The non-symbol key
 * survives JSON.stringify so HTTP and Discord consumers cannot accidentally
 * drop it during normalization.
 */
export const attachDisclosure = <T>(obj: T): T & { _disclosure: string } => {
  return Object.assign({}, obj, { _disclosure: DISCLOSURE_TEXT_FULL }) as T & {
    _disclosure: string;
  };
};

/**
 * Discord-shaped embed footer. Matches the `EmbedFooterOptions` shape from
 * discord.js v14 (text + optional icon). Returned as a plain object so the
 * embed-builders can spread it into `setFooter(...)`.
 */
export interface DiscordEmbedFooter {
  text: string;
  iconURL?: string;
}

export const discordEmbedFooter = (): DiscordEmbedFooter => {
  return { text: DISCLOSURE_TEXT_FULL };
};

/**
 * Formats `[source-N]` citation lines for the bottom of an AI response embed.
 *
 * Empty input returns the bare short disclosure so we still ship something
 * that satisfies the safety mandate even when retrieval returned no chunks
 * (the citation-guard upstream should refuse, but defense-in-depth).
 */
export const getSourceCitationBlock = (
  sources: Array<{ name: string; url: string }>
): string => {
  if (!Array.isArray(sources) || sources.length === 0) {
    console.warn(`${LOG_PREFIX} getSourceCitationBlock called with no sources`);
    return DISCLOSURE_TEXT_SHORT;
  }
  const lines = sources.map((s, idx) => {
    const name = typeof s?.name === 'string' && s.name.length > 0 ? s.name : 'untitled';
    const url = typeof s?.url === 'string' ? s.url : '';
    return `[source-${idx + 1}] ${name} (${url})`;
  });
  return lines.join('\n');
};
