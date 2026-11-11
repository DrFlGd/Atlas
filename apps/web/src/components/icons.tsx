import { glyphColorOn, glyphFor } from '@atlas/core';

interface GlyphBadgeProps {
  icon: string;
  color: string;
  size?: number;
  /** Drawn faded, as on the map for found markers. */
  muted?: boolean;
}

/** A category's marker glyph on its coloured badge, as drawn on the map. Decorative. */
export function GlyphBadge({ icon, color, size = 20, muted = false }: GlyphBadgeProps) {
  const glyph = glyphFor(icon);
  return (
    <svg
      className="glyph-badge"
      width={size}
      height={size}
      viewBox="-5 -5 34 34"
      aria-hidden="true"
      focusable="false"
      style={muted ? { opacity: 0.45 } : undefined}
    >
      <circle
        cx="12"
        cy="12"
        r="16"
        fill={color}
        stroke="var(--atlas-marker-outline)"
        strokeWidth="1.6"
      />
      <path d={glyph.shape} fill={glyphColorOn(color)} />
      {glyph.holes ? <path d={glyph.holes} fill={color} fillRule="evenodd" /> : null}
    </svg>
  );
}

/** Interface icons, drawn on a 20 × 20 grid with strokes. Decorative; buttons carry the label. */
const UI_PATHS = {
  filters: 'M3 5h14M6 10h8M8.5 15h3',
  details: 'M4 4h12v12H4zM7 8h6M7 11h6M7 14h3',
  search: 'M8.5 3.5a5 5 0 1 1 0 10a5 5 0 1 1 0-10zM12.2 12.2L16.5 16.5',
  close: 'M5 5l10 10M15 5L5 15',
  check: 'M4 10.5l4 4l8-9',
  undo: 'M7 5L3.5 8.5L7 12M4 8.5h7.5a4.5 4.5 0 0 1 0 9H9',
  user: 'M10 3.5a3 3 0 1 1 0 6a3 3 0 1 1 0-6zM4 16.5c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5',
  sun: 'M10 6.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7zM10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6L16 16M4 16l1.4-1.4M14.6 5.4L16 4',
  moon: 'M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z',
  chevron: 'M7 5l5 5l-5 5',
  layers: 'M10 3l7 4l-7 4l-7-4zM3 11l7 4l7-4',
  target: 'M10 4a6 6 0 1 1 0 12a6 6 0 1 1 0-12zM10 1.5v4M10 14.5v4M1.5 10h4M14.5 10h4',
  trash: 'M4.5 6h11M8 6V4h4v2M6 6l.8 10h6.4L14 6',
  copy: 'M7 7h9v9H7zM4 13V4h9',
  pencil: 'M4 16l1-4l8-8l3 3l-8 8zM11.5 5.5l3 3',
  plus: 'M10 4v12M4 10h12',
  download: 'M10 3v10M6 9l4 4l4-4M4 16h12',
  upload: 'M10 14V4M6 8l4-4l4 4M4 16h12',
  folder: 'M2.5 5h5l1.5 2h8.5v9h-15z',
  checklist: 'M9 5.5h8M9 10h8M9 14.5h8M2.8 5.5l1.4 1.4l2.6-2.6M2.8 10l1.4 1.4l2.6-2.6M3 14.5h3',
  save: 'M4 3.5h9.5L16.5 6.5v10h-13zM7 3.5v4h6v-4M6.5 16.5v-5h7v5',
  mapPlus: 'M2.5 5l5-2l5 2l5-2v7M2.5 5v12l5-2l4 1.6M7.5 3v12M12.5 5v6M15.5 12.5v5M13 15h5',
} as const;

export type UiIconName = keyof typeof UI_PATHS;

export function UiIcon({ name, size = 18 }: { name: UiIconName; size?: number }) {
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={UI_PATHS[name]} />
    </svg>
  );
}
