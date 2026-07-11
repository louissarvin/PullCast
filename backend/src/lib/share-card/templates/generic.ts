/**
 * Generic variant. Used for SGC pulls and any raw / ungraded card. No top-bar;
 * the top-right badge picks up SGC green when applicable, otherwise the
 * neutral dark-gray "Raw" badge.
 */

import { GRADER_BADGES } from '../theme.ts';
import type { SatoriNode, ShareCardInput } from '../types.ts';
import { buildBaseLayout } from './base.ts';

export const render = (input: ShareCardInput, imageSrc: string): SatoriNode => {
  const badgeTheme = input.gradingCompany === 'SGC' ? GRADER_BADGES.SGC : GRADER_BADGES.GENERIC;
  return buildBaseLayout(input, {
    badgeTheme,
    imageSrc,
  });
};
