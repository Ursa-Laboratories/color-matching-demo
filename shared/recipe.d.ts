export type Component = 'red' | 'yellow' | 'blue';
export type Parts = Record<Component, number>;
export type Recipe = { parts: Parts; volumes: Parts; totalVolumeUl: number };
export const COMPONENTS: Component[];
export const TOTAL_VOLUME_UL: number;
export const VOLUME_STEP_UL: number;
export const MAX_PARTS: number;
export function makeRecipe(input: Parts): Recipe;
