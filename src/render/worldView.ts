/** Rendering side of a world recipe. One implementation per kind of world. */
import type * as THREE from 'three';
import type { GameWorld } from '../world/recipes';
import { CityWorld } from '../world/city';
import { SandboxWorld } from '../world/sandbox';
import { TerrainWorld } from '../world/terrain';
import { VolumeWorld } from '../world/volume';
import type { FloatingOrigin } from './origin';
import { CityView } from './cityView';
import { SandboxView } from './sandboxView';
import { TerrainView } from './terrainView';
import { VolumeView } from './volumeView';

export interface WorldView {
  readonly object: THREE.Object3D;
  /**
   * Once per frame: stream/generate around the focus (world coordinates,
   * usually the drone) within budgetMs, and place everything relative to
   * the floating origin.
   */
  update(focusX: number, focusZ: number, origin: FloatingOrigin, budgetMs: number): void;
  setDrawDistance(d: number): void;
  /** Prepare everything around the focus right now, ignoring the budget (world load, reset). */
  prime?(focusX: number, focusZ: number, origin: FloatingOrigin): void;
  /** One line for the debug overlay. */
  status(): string;
  dispose(): void;
}

export function createWorldView(world: GameWorld): WorldView {
  if (world instanceof TerrainWorld) return new TerrainView(world);
  if (world instanceof CityWorld) return new CityView(world);
  if (world instanceof SandboxWorld) return new SandboxView(world);
  if (world instanceof VolumeWorld) return new VolumeView(world);
  throw new Error(`No renderer for world "${world.id}"`);
}
