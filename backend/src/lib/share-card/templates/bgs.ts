/**
 * BGS variant. Silver/black gradient top-bar; reserves a small row above the
 * info column for sub-grade placeholders (Centering / Surface / Edges /
 * Corners). When sub-grades are not in `input` we render N/A.
 */

import { GRADER_BADGES, THEME } from '../theme.ts';
import type { SatoriNode, ShareCardInput } from '../types.ts';
import { buildBaseLayout } from './base.ts';

const bgsTopBar = (grade: string | null | undefined): SatoriNode => {
  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 56,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: THEME.canvas.paddingX,
        paddingRight: THEME.canvas.paddingX + 220,
        backgroundImage: `linear-gradient(90deg, ${GRADER_BADGES.BGS.bg} 0%, ${GRADER_BADGES.BGS.accent2 ?? '#444'} 50%, ${GRADER_BADGES.BGS.accent} 100%)`,
        color: GRADER_BADGES.BGS.fg,
        fontFamily: THEME.font.family,
        fontWeight: THEME.font.weights.bold,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: 22,
              letterSpacing: 4,
              color: GRADER_BADGES.BGS.fg,
            },
            children: 'BECKETT GRADING',
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: 22,
              letterSpacing: 3,
              color: GRADER_BADGES.BGS.fg,
            },
            children: grade ? `BGS ${grade}` : 'BGS',
          },
        },
      ],
    },
  };
};

export const render = (input: ShareCardInput, imageSrc: string): SatoriNode => {
  return buildBaseLayout(input, {
    badgeTheme: GRADER_BADGES.BGS,
    imageSrc,
    topBar: bgsTopBar(input.grade ?? null),
  });
};
