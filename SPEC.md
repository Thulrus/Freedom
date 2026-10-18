# Browser FPV Drone Simulator — Project Spec

## 1. Vision

A drone flight simulator that runs entirely in the browser, designed **mobile-first** with on-screen touch controls. The goal is genuine practice value for people learning to fly real FPV/acro quadcopters, wrapped in **stylized, procedurally generated worlds** (landscapes, cityscapes, and optionally fanciful or physically impossible geography).

No backend. Static files only. Should work offline once loaded (PWA).

### Priority order (when tradeoffs arise, higher wins)

1. **Flight physics and control feel.** This is the product. If it doesn't feel like a real quad, nothing else matters.
2. **Input quality and latency** (touch sticks, gamepad, radio transmitter).
3. **Stable performance on mid-range phones** (steady 60 fps beats visual fidelity).
4. **Procedural worlds** (stylized, infinite/streaming, extensible to impossible geometry).
5. **Game modes** (free flight, gates/races, training drills).
6. **Polish** (audio, effects, UI niceties).

### Non-goals

- Photorealism.
- Multiplayer / accounts / leaderboards (maybe much later).
- Crash damage realism.
- Supporting every possible aircraft type. Start with one 5" freestyle quad; make the parameter set swappable.

---

## 2. Tech stack

- **TypeScript + Vite**, no framework required for the sim. A light UI layer (plain DOM/CSS or something tiny like Preact) is fine for menus and settings.
- **Three.js** for rendering is acceptable and recommended for speed of development. Raw WebGL2 is acceptable if there is a clear performance reason; custom GLSL shaders are welcome for the stylized look.
- Physics is **hand-written** (no general-purpose physics engine). A drone needs a custom rigid body with motor/controller models; an engine would fight us.
- Physics module must be **pure TypeScript with zero DOM/Three.js dependencies** so it can run headless in Node for tests and optionally in a Web Worker.
- PWA: service worker, manifest, offline support, landscape orientation preference, fullscreen request.

---

## 3. Architecture

Strict module boundaries:

```
src/
  sim/            # PURE: no DOM, no rendering. Physics, motors, battery, controller, modes.
  input/          # Touch sticks, Gamepad API, keyboard; outputs normalized RC channels.
  world/          # Procedural generation, chunk streaming, collision queries, world "recipes".
  render/         # Three.js scene, camera rig, materials, post-processing, LOD.
  game/           # Modes: free flight, race gates, drills. Scoring, timing.
  ui/             # HUD/OSD, menus, settings, tuning panel, debug overlay.
  platform/       # PWA, storage, fullscreen/orientation, haptics, perf monitoring.
  tests/          # Headless sim tests, determinism tests, worldgen tests.
```

**Data flow per frame:**
`input -> RC channels (sampled at each physics tick) -> sim.step(dt) -> state -> render interpolates between last two states`

The renderer never drives the physics. Physics runs on a fixed-timestep accumulator; rendering interpolates.

---

## 4. Flight simulation (highest priority)

### 4.1 Timestep and integration

- Fixed inner loop at **500 Hz** (configurable up to 1 kHz). Accumulator pattern with a max-substeps clamp to avoid spiral of death on slow frames.
- Quaternion orientation, renormalized each step. Semi-implicit Euler is the baseline; use RK4 or similar for rotation if it measurably improves stability.
- **No heap allocation in the hot loop.** Preallocated vectors/quaternions/typed arrays. Zero garbage per tick.
- Deterministic: same seed + same input log must produce the same trajectory (needed for replays and tests).

### 4.2 Vehicle model

Quad-X configuration with a parameter object (all tunable at runtime and exportable as JSON):

- Mass, inertia tensor (diagonal is fine to start), arm length, motor positions and spin directions.
- **Motor model:** first-order lag on motor speed (spin-up and spin-down time constants, with spin-down slower than spin-up), thrust `~ kT * omega^2`, reaction torque `~ kQ * omega^2`. Max thrust such that thrust-to-weight is roughly 6–10:1 for a freestyle build (make this a parameter).
- **Drag:** linear + quadratic translational drag; rotational damping. Consider anisotropic drag (body-frame axes differ).
- **Battery:** voltage sag under load, affecting available thrust (simple internal-resistance model is enough). Optional but desirable for realism.
- **Second-order effects (add after core feels right):** propwash disturbance when descending through own wake, ground effect near surfaces, motor saturation with airmode-style mixer desaturation.
- Collision: simple sphere/capsule vs. world collision query (see Section 6). Crash = disarm + reset option. No deformation.

### 4.3 Flight controller (Betaflight-style)

This is crucial: acro mode IS rate control, and real pilots need real rate profiles.

- **Rate controller:** PID on angular rate error, with feedforward. Gyro-rate setpoint comes from stick input through a rate curve.
- **Rate curves:** support Betaflight-style *Actual Rates*, *Quick Rates*, and *Super Rates* (center sensitivity, max rate, expo). Provide presets (beginner, freestyle, racing). Users who already know their real quad's rates should be able to type them in.
- **Throttle:** mid and expo settings. Throttle is a non-centering axis (see Input).
- **Mixer:** standard quad-X mix with desaturation (airmode on/off toggle).
- **Flight modes:**
  - **Acro** (default, the practice mode): rate control only.
  - **Angle:** stick sets target tilt, self-levels.
  - **Horizon:** angle near center, acro at extremes.
  - **Optional beginner assists:** altitude hold, brake/auto-level helpers. Clearly labeled as not representative of real acro flight.
- Optional: simulated gyro filtering / D-term lag, if it improves authenticity without harming stability.
- **Arm/disarm** with a throttle-low safety, plus **turtle mode** (flip after crash) as a stretch goal.

### 4.4 Camera

- **FPV camera:** adjustable tilt (default ~30°, range 0–60°), FOV (default ~120° diagonal-ish, adjustable), optional slight latency/smoothing, optional vignette and subtle lens distortion.
- **Chase/third-person** and **line-of-sight** (fixed observer) views for beginners and for spotting.
- OSD overlay: battery voltage, flight mode, timer, altitude, speed, armed state. Toggleable.

### 4.5 Validation

- Provide **reference tuning flows**: step-response tests for rate controller (roll/pitch/yaw), hover-throttle equilibrium check, free-fall and terminal velocity sanity checks.
- Expose every physics and controller parameter in a **live tuning panel** (with JSON import/export) so feel can be iterated quickly on-device.
- Design the project so experienced FPV pilots can test and give feedback (shareable settings JSON).

---

## 5. Input

### 5.1 Touch controls (critical and inherently limited)

Virtual sticks cannot replicate spring-loaded gimbals. Design to minimize the gap and be upfront about it in-app.

- Two virtual sticks, **Mode 2 default** (left: throttle/yaw, right: pitch/roll), with Modes 1/3/4 selectable.
- **Fixed-position sticks by default** (floating optional). Resizable and repositionable. Large touch area, thumb-friendly.
- **Throttle stick must not auto-center** by default (holds position when released), with an option for self-centering throttle for beginners.
- Adjustable **deadzone, expo, and sensitivity** per stick, independent of the in-sim rates.
- Reliable **multi-touch** (use Pointer Events, `touch-action: none`, suppress browser gestures/scroll/zoom/long-press, handle touch cancel and focus loss safely: disarm or hold last-safe state).
- Sample input at each physics tick, not just on render frame, using the latest pointer state (and coalesced events where available) to minimize latency.
- Optional haptic feedback (vibration) for arm/disarm and collisions.
- Landscape orientation preferred; handle rotation and safe areas (notches).

### 5.2 Gamepad and radio transmitters

- **Gamepad API** support for Bluetooth/USB gamepads and for real radio transmitters in USB joystick mode (EdgeTX/OpenTX etc.). This is the best path for serious practice.
- Axis mapping and calibration screen, invert toggles, per-axis range calibration, saved profiles.
- Arm switch and mode switch mapping to buttons/aux channels.

### 5.3 Keyboard

- Keyboard fallback for desktop development and debugging. Not a priority for polish.

---

## 6. World generation

### 6.1 Principles

- **Stylized, not realistic:** flat or gradient shading, limited palettes, strong fog/atmosphere, simple silhouettes, minimal textures. Cheap to render and visually distinctive.
- **Deterministic from a seed:** same seed produces the same world.
- **Streaming and effectively infinite:** chunks generated around the drone, discarded behind it. Generation work budgeted per frame (or done in a Web Worker) so it never causes hitches.
- **Floating origin rebasing** to avoid float32 jitter far from the origin.

### 6.2 Key architectural decision: worlds are defined by a query interface, not just heightmaps

To keep impossible/fanciful geography possible from day one, every world implements a common interface used by both rendering and physics:

```ts
interface WorldQuery {
  // signed distance to nearest solid surface (negative = inside)
  distance(p: Vec3): number;
  // normal at/near point, for collision response
  normal(p: Vec3, out: Vec3): Vec3;
  // optional: raycast for line-of-sight, gates, camera collision
  raycast(origin: Vec3, dir: Vec3, maxDist: number): Hit | null;
}
```

Collision uses this interface (sphere/capsule vs. distance). Meshes for rendering are generated per chunk from the same underlying definition (heightfield meshing for simple terrain; marching-cubes/surface-nets or hand-built meshes for non-heightfield features like arches, overhangs, floating islands, tunnels).

A **world recipe** is a pluggable bundle: generator(s) + palette + sky/fog settings + prop sets + optional physics profile + suggested course types.

### 6.3 World recipes (initial and aspirational)

**Initial (build first):**
- **Rolling hills / mountains** — heightfield noise, stylized color bands, scattered low-poly trees/rocks (instanced).
- **Low-poly city** — grid or Voronoi districts, instanced buildings with height variety, plazas, bridges, optional rooftops/gaps to fly through. Must be fast: merged/instanced geometry only.

**Fanciful (design for it, build after core is solid):**
- Floating islands with waterfalls pouring into nothing.
- Inverted mountains / upside-down terrain layers.
- Giant mushroom or tree forest with flyable canopies and trunk tunnels.
- Ring worlds / curved horizons (cheap shader trick before true geometry).
- Escher-style impossible structures, looping staircases, portals/wrap-around spaces.
- Cave and canyon networks for tight technical flying.
- Neon/synthwave grid worlds, desert of giant objects, etc.

### 6.4 Physics vs. world weirdness

- **Default physics is always realistic Earth gravity.** The point is practice.
- A world recipe *may* declare a physics profile (low gravity, wind zones, thermals) but these must be clearly labeled as **"Playground"** worlds, separate from **"Training"** worlds that keep realistic physics. Never silently change flight feel in a training world.
- Wind is a good optional feature (gusts, turbulence) for training: constant + noise-based, adjustable.

### 6.5 Performance rules for worlds

- Instancing for repeated props; merged buffers for city blocks; aggressive LOD and distance fog to hide pop-in.
- Chunk mesh generation off the main thread where possible; no per-frame allocations.
- Strict budgets (see Section 8).

---

## 7. Game modes

Build after physics, input, and basic world are solid.

1. **Free flight:** pick a world and seed, fly freely, reset with a button.
2. **Race / gate courses:** procedurally placed gates, lap timing, ghost replay of best lap (deterministic replay makes this cheap).
3. **Training drills:** hover hold, figure-8, power loop, split-S, dive-and-recover, slalom, proximity flying. Each drill has success criteria and feedback. This is where the practice value shines.
4. **Challenges (stretch):** timed collection, precision landing, tight-gap flying.

Include **replay and input recording**, and a **flight telemetry view** (stick inputs, rates, throttle, motor outputs) for reviewing a flight.

---

## 8. Performance budgets (mid-range phone, ~3 years old)

- **Stable 60 fps** is the target; consistent frame pacing matters more than peak fps.
- Draw calls: aim for under ~150. Triangles: aim for under ~300k visible.
- Dynamic resolution scaling and quality presets (Low / Medium / High). Auto-downgrade if frame time budget is repeatedly exceeded.
- Watch thermal throttling: sustained sessions must not degrade after 5–10 minutes. Provide a battery/thermal-friendly mode (30 fps cap is not acceptable for flight feel, so reduce resolution/effects instead).
- No GC pauses in the main loop. Profile on a real device early and often.
- Keep initial bundle small; lazy-load worlds and assets.

---

## 9. Settings, persistence, and debug tooling

- Persist settings locally (localStorage or IndexedDB): control mode, stick layout, rates profiles, camera, graphics quality, last world/seed.
- Multiple **profiles** (e.g., "My 5-inch", "Beginner", "Whoop").
- **Debug overlay:** frame time graph, physics step time, chunk gen time, draw calls/triangles, sim-rate readout, input visualization.
- **Tuning panel:** live sliders for all physics/controller parameters, export/import JSON.

---

## 10. Milestones and acceptance criteria

Do these **in order**. Do not start a milestone until the previous one meets its acceptance criteria. Commit working states at each milestone and keep a short running `README.md` and `DEVLOG.md`.

### M1 — Headless physics core
- `sim/` module: rigid body, motor model, quad-X mixer, rate controller with rate curves, Acro/Angle/Horizon.
- Node test suite: hover equilibrium, step responses, determinism (same inputs produce identical state), no NaNs under extreme inputs, zero allocation in step (verify).
- **Accept:** tests pass; step responses look sane when plotted; a scripted flight (climb, flip, recover) is stable.

### M2 — Flyable sandbox (desktop first)
- Flat ground, simple scene, FPV + chase cameras, OSD, keyboard + Gamepad input, tuning panel, debug overlay.
- Fixed-timestep loop with interpolated rendering.
- **Accept:** feels like a quad with a gamepad/radio; rates match expected Betaflight behavior when numbers are entered; stable 60 fps on desktop.

### M3 — Mobile touch and performance baseline
- Touch sticks with full settings, PWA, landscape/fullscreen, safe areas, gesture suppression.
- Test on at least one real mid-range Android and one iPhone.
- **Accept:** flyable with two thumbs; no accidental browser gestures; stable 60 fps; input latency measured and documented.

### M4 — Streaming procedural terrain
- Seeded chunked heightfield world, stylized shading, fog, floating origin, collision via `WorldQuery`.
- **Accept:** fly in one direction for 10+ minutes with no hitches, no float jitter, no memory growth; deterministic by seed.

### M5 — Game modes (first pass)
- Gate courses with timing, a few training drills, replay/ghost, telemetry view.
- **Accept:** a complete loop of pick world, fly drill, see score, replay.

### M6 — Cities
- Procedural low-poly city recipe with instancing/merging; fly-between-buildings playability.
- **Accept:** holds 60 fps on target phone; collision feels right between buildings.

### M7 — Fanciful worlds and polish
- At least two non-heightfield recipes (e.g., floating islands, tunnel forest) using the `WorldQuery` interface; sound; effects; profiles; wind option.
- **Accept:** weird worlds work without any changes to the physics module.

---

## 11. Risks and open questions

- **Touch limitation is fundamental.** Be explicit in the UI that gamepad/radio is recommended for serious practice. Consider a "skill transfer" disclaimer rather than overpromising.
- **Feel is subjective.** Plan for iteration with real FPV pilots; make all parameters exposed and shareable.
- **Browser latency differences** (iOS Safari vs. Chrome) may require per-platform input handling. Measure, don't assume.
- **Non-heightfield world meshing** (marching cubes/surface nets) can be expensive on mobile; may need Worker + aggressive chunk size/LOD tuning.
- **Physics in a Worker vs. main thread:** start on the main thread for simplicity; move to a Worker only if profiling shows it helps (watch the cost of message passing for state sync).
- **Open:** Three.js vs. a leaner custom WebGL2 renderer. Start with Three.js; revisit if bundle size or overhead becomes a problem.
- **Open:** Whether to support multiple airframes (whoop, 7" long range, cinewhoop) in v1. Recommended: no, but keep the parameter model flexible enough to add them.

---

## 12. Instructions for the implementing agent

- Follow the priority order in Section 1 and the milestone order in Section 10.
- **Physics and feel come first.** Do not build worlds or modes before M1 and M2 are solid.
- Keep `sim/` free of DOM and rendering imports. Enforce this (lint rule or import check).
- Prefer simple, measurable solutions. Profile on a real phone before optimizing blindly.
- Ask before adding heavy dependencies. Prefer small, well-justified libraries.
- Write tests for the sim core and worldgen determinism as you go.
- Document tuning parameters and their units in the code and in `README.md`.
- After each milestone, summarize what works, what doesn't, and what you'd like feedback on.
