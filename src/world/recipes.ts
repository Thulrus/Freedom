/**
 * World recipes: a pluggable bundle of generator + palette + sky + physics
 * category. Rendering picks a view by world id; physics only ever sees the
 * WorldQuery interface.
 *
 * Training worlds keep real Earth physics. A recipe that changes physics
 * (low gravity, thermals...) must be category 'playground' and say so.
 */
import type { Vec3, WorldQuery } from '../sim';
import { ArchesWorld } from './arches';
import { CityWorld } from './city';
import { IslandsWorld } from './islands';
import { buildSandbox } from './sandbox';
import { TerrainWorld } from './terrain';

export type WorldId = 'hills' | 'city' | 'arches' | 'islands' | 'sandbox';

/** Colors as 0xRRGGBB (sRGB). */
export interface SkyPalette {
  zenith: number;
  horizon: number;
  sun: number;
  /** Light bounced up from the ground (hemisphere light's lower color); defaults to grass. */
  bounce?: number;
}

export interface TerrainPalette {
  waterShallow: number;
  waterDeep: number;
  sand: number;
  grass: number;
  grassAlt: number;
  rock: number;
  snow: number;
  pine: number;
  broadleaf: number;
  trunk: number;
  boulder: number;
}

/** A world the app can fly in. */
export interface GameWorld extends WorldQuery {
  readonly id: WorldId;
  readonly seed: number;
  /** Launch pad position on the ground, m. */
  readonly spawn: Vec3;
  /** Heading at spawn, radians (0 = facing -Z). */
  readonly spawnYaw: number;
  /** Ground height under (x, z) for shadows and cameras, m. For worlds with overhangs: the top surface. */
  groundHeight(x: number, z: number): number;
  /** The first surface below (x, y, z), m: for worlds with overhangs, arches and floating islands. */
  floorBelow?(x: number, y: number, z: number): number;
}

/** Height of the surface under a point (the floor beneath an arch, not its top). */
export function floorUnder(w: GameWorld, x: number, y: number, z: number): number {
  return w.floorBelow ? w.floorBelow(x, y, z) : w.groundHeight(x, z);
}

export interface Recipe {
  id: WorldId;
  name: string;
  category: 'training' | 'playground';
  blurb: string;
  sky: SkyPalette;
  build(seed: number): GameWorld;
}

const HILLS_TERRAIN: TerrainPalette = {
  waterShallow: 0x4fa8c2,
  waterDeep: 0x2b5f8f,
  sand: 0xe3d3a1,
  grass: 0x7fae5c,
  grassAlt: 0x9bbd63,
  rock: 0x8d8a92,
  snow: 0xf3f6fa,
  pine: 0x3f7a4a,
  broadleaf: 0x6aa34a,
  trunk: 0x7a5a3e,
  boulder: 0xa29d97,
};

export const RECIPES: Record<WorldId, Recipe> = {
  hills: {
    id: 'hills',
    name: 'Rolling hills',
    category: 'training',
    blurb: 'Endless hills, lakes, forests and mountains. Real physics.',
    sky: { zenith: 0x3d6fb6, horizon: 0xbfd6e6, sun: 0xfff1c9 },
    build: (seed) => new TerrainWorld(seed, HILLS_TERRAIN),
  },
  city: {
    id: 'city',
    name: 'Low-poly city',
    category: 'training',
    blurb: 'Endless streets: downtown towers, skybridges, alleys and parks. Real physics.',
    sky: { zenith: 0x4a77b8, horizon: 0xcdd9e3, sun: 0xfff1c9 },
    build: (seed) => new CityWorld(seed),
  },
  arches: {
    id: 'arches',
    name: 'Arches',
    category: 'training',
    blurb: 'Red-rock canyon packed with arches, windows, tunnels, skylights, slots and hoodoos. Wraps around every 640 m. Real physics.',
    sky: { zenith: 0x4a80c4, horizon: 0xf0c9a0, sun: 0xfff0d2, bounce: 0xb98a66 },
    build: (seed) => new ArchesWorld(seed),
  },
  islands: {
    id: 'islands',
    name: 'Sky islands',
    category: 'training',
    blurb: 'Floating islands over a cloud sea: tunnels, drop shafts, rope bridges, stone arches and golden rings. Wraps around every 640 m. Real physics.',
    sky: { zenith: 0x3b7ad6, horizon: 0xdcebf6, sun: 0xfff6e0, bounce: 0xa7b0c4 },
    build: (seed) => new IslandsWorld(seed),
  },
  sandbox: {
    id: 'sandbox',
    name: 'Sandbox',
    category: 'training',
    blurb: 'Flat field with pillars and a gate loop. Real physics.',
    sky: { zenith: 0x3d6fb6, horizon: 0xbfd6e6, sun: 0xfff1c9 },
    build: (seed) => buildSandbox(seed),
  },
};

export function buildWorld(id: string, seed: number): GameWorld {
  const recipe = RECIPES[id as WorldId] ?? RECIPES.hills;
  return recipe.build(Number.isFinite(seed) ? Math.floor(seed) : 1);
}
