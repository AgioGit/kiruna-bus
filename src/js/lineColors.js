import { store } from './appState.js';
import { AIRPORT_SHUTTLE_LINE_ID, TRAIN_SHUTTLE_LINE_ID } from './lineProperties.js';

// The API's own LineAppearance.background is unreliable for this purpose
// (e.g. GetMapRoute for the Röd/red line was observed returning "#000000"
// black - see docs/initial_plan.md). Colors are instead derived from the Swedish
// color-name each line is known by, matched against Line.text.
const LINE_COLOR_RULES = [
  { match: /gr(ö|o)n/i, color: '#2e7d32', name: 'green' }, // Grön
  { match: /gul/i, color: '#f9a825', name: 'yellow' }, // Gul
  { match: /lila/i, color: '#7b1fa2', name: 'purple' }, // Lila
  { match: /r(ö|o)d/i, color: '#c62828', name: 'red' }, // Röd
  { lineId: TRAIN_SHUTTLE_LINE_ID, match: /^tåg(?:[.\s-]|$)/i, color: '#1565c0', name: 'blue' },
  { lineId: AIRPORT_SHUTTLE_LINE_ID, match: /^flyg(?:[.\s-]|$)/i, color: '#00796b', name: 'teal' },
];
const FALLBACK_COLOR = '#555555';

export function colorForLineText(text) {
  const rule = LINE_COLOR_RULES.find((r) => r.match.test(text ?? ''));
  return rule?.color ?? FALLBACK_COLOR;
}

export function colorForLineId(lineId) {
  const rule = LINE_COLOR_RULES.find((item) => item.lineId === lineId);
  if (rule) return rule.color;
  const line = store.get().lines.find((l) => l.id === lineId);
  return line ? colorForLineText(line.text) : FALLBACK_COLOR;
}

export function lineColorOrderForId(lineId) {
  const color = colorForLineId(lineId);
  const index = LINE_COLOR_RULES.findIndex((rule) => rule.color === color);
  return index === -1 ? LINE_COLOR_RULES.length : index;
}

export function textColorForLineId(lineId) {
  return colorForLineId(lineId) === '#f9a825' ? '#1a1a1a' : '#ffffff';
}
