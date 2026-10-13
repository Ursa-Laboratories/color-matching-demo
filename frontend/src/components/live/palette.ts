import type { Recipe } from '../../../../shared/recipe.js';

// An illustrative artist-RYB cube, not a model of the actual dyes.
// Normalize by the strongest ingredient so the preview stays saturated.
// Nothing in this preview affects the recipe or hardware volumes.
const CUBE = [
  [250, 248, 240], [233, 99, 86], [237, 196, 65], [238, 143, 64],
  [84, 119, 220], [137, 85, 163], [77, 157, 115], [119, 103, 91],
];
export function previewPalette(recipe: Recipe | null) {
  if (!recipe) return { color: '#e1e2e8', background: '#f4f4f7' };
  const { red, yellow, blue } = recipe.volumes;
  const max = Math.max(red, yellow, blue);
  const weights = [red / max, yellow / max, blue / max];
  const rgb = [0, 1, 2].map(channel => Math.round(CUBE.reduce((sum, corner, index) => {
    const weight = weights.reduce((product, amount, bit) => product * ((index & (1 << bit)) ? amount : 1 - amount), 1);
    return sum + corner[channel] * weight;
  }, 0)));
  return {
    color: `rgb(${rgb.join(', ')})`,
    background: `rgb(${rgb.map(value => Math.round(249 - value * .12)).join(', ')})`,
  };
}
