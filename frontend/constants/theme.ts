// ─── Colour palette ──────────────────────────────────────────────────────────
export const lightColors = {
  // Surfaces
  bg:          '#f5f5f5',
  darkBg:      '#0e0e0e',
  card:        '#ffffff',
  darkCard:    '#1a1a1a',
  darkCardAlt: '#222222',

  // Text
  ink:         '#111111',
  inkSoft:     '#555555',
  muted:       '#888888',
  mutedLight:  '#aaaaaa',
  white:       '#ffffff',
  black:       '#000000',

  // Borders / dividers
  border:      '#e8e8e8',
  darkBorder:  '#2a2a2a',

  // Accent / status
  lime:        '#C6F135',
  amber:       '#F5A623',
  danger:      '#FF5A5A',
  success:     '#22c55e',
  yellow:      '#f0c040',
} as const;

export const darkColors: typeof lightColors = {
  // Surfaces
  bg:          '#0e0e0e',
  darkBg:      '#000000',
  card:        '#1a1a1a',
  darkCard:    '#222222',
  darkCardAlt: '#2d2d2d',

  // Text — inverted
  ink:         '#f0f0f0',
  inkSoft:     '#cccccc',
  muted:       '#888888',
  mutedLight:  '#666666',
  white:       '#ffffff',
  black:       '#000000',

  // Borders / dividers — dark variants
  border:      '#2a2a2a',
  darkBorder:  '#3a3a3a',

  // Accent / status — unchanged
  lime:        '#C6F135',
  amber:       '#F5A623',
  danger:      '#FF5A5A',
  success:     '#22c55e',
  yellow:      '#f0c040',
};

/** The single canonical `colors` export — defaults to light (kept for backward compat). */
export const colors = lightColors;

/** Return the correct colour palette for the current theme. */
export function getColors(dark: boolean): typeof lightColors {
  return dark ? darkColors : lightColors;
}

/** Type alias for the colour palette. */
export type ColorPalette = typeof lightColors;

// ─── Spacing scale ────────────────────────────────────────────────────────────
export const spacing = {
  xxs: 2,
  xs:  4,
  sm:  8,
  md:  12,
  lg:  16,
  xl:  20,
  xxl: 24,
  xxxl: 32,
} as const;

// ─── Border radii ─────────────────────────────────────────────────────────────
export const radii = {
  sm:   8,
  md:   12,
  lg:   16,
  xl:   20,
  xxl:  24,
  full: 9999,
} as const;

// ─── Font sizes ───────────────────────────────────────────────────────────────
export const fontSize = {
  xs:      11,
  sm:      13,
  md:      15,
  lg:      17,
  xl:      20,
  xxl:     24,
  xxxl:    30,
  display: 52,
} as const;
