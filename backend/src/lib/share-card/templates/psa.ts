/**
 * PSA variant. Red top-bar with the white "PSA" wordmark, grade rendered
 * inside the corner badge with PSA's signature slab styling.
 */

import { GRADER_BADGES, THEME } from '../theme.ts';
import type { SatoriNode, ShareCardInput } from '../types.ts';
import { buildBaseLayout } from './base.ts';

const psaTopBar = (grade: string | null | undefined): SatoriNode => {
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
        paddingRight: THEME.canvas.paddingX + 220, // leave room for top-right badge
        backgroundColor: GRADER_BADGES.PSA.bg,
        color: GRADER_BADGES.PSA.fg,
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
              color: GRADER_BADGES.PSA.fg,
            },
            children: 'PSA AUTHENTICATED',
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: 22,
              letterSpacing: 3,
              color: GRADER_BADGES.PSA.fg,
            },
            children: grade ? `GRADE ${grade}` : 'GRADED',
          },
        },
      ],
    },
  };
};

export const render = (input: ShareCardInput, imageSrc: string): SatoriNode => {
  return buildBaseLayout(input, {
    badgeTheme: GRADER_BADGES.PSA,
    imageSrc,
    topBar: psaTopBar(input.grade ?? null),
  });
};
