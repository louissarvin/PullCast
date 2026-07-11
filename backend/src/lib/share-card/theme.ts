/**
 * Color tokens, font sizes, and grader-badge palette for the share card.
 *
 * Designed for 1200x630 OG cards on a dark background. Per-grader accents
 * mirror the real-world slab colors so collectors recognize them at a glance.
 */

export interface BadgeTheme {
  bg: string;
  fg: string;
  accent: string;
  /** Optional sub-accent used by BGS for the silver/black gradient. */
  accent2?: string;
  label: string;
}

export const GRADER_BADGES = {
  PSA: {
    bg: '#C8102E',
    fg: '#FFFFFF',
    accent: '#C8102E',
    label: 'PSA',
  },
  BGS: {
    bg: '#1A1A1A',
    fg: '#E5E5E5',
    accent: '#C0C0C0',
    accent2: '#5C5C5C',
    label: 'BGS',
  },
  CGC: {
    bg: '#0033A0',
    fg: '#FFFFFF',
    accent: '#0033A0',
    label: 'CGC',
  },
  SGC: {
    bg: '#00753A',
    fg: '#FFFFFF',
    accent: '#00753A',
    label: 'SGC',
  },
  GENERIC: {
    bg: '#1F2937',
    fg: '#F3F4F6',
    accent: '#6B7280',
    label: 'Raw',
  },
} as const satisfies Record<string, BadgeTheme>;

/**
 * Gacha tier color palette. Falls back to common-gray when an unrecognized
 * tier string lands here. Matched case-insensitively in `tierColor()`.
 */
export const TIER_COLORS: Record<string, string> = {
  legendary: '#FFD700',
  mythic: '#FF3DAD',
  epic: '#F97316',
  rare: '#A855F7',
  uncommon: '#3B82F6',
  common: '#9CA3AF',
};

export const tierColor = (tier: string | null | undefined): string => {
  if (!tier) return TIER_COLORS.common!;
  const key = tier.trim().toLowerCase();
  return TIER_COLORS[key] ?? TIER_COLORS.common!;
};

export const THEME = {
  canvas: {
    width: 1200,
    height: 630,
    paddingX: 56,
    paddingY: 48,
    bg: '#0B0F19',
    bgGradientTo: '#111827',
    cardRadius: 24,
  },
  text: {
    primary: '#F9FAFB',
    secondary: '#D1D5DB',
    muted: '#9CA3AF',
    positive: '#22C55E',
    negative: '#EF4444',
  },
  font: {
    family: 'Inter',
    sizes: {
      title: 56,
      subtitle: 24,
      label: 18,
      value: 64,
      pnl: 40,
      small: 16,
      watermark: 14,
    },
    weights: {
      regular: 400,
      semibold: 600,
      bold: 800,
    } as const,
  },
  layout: {
    imageColumnPct: 0.46,
    badgeTopY: 32,
    badgeHeight: 56,
  },
} as const;

export type ThemeShape = typeof THEME;
