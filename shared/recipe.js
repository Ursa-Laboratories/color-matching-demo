export const COMPONENTS = ['red', 'yellow', 'blue'];
export const TOTAL_VOLUME_UL = 150;
export const VOLUME_STEP_UL = 5;
export const MAX_PARTS = 10;

// Largest-remainder rounding preserves the fixed total with pipettable increments.
export function makeRecipe(input) {
  const parts = {};
  for (const name of COMPONENTS) {
    const value = input?.[name];
    if (!Number.isInteger(value) || value < 0 || value > MAX_PARTS)
      throw new Error(`${name} must be an integer from 0 to ${MAX_PARTS}.`);
    parts[name] = value;
  }
  const total = COMPONENTS.reduce((sum, name) => sum + parts[name], 0);
  if (!total) throw new Error('Add at least one color to your mixture.');
  const units = TOTAL_VOLUME_UL / VOLUME_STEP_UL;
  const exact = COMPONENTS.map(name => parts[name] * units / total);
  const allocated = exact.map(Math.floor);
  const order = [0, 1, 2].sort((a, b) => (exact[b] - allocated[b]) - (exact[a] - allocated[a]) || a - b);
  const remaining = units - allocated.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < remaining; i++) allocated[order[i]]++;
  return { parts, volumes: Object.fromEntries(COMPONENTS.map((name, i) => [name, allocated[i] * VOLUME_STEP_UL])), totalVolumeUl: TOTAL_VOLUME_UL };
}
