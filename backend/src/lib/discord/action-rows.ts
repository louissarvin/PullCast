import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const LOG_PREFIX = '[discord]';

/**
 * Build the two-button row that ships under every pull-share embed.
 *
 * - "View on Renaiss" deep-links to the collectible / pack page.
 * - "Share to X" opens an X (Twitter) intent prefilled with the share-card
 *   image URL and the suggested text.
 *
 * Both are LINK buttons so they require no interaction handler; Discord
 * renders them as direct-open hyperlinks.
 */
export interface PullActionRowOptions {
  renaissUrl: string;
  tweetText: string;
  tweetUrl: string;
}

export const buildPullActionRow = (
  opts: PullActionRowOptions
): ActionRowBuilder<ButtonBuilder> => {
  const safeRenaissUrl = sanitizeHttpUrl(opts.renaissUrl, 'https://renaiss.xyz');
  const safeTweetUrl = sanitizeHttpUrl(opts.tweetUrl, 'https://pullcast.xyz');
  const safeTweetText =
    typeof opts.tweetText === 'string' && opts.tweetText.length > 0
      ? opts.tweetText
      : 'Just pulled this card.';

  const intentUrl = new URL('https://twitter.com/intent/tweet');
  intentUrl.searchParams.set('text', safeTweetText);
  intentUrl.searchParams.set('url', safeTweetUrl);

  const renaissBtn = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel('View on Renaiss')
    .setURL(safeRenaissUrl);

  const shareBtn = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel('Share to X')
    .setURL(intentUrl.toString());

  return new ActionRowBuilder<ButtonBuilder>().addComponents(renaissBtn, shareBtn);
};

/**
 * Discord rejects non-http(s) URLs on link buttons. We coerce anything else
 * to the provided fallback (instead of throwing) so a malformed input never
 * blocks a share-card post.
 */
const sanitizeHttpUrl = (raw: string, fallback: string): string => {
  if (typeof raw !== 'string' || raw.length === 0) {
    console.warn(`${LOG_PREFIX} sanitizeHttpUrl received empty input, using fallback`);
    return fallback;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(`${LOG_PREFIX} sanitizeHttpUrl rejected non-http protocol=${parsed.protocol}`);
      return fallback;
    }
    return parsed.toString();
  } catch {
    console.warn(`${LOG_PREFIX} sanitizeHttpUrl could not parse url, using fallback`);
    return fallback;
  }
};
