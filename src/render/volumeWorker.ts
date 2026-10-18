/**
 * Web Worker that meshes volume-world tiles off the main thread. It builds
 * its own copy of the world from (id, seed), which is deterministic, so its
 * meshes match the field the physics uses on the main thread.
 *
 * Protocol:
 *   in  { type: 'init', id, seed }
 *   in  { type: 'want', keys }            keys in priority order (replaces the queue)
 *   out { type: 'tile', key, positions, normals, colors, index, minY, maxY }   (buffers transferred)
 */
import { buildWorld } from '../world/recipes';
import { VolumeWorld } from '../world/volume';
import { decodeTileKey, VolumeMesher } from '../world/volumeMesh';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

let mesher: VolumeMesher | null = null;
let queue: number[] = [];
const done = new Set<number>();
let scheduled = false;

function pump(): void {
  scheduled = false;
  const key = queue.shift();
  if (key === undefined || !mesher) return;
  if (!done.has(key)) {
    done.add(key);
    const [tx, tz, lod] = decodeTileKey(key, mesher.world.period);
    const m = mesher.build(tx, tz, lod);
    scope.postMessage(
      { type: 'tile', key, positions: m.positions, normals: m.normals, colors: m.colors, index: m.index, minY: m.minY, maxY: m.maxY },
      [m.positions.buffer, m.normals.buffer, m.colors.buffer, m.index.buffer],
    );
  }
  // Yield between tiles so a new 'want' list can re-prioritize.
  if (queue.length && !scheduled) {
    scheduled = true;
    setTimeout(pump, 0);
  }
}

scope.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; id?: string; seed?: number; keys?: number[] };
  if (msg.type === 'init') {
    const world = buildWorld(msg.id!, msg.seed!);
    if (!(world instanceof VolumeWorld)) throw new Error(`not a volume world: ${msg.id}`);
    mesher = new VolumeMesher(world);
    queue = [];
    done.clear();
  } else if (msg.type === 'want') {
    queue = msg.keys!.filter((k) => !done.has(k));
  }
  if (queue.length && !scheduled) {
    scheduled = true;
    setTimeout(pump, 0);
  }
};
