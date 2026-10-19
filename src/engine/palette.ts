/**
 * Label colours. Labelled entities get distinct colours so a video model can
 * tell the grey shapes apart ("the red figure is the hero"). One palette for
 * the Inspector swatches and the agent tools.
 */

export type LabelColorName = 'red' | 'amber' | 'green' | 'blue' | 'purple' | 'pink' | 'teal' | 'orange'

export const LABEL_COLOR_NAMES: Record<LabelColorName, string> = {
  red: '#e5484d',
  amber: '#f5a524',
  green: '#46a758',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  teal: '#14b8a6',
  orange: '#f97316'
}

export const LABEL_SWATCHES: string[] = Object.values(LABEL_COLOR_NAMES)

/** First swatch not in `used`; once all are taken, cycle by count. */
export function nextLabelColor(used: string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()))
  return LABEL_SWATCHES.find((c) => !taken.has(c)) ?? LABEL_SWATCHES[used.length % LABEL_SWATCHES.length]!
}

/** A colour name or `#rrggbb` → lowercase hex; anything else → null. */
export function resolveColor(input: string): string | null {
  const v = input.trim().toLowerCase()
  if (v in LABEL_COLOR_NAMES) return LABEL_COLOR_NAMES[v as LabelColorName]
  return /^#[0-9a-f]{6}$/.test(v) ? v : null
}
