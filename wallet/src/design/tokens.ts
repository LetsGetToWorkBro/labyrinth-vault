/**
 * The visual language, in one file, with the reasoning attached.
 *
 * Labyrinth Vault and Labyrinth Wallet are two halves of one instrument and
 * have to look like it. What they share is here: the same near-black, the same
 * warm white, the same right angles, the same intolerance for decoration. What
 * differs is temperament, and that is a matter of how these tokens are used
 * rather than of what they are. The vault is still. It shows one thing at a
 * time and asks a person to read it. The wallet moves — balances update,
 * confirmations arrive, frames animate — because the chain moves and this is
 * the half that watches it.
 *
 * ## Why dark, and why this dark
 *
 * Not for fashion. This application is used in two situations: glancing at a
 * balance, and standing in a room holding two phones with a camera pointed at
 * one of them. In the second, the screen is a light source aimed at a lens.
 * A near-black field with a single bright element in it is the difference
 * between a QR code a seven-year-old camera can resolve and a glowing white
 * rectangle it cannot.
 *
 * `#050506` rather than `#000000` because true black on OLED turns the panel
 * off, and the boundary between an off pixel and a lit one crawls during a
 * scroll. A single point of grey costs nothing and holds still.
 *
 * ## Why the colour is rationed
 *
 * There are exactly five colours in this application that are not a grey: two
 * for the assets, three for state. Everything else is warm white on near-black
 * at varying weight. That is not minimalism as a style — it is what makes a
 * red mean something. A wallet where every card has a gradient has no way left
 * to say "this transaction does not match what you approved", which is the
 * one sentence in the whole product that has to land.
 *
 * ## The two assets
 *
 * Bitcoin is amber and Monero is a paler gold. They are close enough to be
 * family and far enough apart to tell at a glance in a list — which is the
 * only place they are ever adjacent. Neither is the logo colour. Neither is
 * saturated enough to fight the typography. The asset is named in words
 * anyway, because colour alone is not an accessible way to say which chain
 * somebody is about to spend from, and the amounts involved make that
 * unusually not-negotiable.
 */

// ---------------------------------------------------------------- the palette

export const color = {
  /** The ground. Everything sits on this. */
  void: '#050506',
  /** A recess: input wells, the space behind a scanner. */
  well: '#0B0B0D',
  /** A surface with something on it. */
  surface: '#111114',
  /** The nearest thing to a card, used sparingly. */
  raised: '#17171B',
  /** Pressed state for anything tappable. */
  pressed: '#1E1E23',

  /** Structure. Hairlines, never boxes. */
  rule: 'rgba(242, 238, 231, 0.07)',
  ruleStrong: 'rgba(242, 238, 231, 0.14)',

  /** Warm white. The colour of everything that matters. */
  bone: '#F3F0E9',
  /** Secondary text: readable, quieter, still passes contrast on `void`. */
  ash: '#8F8D96',
  /** Tertiary: labels, units, the tail of a fraction. */
  slate: '#5C5A64',
  /** Barely there: disabled, and the unlit half of a progress geometry. */
  dim: '#33323A',

  /** Bitcoin. Amber, warm, unsaturated enough to sit under text. */
  btc: '#E08A3C',
  btcDim: 'rgba(224, 138, 60, 0.16)',
  /** Monero. Pale gold, distinguishable from amber at a glance in a list. */
  xmr: '#C4A265',
  xmrDim: 'rgba(196, 162, 101, 0.16)',

  /** State. Three, and they are the only three. */
  good: '#67A88A',
  goodDim: 'rgba(103, 168, 138, 0.14)',
  warn: '#D6A44E',
  warnDim: 'rgba(214, 164, 78, 0.14)',
  alarm: '#C9564B',
  alarmDim: 'rgba(201, 86, 75, 0.16)',

  /** The QR code's white. Not `bone`: a code is read by a machine and wants
   *  the widest contrast the panel can produce, warmth be damned. */
  codeLight: '#FFFFFF',
  codeDark: '#000000',
} as const;

export function assetColor(asset: 'BTC' | 'XMR'): string {
  return asset === 'BTC' ? color.btc : color.xmr;
}

export function assetTint(asset: 'BTC' | 'XMR'): string {
  return asset === 'BTC' ? color.btcDim : color.xmrDim;
}

// ------------------------------------------------------------------- letters

/**
 * Two faces, and neither of them is a brand font.
 *
 * The system face, because this is an iOS application and San Francisco is
 * what an iPhone reads best at every size, in every accessibility setting,
 * without a megabyte of webfont. Set tight and large, it is as severe as
 * anything that could be licensed.
 *
 * Menlo for anything a person has to check character by character: addresses,
 * transaction ids, digests, key fingerprints. This is the one place a
 * monospace is not an aesthetic choice — `bc1q0lxs` and `bc1qOlx5` differ by
 * two characters that a proportional face makes almost identical, and the
 * entire security model of the product ends with a person comparing an address
 * on this screen against one on another.
 */
export const face = {
  system: undefined as string | undefined,
  mono: 'Menlo',
} as const;

/**
 * The scale.
 *
 * Six sizes, and a caps label. Any design that needs a seventh is a design
 * with a hierarchy problem, and adding one is how a screen turns into a
 * dashboard.
 *
 * `readout` and `display` carry negative tracking because at that size the
 * default spacing looks slack; the small sizes carry positive tracking because
 * at that size it looks cramped. Both are the same instinct — set the type,
 * do not accept it.
 */
export const type = {
  /** The balance. One per screen, at most. */
  display: { fontSize: 64, lineHeight: 66, letterSpacing: -2.4, fontWeight: '200' as const },
  /** A large amount inside a flow. */
  readout: { fontSize: 44, lineHeight: 48, letterSpacing: -1.6, fontWeight: '250' as const },
  /** Screen titles. */
  title: { fontSize: 27, lineHeight: 32, letterSpacing: -0.6, fontWeight: '500' as const },
  /** Row headlines, amounts in lists. */
  strong: { fontSize: 17, lineHeight: 22, letterSpacing: -0.2, fontWeight: '500' as const },
  /** Prose. The security explanations are set here and nowhere smaller. */
  body: { fontSize: 15, lineHeight: 22, letterSpacing: -0.1, fontWeight: '400' as const },
  /** Supporting detail. */
  small: { fontSize: 13, lineHeight: 18, letterSpacing: 0, fontWeight: '400' as const },
  /** The caps label. The single most Labyrinth thing in the type system: it
   *  is how both applications name a thing without decorating it. */
  label: { fontSize: 10.5, lineHeight: 14, letterSpacing: 1.9, fontWeight: '600' as const },
  /** A caps label with room to breathe, for section heads. */
  labelWide: { fontSize: 11, lineHeight: 15, letterSpacing: 2.8, fontWeight: '600' as const },
} as const;

/** Applied to every numeral that can change while it is on screen. Without it
 *  a balance ticking from 8 to 1 shifts every digit to its left, and an
 *  instrument that jitters is not an instrument. */
export const tabular = { fontVariant: ['tabular-nums' as const] };

// -------------------------------------------------------------------- space

/**
 * A four-point grid, named for what it is for rather than by t-shirt size.
 *
 * `gutter` is the horizontal margin of every screen in the application and it
 * is 24, which on a 390pt phone leaves a 342pt column: wide enough for a
 * grouped address in Menlo at 15pt, which is what set it.
 */
export const space = {
  hair: 2,
  tight: 4,
  snug: 8,
  step: 12,
  gap: 16,
  gutter: 24,
  section: 32,
  chapter: 48,
  breath: 64,
} as const;

export const radius = {
  /** Fields, rows, chips. Small enough to still read as a rectangle. */
  soft: 14,
  /** Sheets and full-width panels. */
  panel: 24,
  /** The QR frame. */
  code: 28,
  round: 999,
} as const;

// ------------------------------------------------------------------- motion

/**
 * Timing, as a small vocabulary rather than a number at every call site.
 *
 * Everything that moves in this application does so under a spring, except
 * things that measure time — the QR frame cadence, a progress sweep — which
 * are linear, because a spring on a clock is a lie about how fast something is
 * happening.
 *
 * The springs are all critically damped or near it. Nothing in a wallet should
 * overshoot: bounce reads as playfulness, and this is an application whose
 * whole job is to be believed.
 */
export const motion = {
  /** Most things. Panels, sheets, opacity, the state of a row. */
  standard: { damping: 26, stiffness: 220, mass: 1 },
  /** Big surfaces that should feel weighty: the send sheet, the scanner. */
  heavy: { damping: 30, stiffness: 150, mass: 1.1 },
  /** Small confirmations: a tick appearing, a chip changing state. */
  quick: { damping: 22, stiffness: 340, mass: 0.7 },
  /** The one place a little overshoot is allowed: a signature arriving back
   *  from the vault, which is genuinely a moment. */
  arrival: { damping: 14, stiffness: 190, mass: 0.9 },

  /** Milliseconds, for the linear ones. */
  frame: 220,
  sweep: 900,
  fade: 180,
} as const;

/** How long a piece of feedback stays before it fades on its own. */
export const dwell = { toast: 1800, copied: 1400 } as const;
