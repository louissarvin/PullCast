/**
 * "Card of the Day" template variant.
 *
 * Extends the generic layout with a gold ribbon header ("CARD OF THE DAY")
 * anchored to the top edge. Everything else - grader badge, image column,
 * info column, disclosure watermark - is delegated to `buildBaseLayout`
 * exactly like the PSA/BGS/CGC variants, so the daily post feels visually
 * consistent with regular auto-share cards.
 *
 * We keep the ribbon narrow (24px tall) so the underlying info column layout
 * from the base template is not pushed off-canvas. The ribbon also carries
 * the current date on the right so the daily post is self-contained (a user
 * scrolling past can tell it's a "today's card" post without extra chrome).
 */

import { GRADER_BADGES, THEME } from '../theme.ts';
import type { SatoriNode, ShareCardInput } from '../types.ts';
import { buildBaseLayout } from './base.ts';

const GOLD = '#F4C542';
const GOLD_DARK = '#B8860B';
const RIBBON_HEIGHT = 24;

const node = (
  type: string,
  style: Record<string, unknown>,
  children?: SatoriNode | SatoriNode[] | string | number | null,
  extraProps: Record<string, unknown> = {}
): SatoriNode => ({
  type,
  props: { style, children: children ?? null, ...extraProps },
});

const text = (value: string, style: Record<string, unknown>): SatoriNode =>
  node('div', { display: 'flex', ...style }, value);

const formatToday = (): string => {
  try {
    return new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      timeZone: 'UTC',
    });
  } catch {
    return '';
  }
};

const buildGoldRibbon = (): SatoriNode => {
  return node(
    'div',
    {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: RIBBON_HEIGHT,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: THEME.canvas.paddingX,
      paddingRight: THEME.canvas.paddingX,
      backgroundImage: `linear-gradient(90deg, ${GOLD_DARK} 0%, ${GOLD} 50%, ${GOLD_DARK} 100%)`,
      color: '#1A1200',
      fontFamily: THEME.font.family,
      fontWeight: THEME.font.weights.bold,
      fontSize: 14,
      letterSpacing: 3,
    },
    [
      text('CARD OF THE DAY', { color: '#1A1200' }),
      text(formatToday(), { color: '#1A1200' }),
    ]
  );
};

export const render = (input: ShareCardInput, imageSrc: string): SatoriNode => {
  const graderKey =
    input.gradingCompany === 'PSA'
      ? 'PSA'
      : input.gradingCompany === 'BGS'
        ? 'BGS'
        : input.gradingCompany === 'CGC'
          ? 'CGC'
          : input.gradingCompany === 'SGC'
            ? 'SGC'
            : 'GENERIC';
  const badgeTheme = GRADER_BADGES[graderKey];

  return buildBaseLayout(input, {
    badgeTheme,
    imageSrc,
    topBar: buildGoldRibbon(),
  });
};
