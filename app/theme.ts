/**
 * The palette and type roles, matching ios/LabyrinthVault/Design/Theme.swift
 * value for value. One source of truth per platform, same numbers in both.
 */

export const ink = {
  void: '#08080A',
  surface: '#0C0C0E',
  paper: '#EFEAE2',
  paperDim: 'rgba(239,234,226,0.58)',
  paperFaint: 'rgba(239,234,226,0.34)',
  paperGhost: 'rgba(239,234,226,0.16)',
  rule: 'rgba(239,234,226,0.13)',
  verified: '#43946A',
  attention: '#E08A2E',
  refused: '#C24C3F',
  btc: '#D8842C',
  xmr: '#B8734A',
} as const;

/** SF Mono where available; Menlo ships on every iOS. */
export const mono = 'Menlo';

export const text = {
  eyebrow: {
    fontFamily: mono,
    fontSize: 10,
    letterSpacing: 2.2,
    color: ink.paperFaint,
    textTransform: 'uppercase' as const,
  },
  statement: {
    fontSize: 40,
    lineHeight: 40,
    fontWeight: '600' as const,
    letterSpacing: -1.4,
    color: ink.paper,
  },
} as const;
