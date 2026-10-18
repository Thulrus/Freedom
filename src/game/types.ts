/**
 * Game-mode building blocks. Everything in game/ is pure logic (no DOM, no
 * rendering), so courses, scoring and replays run headless in tests.
 */
import type { QuadState } from '../sim';
import type { BoxDef, GateDef } from '../world/boxes';
import type { GameWorld } from '../world/recipes';

/**
 * Something to fly through in a given direction.
 * - 'gate': a solid frame is added to the world (and drawn).
 * - 'window': an invisible-to-physics window, drawn as a faint outline (slalom sides, figure-8 lines).
 * - 'existing': the world already has a frame here (sandbox gates); only the highlight is drawn.
 */
export interface Checkpoint extends GateDef {
  style: 'gate' | 'window' | 'existing';
}

export interface Pylon {
  x: number;
  /** Ground height at its foot, m. */
  y: number;
  z: number;
  height: number;
  color: number;
}

/** A box the pilot should hold position in (hover drill). Axis-aligned. */
export interface Zone {
  x: number;
  y: number;
  z: number;
  half: number;
}

export interface Layout {
  checkpoints: Checkpoint[];
  pylons: Pylon[];
  zone: Zone | null;
  /** Solid boxes to add to the world (gate frames, pylons). */
  boxes: BoxDef[];
}

export type RunPhase = 'ready' | 'running' | 'finished' | 'failed';

export interface RunResult {
  success: boolean;
  /** Headline number (seconds or metres). */
  score: number;
  /** How to show it, e.g. "38.42 s". */
  scoreText: string;
  /** Whether a lower score is better (times) or higher. */
  lowerIsBetter: boolean;
  /** 0..3 */
  stars: number;
  /** Feedback lines (what went well, what to work on). */
  lines: string[];
}

export interface ActivityRun {
  phase: RunPhase;
  /** Once per rendered frame with the latest physics state. Detects crossings etc. between frames. */
  update(s: QuadState): void;
  /** Big status line for the HUD (e.g. "LAP 2/3 · 0:23.41"). */
  hud(s: QuadState): string;
  /** Smaller hint line (what to do next). */
  hint(s: QuadState): string;
  /** Where to point the pilot next (world coordinates), or null. */
  target(): { x: number; y: number; z: number } | null;
  /** Index into layout.checkpoints of the highlighted checkpoint, or -1. */
  nextCheckpoint(): number;
  /** Set once phase is finished or failed. */
  result(): RunResult | null;
}

export interface ActivityDef {
  id: string;
  name: string;
  blurb: string;
  /** Shown before the run starts. */
  instructions: string;
  /** World-dependent obstacle layout (deterministic for a world + seed). */
  layout(world: GameWorld): Layout;
  /** A fresh attempt on that layout. */
  start(world: GameWorld, layout: Layout): ActivityRun;
}

/** Forward unit vector of a checkpoint (the direction you must fly through it). */
export function forwardOf(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

/**
 * If the segment p0 -> p1 crosses the checkpoint's plane forwards inside its
 * opening, returns the fraction along the segment (0..1); otherwise -1.
 */
export function crossFraction(c: GateDef, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
  const d0 = (x0 - c.x) * fx + (z0 - c.z) * fz;
  const d1 = (x1 - c.x) * fx + (z1 - c.z) * fz;
  if (!(d0 < 0 && d1 >= 0)) return -1;
  const u = d0 / (d0 - d1);
  const px = x0 + (x1 - x0) * u, py = y0 + (y1 - y0) * u, pz = z0 + (z1 - z0) * u;
  // Lateral axis is local +X: (cos yaw, 0, -sin yaw).
  const lat = (px - c.x) * fz - (pz - c.z) * fx;
  if (Math.abs(lat) > c.width / 2 || Math.abs(py - c.y) > c.height / 2) return -1;
  return u;
}

/** "1:02.35" or "42.35 s". */
export function formatTime(t: number): string {
  if (!Number.isFinite(t)) return '--';
  if (t < 60) return `${t.toFixed(2)} s`;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function starsFor(value: number, thresholds: [number, number, number], lowerIsBetter: boolean): number {
  let n = 0;
  for (const t of thresholds) if (lowerIsBetter ? value <= t : value >= t) n++;
  return n;
}
