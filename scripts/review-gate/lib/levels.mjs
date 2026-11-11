// The four levels every triage field uses (Impact, Complexity, Fix risk, Severity), lowest first.
export const LEVELS = ['Low', 'Medium', 'High', 'Severe'];

// The level named by `value` (any case), or null.
export function normalizeLevel(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return LEVELS.find((l) => l.toLowerCase() === v) ?? null;
}

export const levelIndex = (level) => LEVELS.indexOf(normalizeLevel(level));

// The highest of the levels given (nulls ignored), or null when none is a level.
export function maxLevel(...levels) {
  const idx = levels.flat().map(levelIndex).filter((i) => i >= 0);
  return idx.length ? LEVELS[Math.max(...idx)] : null;
}

// `level` raised by `steps`, capped at Severe.
export function bumpLevel(level, steps = 1) {
  const i = levelIndex(level);
  if (i < 0) return null;
  return LEVELS[Math.min(LEVELS.length - 1, i + Math.max(0, steps))];
}

// `level`, at least `floor`.
export const atLeast = (level, floor) => maxLevel(level, floor);
