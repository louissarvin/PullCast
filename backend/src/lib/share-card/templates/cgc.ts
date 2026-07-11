/**
 * CGC variant. Blue top-bar with the CGC wordmark + grade.
 */

import { GRADER_BADGES, THEME } from '../theme.ts';
import type { SatoriNode, ShareCardInput } from '../types.ts';
import { buildBaseLayout } from './base.ts';

const cgcTopBar = (grade: string | null | undefined): SatoriNode => {
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
        backgroundColor: GRADER_BADGES.CGC.bg,
        color: GRADER_BADGES.CGC.fg,
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
              color: GRADER_BADGES.CGC.fg,
            },
            children: 'CGC CERTIFIED',
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: 22,
              letterSpacing: 3,
              color: GRADER_BADGES.CGC.fg,
            },
            children: grade ? `CGC ${grade}` : 'CGC',
          },
        },
      ],
    },
  };
};

export const render = (input: ShareCardInput, imageSrc: string): SatoriNode => {
  return buildBaseLayout(input, {
    badgeTheme: GRADER_BADGES.CGC,
    imageSrc,
    topBar: cgcTopBar(input.grade ?? null),
  });
};
