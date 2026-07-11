/**
 * Shared layout primitives for share-card templates.
 *
 * Satori accepts React-element-shaped objects. We model the tree as plain
 * `SatoriNode` records (see `../types.ts`) so this module needs no JSX, no
 * `react` dependency, and no .tsx files (the project's tsconfig only includes
 * .ts).
 *
 * The base layout fills 1200x630, places the card image on the left ~46% of
 * the canvas, and stacks card info, FMV, P&L, and metadata on the right. The
 * disclosure watermark goes bottom-left. Every grader variant calls
 * `buildBaseLayout` and then layers a top-bar accent specific to the slab
 * brand.
 */

import { DISCLOSURE_WATERMARK } from '../../disclosure/index.ts';
import { THEME, tierColor, type BadgeTheme } from '../theme.ts';
import type { SatoriNode, ShareCardInput } from '../types.ts';

const MAX_TITLE_CHARS = 32;

const truncate = (s: string, max = MAX_TITLE_CHARS): string => {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
};

const formatUsdCents = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '--';
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const formatSignedUsdCents = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '--';
  const sign = cents >= 0 ? '+' : '-';
  const dollars = Math.abs(cents) / 100;
  return `${sign}${dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const shortenAddress = (addr: string): string => {
  if (typeof addr !== 'string' || addr.length < 12) return addr ?? '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
};

const formatPulledAt = (d: Date): string => {
  try {
    return d.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    });
  } catch {
    return d.toISOString();
  }
};

const node = (
  type: string,
  style: Record<string, unknown>,
  children?: SatoriNode | SatoriNode[] | string | number | null,
  extraProps: Record<string, unknown> = {}
): SatoriNode => ({
  type,
  props: { style, children: children ?? null, ...extraProps },
});

const text = (
  value: string | number,
  style: Record<string, unknown>
): SatoriNode => node('div', { display: 'flex', ...style }, String(value));

/**
 * Grader badge in the top-right. Visual: pill with bold grader code + grade
 * value. PSA/BGS/CGC override the surface color via `theme.bg`.
 */
const buildGraderBadge = (input: ShareCardInput, badgeTheme: BadgeTheme): SatoriNode => {
  const graderLabel = badgeTheme.label;
  const grade = input.grade?.trim();
  return node(
    'div',
    {
      position: 'absolute',
      top: THEME.layout.badgeTopY,
      right: THEME.canvas.paddingX,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      height: THEME.layout.badgeHeight,
      paddingLeft: 20,
      paddingRight: 20,
      backgroundColor: badgeTheme.bg,
      color: badgeTheme.fg,
      borderRadius: 28,
      fontFamily: THEME.font.family,
      fontWeight: THEME.font.weights.bold,
      fontSize: 22,
      letterSpacing: 1.5,
      gap: 12,
    },
    [
      text(graderLabel, { color: badgeTheme.fg }),
      grade
        ? text(grade, {
            color: badgeTheme.fg,
            fontWeight: THEME.font.weights.semibold,
            opacity: 0.95,
          })
        : text('', { display: 'none' }),
    ]
  );
};

const buildImageColumn = (input: ShareCardInput, imageSrc: string): SatoriNode => {
  const accent = tierColor(input.tier ?? null);
  const imgWidth = Math.floor((THEME.canvas.width - THEME.canvas.paddingX * 2) * THEME.layout.imageColumnPct);
  const imgHeight = THEME.canvas.height - THEME.canvas.paddingY * 2 - 80;
  return node(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      width: imgWidth,
      height: imgHeight,
      borderRadius: THEME.canvas.cardRadius,
      overflow: 'hidden',
      boxShadow: `0 16px 48px rgba(0,0,0,0.45), 0 0 0 3px ${accent}66`,
      backgroundColor: '#000',
    },
    [
      node('img', {
        width: imgWidth,
        height: imgHeight,
        objectFit: 'cover',
      }, null, { src: imageSrc }),
    ]
  );
};

const buildInfoColumn = (input: ShareCardInput): SatoriNode => {
  const fmvText = formatUsdCents(input.fmvUsdCents);
  const pnlText = formatSignedUsdCents(input.netGainUsdCents);
  const pnlColor =
    input.netGainUsdCents === null || input.netGainUsdCents === undefined
      ? THEME.text.muted
      : input.netGainUsdCents >= 0
        ? THEME.text.positive
        : THEME.text.negative;

  const subtitleParts: string[] = [];
  if (input.setName) subtitleParts.push(input.setName);
  if (input.cardNumber) subtitleParts.push(`#${input.cardNumber}`);
  const subtitle = subtitleParts.join('  ·  ');

  return node(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      marginLeft: 40,
      gap: 6,
    },
    [
      text(truncate(input.cardName, MAX_TITLE_CHARS), {
        fontSize: THEME.font.sizes.title,
        fontWeight: THEME.font.weights.bold,
        color: THEME.text.primary,
        lineHeight: 1.05,
      }),
      subtitle
        ? text(subtitle, {
            fontSize: THEME.font.sizes.subtitle,
            color: THEME.text.secondary,
            marginTop: 2,
          })
        : text('', { display: 'none' }),
      node(
        'div',
        { display: 'flex', flexDirection: 'column', marginTop: 28, gap: 4 },
        [
          text('FAIR MARKET VALUE', {
            fontSize: THEME.font.sizes.label,
            color: THEME.text.muted,
            fontWeight: THEME.font.weights.semibold,
            letterSpacing: 1.6,
          }),
          text(fmvText, {
            fontSize: THEME.font.sizes.value,
            color: THEME.text.primary,
            fontWeight: THEME.font.weights.bold,
            lineHeight: 1.05,
          }),
          text(pnlText, {
            fontSize: THEME.font.sizes.pnl,
            color: pnlColor,
            fontWeight: THEME.font.weights.bold,
            marginTop: 4,
          }),
        ]
      ),
      node(
        'div',
        {
          display: 'flex',
          flexDirection: 'column',
          marginTop: 24,
          gap: 4,
        },
        [
          text(`${input.packLabel} · ${formatUsdCents(input.packPriceUsdCents)}`, {
            fontSize: THEME.font.sizes.small,
            color: THEME.text.secondary,
          }),
          text(`Pulled ${formatPulledAt(input.pulledAt)}`, {
            fontSize: THEME.font.sizes.small,
            color: THEME.text.muted,
          }),
          text(`Buyer ${shortenAddress(input.buyerAddress)}`, {
            fontSize: THEME.font.sizes.small,
            color: THEME.text.muted,
          }),
          input.serial
            ? text(`Cert ${input.serial}`, {
                fontSize: THEME.font.sizes.small,
                color: THEME.text.muted,
              })
            : text('', { display: 'none' }),
        ]
      ),
    ]
  );
};

const buildFooterRow = (): SatoriNode => {
  return node(
    'div',
    {
      position: 'absolute',
      bottom: 28,
      left: THEME.canvas.paddingX,
      right: THEME.canvas.paddingX,
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    [
      text(DISCLOSURE_WATERMARK, {
        fontSize: THEME.font.sizes.watermark,
        color: THEME.text.muted,
        fontWeight: THEME.font.weights.semibold,
        letterSpacing: 0.5,
      }),
      text('pullcast.xyz', {
        fontSize: THEME.font.sizes.watermark,
        color: THEME.text.secondary,
        fontWeight: THEME.font.weights.semibold,
        letterSpacing: 0.5,
      }),
    ]
  );
};

export interface BaseLayoutOptions {
  badgeTheme: BadgeTheme;
  imageSrc: string;
  /** Optional accent bar across the top of the card (per-grader). */
  topBar?: SatoriNode;
}

export const buildBaseLayout = (input: ShareCardInput, opts: BaseLayoutOptions): SatoriNode => {
  return node(
    'div',
    {
      width: THEME.canvas.width,
      height: THEME.canvas.height,
      display: 'flex',
      position: 'relative',
      backgroundImage: `linear-gradient(135deg, ${THEME.canvas.bg} 0%, ${THEME.canvas.bgGradientTo} 100%)`,
      fontFamily: THEME.font.family,
      color: THEME.text.primary,
    },
    [
      opts.topBar ?? node('div', { display: 'none' }),
      buildGraderBadge(input, opts.badgeTheme),
      node(
        'div',
        {
          display: 'flex',
          flexDirection: 'row',
          flex: 1,
          paddingLeft: THEME.canvas.paddingX,
          paddingRight: THEME.canvas.paddingX,
          paddingTop: THEME.canvas.paddingY + 16,
          paddingBottom: THEME.canvas.paddingY + 40,
          alignItems: 'center',
        },
        [
          buildImageColumn(input, opts.imageSrc),
          buildInfoColumn(input),
        ]
      ),
      buildFooterRow(),
    ]
  );
};

/** Helper exported so per-grader templates can compose their own top-bars. */
export const buildTopBar = (
  background: string,
  label: string,
  textColor = '#FFFFFF',
  rightContent?: string
): SatoriNode => {
  return node(
    'div',
    {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 14,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: THEME.canvas.paddingX,
      paddingRight: THEME.canvas.paddingX,
      backgroundColor: background,
      color: textColor,
      fontFamily: THEME.font.family,
      fontWeight: THEME.font.weights.bold,
      fontSize: 0,
    },
    [
      text(label, { fontSize: 0 }),
      rightContent ? text(rightContent, { fontSize: 0 }) : text('', { display: 'none' }),
    ]
  );
};
