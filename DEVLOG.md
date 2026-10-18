# Dev log

## M1 — Headless physics core (done)

### What exists

- `src/sim/` is pure TypeScript with no DOM or Three.js:
  - rigid body, motor model, battery
  - quad-X mixer with airmode
  - Betaflight-style rate controller with Actual / Betaflight / Quick rates
  - Acro / Angle / Horizon modes
  - arming rules and crash detection
  - the `WorldQuery` interface
  - a fixed-step driver
- There are 42 headless tests in `src/tests/`:
  - rate curves against BF formulas
  - hover equilibrium (closed-loop result vs analytic)
  - roll/pitch/yaw step responses (rise, overshoot, settling, cross-coupling)
  - bit-exact determinism
  - NaN/garbage inputs, extreme params and 60 s of stick slamming
  - free fall and terminal velocity
  - battery sag, wind
  - arming and crash rules
  - a scripted climb → flip → recover flight
  - Angle mode recovering from inverted
  - stepper behaviour
  - params JSON merge
  - **zero allocation per tick**
  - module-boundary checks
- `npm run plots` writes SVG plots to `docs/plots/`.

### Model notes

- Motors are first-order lags, slower to spin down than up. Thrust is `kT·ω²`. Reaction torque is `kQ·ω²` plus `J_rotor·dω/dt`; the second term gives the yaw "kick" real quads have.
- The battery model is: open-circuit voltage from charge, minus `I·R` sag. Current comes from motor mechanical power and efficiency, using the previous tick's value to avoid an algebraic loop. Top motor speed scales with loaded voltage, so punch fades as the pack sags and drains.
- PID terms use Betaflight's scale constants (`PTERM_SCALE` etc.), so BF numbers mean the same thing. With the default airframe, BF default PIDs give a clean, slightly underdamped response, close to a well-tuned real 5".
- Angle mode uses the shortest rotation from the body's up vector to the target up vector. This avoids Euler singularities and recovers from inverted.

### Zero-allocation lessons (V8)

The allocation test uses `HeapProfiler.startSampling` with collected objects included. These patterns allocated, and were fixed:

1. **Passing or returning doubles through calls V8 doesn't inline** boxes them as HeapNumbers. Fix: use in/out typed arrays (`applyRateCurveInPlace`, `Mixer.apply(Float64Array)`), pass vectors instead of scalars (`integrateBodyRate(Vec3)`), and store results on fields (`FixedStepper.alpha`, `Quad.voc`).
2. **`let x;` without an initializer**, assigned a double in some branches: the variable becomes `number | undefined` and gets boxed. Fix: `let x = 0`.
3. **A ternary mixing a double with a module-level binding** (`r < -LIMIT ? -LIMIT : r`) boxes once bundlers turn `const` into `var`. Fix: use a literal.

The spec's `WorldQuery.distance()` returns a number. With a single monomorphic world it is inlined and costs nothing. A heavily polymorphic world setup may need an out-param variant later; the allocation test will catch it.

### Not done yet / deliberately deferred

- Second-order effects: propwash, ground effect and wind turbulence (only constant wind exists now). The spec says to add these after the core feels right.
- Gyro noise and motor-noise simulation.
- Altitude-hold and other beginner assists.
- Turtle mode. Crash → disarm → a switch toggle clears it.
- Sim still runs on the main thread. A Worker can come later if profiling says so.

### Feedback wanted

- **Does the default airframe feel right?** The numbers are estimates for a 650 g 6S 5" (inertia, motor time constants, drag). The best calibration would be real blackbox logs: step responses and hover throttle from a known quad.
- **Quick rates `rcRate` scaling.** I used BF's `rcRate × 200` deg/s at center. Please confirm it matches what Configurator shows.
- **Crash threshold.** 6 m/s normal impact speed disarms. That may be too forgiving or too harsh.

## M2 — Flyable sandbox, desktop first (built; needs a hands-on check)

### What exists

- **Loop** (`app.ts`): each frame polls the gamepad once, then `FixedStepper` runs whole 500 Hz ticks and samples input every tick. The renderer interpolates position (lerp) and attitude (slerp) between the last two physics states. Physics pauses while a dialog is open.
- **Input** (`input/`):
  - Keyboard virtual sticks: slew-limited, non-centering throttle.
  - Gamepad API with explicit per-channel mapping: axis, min/center/max calibration, invert. Arm and mode can be an axis switch or a button.
  - Per-stick deadzone, expo and sensitivity.
  - Calibration wizard: "throttle up, roll right, …". It detects axis index, direction and range on any device, plus the arm and mode switches.
  - Failsafes: a hidden tab disarms; window blur releases held keys.
- **World** (`world/sandbox.ts`): seeded ground plus pillars, buildings and an 8-gate loop. The first gate is straight ahead of spawn. Signed distance per box, normals by central differences, sphere-traced raycast. Rendering and collision read the same box list.
- **Render** (`render/`):
  - Gradient sky with sun, linear fog, and a procedural grid/patchwork ground shader that follows the camera.
  - All boxes in a single instanced draw call.
  - Low-poly 5" model with spinning prop discs and a blob shadow.
  - Cameras: FPV (uptilt, diagonal FOV), chase (smoothed, lag-capped) and line of sight (fixed pilot position).
- **UI** (`ui/`):
  - Betaflight-style OSD: mode, armed state, voltage and per-cell voltage, current, altitude, speed, armed timer, throttle, and warnings for throttle-high, crash and low battery.
  - Tuning panel covering every sim parameter: rates per axis with type switch and curve preview, presets, the PID table, filters, airframe, battery, crashes, wind, camera, input shaping and graphics. JSON can be shown, copied, downloaded, imported from paste or file, or reset.
  - Debug overlay: frame and physics time graph, fps, draw calls, triangles, dropped ticks, gyro vs setpoint, motor outputs, stick visualization, gamepad sample age.
  - Help screen with a clear note that a radio or gamepad is recommended.
- **Persistence**: all settings, including per-device controller mappings, are saved in localStorage. Settings are merged over defaults on load, so old or partial saves still work.

### Testing

- 63 Vitest tests. New in M2:
  - stick shaping
  - keyboard slew
  - gamepad normalization and calibration detection
  - sandbox signed distance, normals, raycast and seed determinism
  - collision with a rotated pillar
  - FOV conversion
  - rate-type conversion
  - settings merge
  - layer-boundary checks: `world/` and `input/` never import rendering or UI
- `npm run smoke` runs a headless Chromium test with software WebGL. It flies with the keyboard and then with a simulated gamepad, runs the calibration wizard against a "radio" with scrambled and reversed axes, screenshots every camera and panel, and fails on any console error. It already caught one bug: `patch` is a reserved word in GLSL.

### Performance (measured so far)

- Physics costs about 0.1–0.2 ms per frame for roughly 8 ticks.
- The scene is about 3–10 draw calls and about 2k triangles.
- The bundle is 155 kB gzipped, mostly three.js.
- **Not yet measured on a real GPU.** The headless test uses software rendering at about 15–20 fps, which says nothing about real fps. The M2 acceptance "stable 60 fps on desktop" needs checking on your machine: open the debug overlay with G.

### Input latency notes

- The browser refreshes gamepad state about once per frame, so gamepad input effectively reaches the sim once per frame. Every tick in that frame uses the newest sample. The debug overlay shows the sample age.
- Lowering latency further means decoupling physics from `requestAnimationFrame`. That's an M3 topic, to be measured before changing anything.

### Feedback wanted (M2)

- **Feel with your radio**: rates, PIDs, motor response, drag. Everything is in T → tuning, and "Copy" gives a JSON you can send back.
- **Did the calibration wizard work** with your radio's USB joystick mode? Which radio and firmware?
- **FPV defaults**: 30° uptilt and 120° diagonal FOV. Is that a good starting point?
- **Frame rate** on your desktop and browser (G overlay).

## M3 — Mobile touch and performance baseline (built; needs real-device checks)

### What exists

- **Touch sticks** (`input/touch.ts` holds the pure logic; `ui/touchControls.ts` the DOM):
  - Two zones, one per screen half, with stick modes 1–4, fixed or floating.
  - **Grabbing never jumps a stick.** The knob keeps its value and moves relative to where the thumb lands.
  - Throttle is non-centering. An optional beginner mode centers it to hover, outputs 0 while disarmed so arming works, and ramps in over 0.6 s after arming.
  - Square gate, so full diagonals work.
  - Separate deadzone, expo and sensitivity per channel for touch.
  - Adjustable size, position and opacity.
  - Pointer Events with pointer capture, one pointer per stick (extra fingers are ignored), and `pointerrawupdate` where supported. Cancel, lost capture and blur release the sticks: gimbals center, throttle holds. A hidden tab disarms.
- **On-screen buttons**: ARM/DISARM, mode, CAM, RESET, ⚙, fullscreen. They act on `pointerup`, so they work while the other thumb is down.
- **Gesture suppression**: `touch-action: none`; blocked touchmove, pinch, gesture events, context menu and double-tap; no selection or callouts. Scrollable panels keep working.
- **Display handling**: fullscreen and landscape lock happen on the first "Fly" tap. That is the only user gesture browsers accept for this; it works on Android Chrome, while iOS Safari needs Add to Home Screen. A portrait "turn your phone" prompt pauses physics. Safe areas are read from CSS `env()` and applied to the stick layout and the OSD.
- **Haptics**: vibration on arm, disarm and crash (Android only; iOS has no Vibration API).
- **PWA**:
  - Manifest with fullscreen and landscape, plus icons, including maskable and Apple.
  - A dependency-free service worker generated by a ~30-line Vite plugin. It precaches every built file, serves hashed assets cache-first and the page network-first, and drops old caches.
  - `base: './'`, so the build works from any path.
- **Performance governor** (`platform/quality.ts`):
  - Learns the display refresh rate (60/90/120 Hz) and counts missed vsyncs.
  - Lowers render scale in steps of 0.1, down to 0.5, when more than 5% of frames miss. It raises it again after about 5 s of clean frames.
  - Drops the preset (High → Medium → Low) after about 3 s of misses at minimum scale, and shows a notice.
  - Battery saver: 0.75× resolution, and every other vsync on screens above 60 Hz, which is still at least 60 fps. **Physics always runs at 500 Hz**; only rendering is traded.
- **Latency meter** (`platform/latency.ts`): first unconsumed input event timestamp → the frame whose physics consumes it. The debug overlay shows avg/p95, plus the gamepad sample age.
- **Hosting**: GitHub Actions CI (typecheck, tests, build) and a GitHub Pages deploy workflow. A phone needs HTTPS for offline mode and for `pointerrawupdate`.

### Testing

- 75 unit tests. New in M3: stick grab, release and floating behaviour, the square gate, all four modes, settings edits that must not move the sticks, the centering-throttle ramp, safe-area layout, governor vsync detection, scale-down/recover/downgrade, and the latency meter.
- `npm run smoke:mobile` emulates a landscape phone with real two-finger touch via the DevTools protocol. It checks that the ARM button works and that two thumbs fly (throttle and roll follow), that a touch cancel centers the gimbals while the throttle holds, that pinch and drag cause no page scroll or zoom, that portrait shows the prompt, that the service worker is active and the app reloads **offline**, and that there are no console errors. It caught a layering bug: the touch bar drew over dialogs.

### Latency (what we know so far)

- The input path is: touch event → stick state, which updates immediately in the event handler → read by every physics tick at the next frame → rendered in that frame. The worst case is about one frame of waiting plus the frame itself.
- **Not yet measured on real phones.** The emulated number (about 130–160 ms) comes from software rendering at about 15 fps and means nothing. `docs/DEVICE-TESTING.md` explains how to read the in-app meter and how to measure end-to-end with a slow-motion camera.

### Known limitations

- iOS Safari: no Fullscreen API on iPhone (use Add to Home Screen), no orientation lock, no vibration.
- Antialiasing can't change without a reload (WebGL context option).
- Touch shaping and gamepad shaping are separate on purpose, because touch usually wants a little deadzone and expo.

### Feedback wanted (M3)

- Run the checklist in `docs/DEVICE-TESTING.md` on your phones and send the numbers.
- Do the default stick size and position suit your thumbs? Do you prefer fixed or floating?
- Is the default touch expo (0.2) right for you?

## M4 — Streaming procedural terrain (built; needs a long real-device flight)

### What exists

- **World recipes** (`world/recipes.ts`): a recipe bundles a generator, terrain and sky palettes, and a category (Training or Playground). Pick a recipe and seed in T → World; both persist. **Rolling hills** is the new default, and the M2 sandbox is still there. Physics only ever sees `WorldQuery`. Neither the sim nor the physics params changed.
- **Terrain** (`world/terrain.ts`, `world/noise.ts`):
  - Seeded gradient-noise fBm in three layers: continents and lakes, rolling hills, and ridged mountains masked to the high ground.
  - Lakes are flat, solid water. The launch pad is flattened and kept clear of props.
  - Vertex colors: water depth, beach, two grasses, rock on steep slopes, and snow up high.
- **What you see is what you hit.** Collision uses the triangulated 2 m grid, with exactly the vertices and triangle split of the LOD 0 mesh. A test checks the mesh against collision to float32 precision. Trees (pine: cone on a trunk; broadleaf: sphere on a trunk) and boulders come from one deterministic function per 8 m cell, and rendering and collision both call it. Collision uses true signed distances to cone, sphere and capsule shapes, and every rendered prop is checked to be solid.
- **Streaming** (`world/chunks.ts`):
  - Rings of 128 m chunks: the 3×3 nearest at 2 m, then 4, 8 and 16 m spacing out to the draw distance, with 16 m of hysteresis.
  - Skirts hide cracks between chunks and LODs.
  - Generation is sliced into rows (each slice < 0.2 ms on a desktop) under a 2 ms per-frame budget. Chunks with nothing on screen go first, then the nearest.
  - The old mesh stays on screen until its replacement is ready, so nothing ever flickers.
  - Mesh buffers, chunk records and jobs are all pooled.
- **Rendering** (`render/terrainView.ts`):
  - One draw call per chunk: smooth-shaded, vertex-colored, with a shared material and per-LOD index buffers.
  - Faceted low-poly props: three instanced meshes, repacked only when the chunk set changes.
- **Smooth normals, deliberately.** I started with flat shading (derivative normals). Neighbouring chunks leave float32 hairline cracks, and the skirts filling them were lit as vertical walls, so faint dotted seams showed. Normals are now taken from a height grid with a one-vertex border, so they match exactly across chunk edges, and skirts copy the edge's normal and color. This also avoids derivative-normal noise on mobile GPUs.
- **Floating origin** (`render/origin.ts`): rendering is relative to an origin that jumps in whole chunks whenever the camera is more than 1 km away. Physics stays in doubles.
- **Cameras and OSD**:
  - The chase camera stays above the terrain.
  - The line-of-sight pilot stands on the ground behind the pad.
  - The blob shadow sits on the terrain.
  - The OSD altitude is now relative to the launch pad, like Betaflight's baro altitude zeroed at arming.
- **Debug overlay**: a world line (chunks, queue, props, gen ms per frame and peak, builds, pool size), the origin and rebase count, and world-gen time drawn in purple in the frame graph.

### Testing

- 86 unit tests. New in M4:
  - determinism by seed
  - sane terrain statistics
  - a flat, dry, clear spawn for several seeds
  - mesh = collision
  - every prop solid
  - raycasts
  - a quad resting on a slope
  - floating origin on a 50 km flight
  - a teleport not growing the pools
  - **a 12-minute flight at 40 m/s (28.8 km) in one direction**: never a missing LOD 0 chunk under the drone, pools frozen after minute 3, about 90 active chunks, work p99 2.0 ms (the budget)
- **Zero allocation over terrain**: a second allocation test skims the ground through a forest for 125k ticks.
- `npm run smoke` now also teleports 50 km out (origin rebases), streams while moving about 180 m/s, switches to the sandbox, and checks for console errors. `smoke:mobile` checks that the climb is above the pad, not above y = 0.

### Zero-allocation lessons, part 2

The prop cache refills only when the drone crosses an 8 m cell, a few times a second. Two things made that path allocate:

1. **Cold code isn't optimized.** V8 never compiled it on its own, and unoptimized code boxes every double. `TerrainWorld` now exercises it about 800 times in its constructor (a few ms) so it is compiled before the first flight.
2. **A tiny helper took a double** (`smooth01(x)`) and wasn't inlined into the refill, so every call boxed its argument. Smoothsteps on the query path are now written out inline.

Probing `distance()` in isolation showed neither problem, because the probe crossed cells hundreds of times a second. Only the realistic flight in the allocation test caught it.

### Performance (measured so far)

- Desktop Node: an LOD 0 chunk takes about 2–3 ms to build in total, and every slice is < 0.2 ms. A world builds (including the JIT warm-up) in 1–12 ms. The first full prime at spawn (about 90 chunks) takes roughly 50 ms in software-rendered Chromium.
- Bundle: 171 kB gzipped (+15 kB for M4).
- Scene, estimated for the High preset (600 m): about 90 chunks before frustum culling, about 140k terrain triangles before culling, about 1.8k props, and roughly 40–60 draw calls after culling. Low (280 m) is much less.
- **Not yet measured on a real phone.** Each slice should be under 1 ms even on a slow phone, but please check the debug overlay's `world gen … peak` and fps during a long fast flight.

### Known limitations / deferred

- Props draw out to about 450 m (ring 3) and then rely on fog. There are no impostors.
- LOD switches can pop slightly at 260–520 m. There is no geomorphing yet.
- Generation runs on the main thread. Slicing keeps it within budget; a Worker remains an option if phones show hitches.
- Water is opaque and flat-colored, with no shader yet.
- `raycast` on terrain is a conservative march (4 m steps max, then bisection). That's fine for gates and cameras; it is not used by physics.

### Feedback wanted (M4)

- **Does the terrain read well in FPV** at speed? Is it a good scale for a 5"? Trees are 5–13 m and forests have clearings.
- **Tree density** for proximity flying: too sparse or too dense?
- On a phone: the overlay's fps, `world gen` peak and draw calls on High and Low after a 10-minute flight in one direction.

## M5 — Game modes, first pass (built; needs real-pilot feedback)

### What exists

- **`game/`**: pure logic with no DOM or three.js, enforced by the layer-boundary test.
  - **Layouts** (`layouts.ts`) are fitted around the pad of any world and are deterministic per world and seed. Every placement is checked against the world's own distance field: openings, approach lines and posts must be clear of terrain, trees and rocks. If not, the gate is moved, or the whole layout is rotated in 20° steps.
  - **Runs** (`activities.ts`):
    - Gate race: 3 laps, strict gate order, best-lap ghost.
    - Slalom.
    - Figure-8.
    - Hover hold.
    - Power loop: needs a real loop, i.e. higher than the gate and inverted between the two passes.
    - Dive & recover.
    
    Each run produces a score, 1–3 stars and feedback lines. Crossings are tested on the segment between frames, and their times are interpolated.
  - **Recorder and replay** (`recorder.ts`):
    - Live, it logs 9 bytes per tick; sticks are rounded to float32 before the sim sees them, so the replay's inputs are bit-identical.
    - A replay re-simulates the recording into a 100 Hz trace: pose, velocity, sticks, gyro, setpoint, motors, battery and mode. The final state is compared with the live one, and the replay shows a warning if they differ.
    - `Quad.setArmSwitchLatched` restores the one piece of history a fresh Quad lacks: whether the arm switch was already on at reset.
  - **Ghost** (`track.ts`): the best lap's poses, stored base64 in localStorage per world and seed.
- **Gates are physical.** `world/overlay.ts` wraps any world with extra boxes. `world/boxes.ts` holds the box SDF and gate frames that the sandbox now uses too (its boxes come out identical).
- **UI**:
  - Menu (M / ☰), instructions, and a results dialog (Retry / Replay / Telemetry / Free flight).
  - Game HUD: status, hint, and a target ring or edge arrow.
  - Replay bar: restart, play/pause, 0.25–2× speed, scrub, graphs, camera, exit.
  - Telemetry panel: an 8 s window around the cursor.
  - Course view: solid frames and pylons, faint window outlines, a pulsing highlight on the next checkpoint, and the hover box (it turns green inside).
  - The ghost is drawn translucent at 2× size, so it's easy to spot.

### Testing

- 101 unit tests (+15):
  - crossing geometry
  - layouts clear of obstacles and deterministic, on both worlds
  - strict-order and direction-checked race timing
  - each drill succeeding and failing
  - replay determinism over terrain with gates, including the arm-switch-latched case
  - ghost encode/decode
- The allocation test now flies terrain + race gates with the recorder capturing every tick: still zero garbage in sim/, world/ and game/.
- `npm run smoke` runs the M5 acceptance loop in Chromium: world → menu → race → (teleported) 3 laps → results → replay with telemetry → back to results → free flight. A real keyboard flight replays bit-exactly in the browser. `smoke:mobile` checks that ☰ opens the menu.

### Bugs found along the way

- **The menu closed itself on phones.** Touch-bar buttons act on `pointerup`, and the browser's follow-up `click` landed on the backdrop of the dialog they had just opened, which closed it. This appeared once the menu got compact enough not to cover the toolbar. Dialog backdrops now close only if the press started on them (`backdropClose` in `ui/dom.ts`, used by all dialogs).
- The course highlight and ghost were first positioned after the render, a one-frame lag (and a visible jump on origin rebases). They now update before the render.

### Known limitations

- Star thresholds (average speed for courses, times for drills) are first guesses. Real pilots should tune them.
- The race layout is a fixed shape (an 8-gate loop curving right) fitted to the terrain. Varied course types (technical, flowy, dive gates) come later.
- Replays cover the flight since the last reset (up to 10 minutes) and aren't saved or shareable yet. The input log is small enough to export later.
- No split-S, proximity or precision-landing drills yet. The spec lists them, and the activity interface makes them cheap to add.
- Bundle: 186 kB gzipped (+15 kB).

### Feedback wanted (M5)

- **Do the drills teach the right things?** Are the success criteria fair? Power loop: higher than the gate + 2 m and inverted. Dive: from 40 m, starting at 12 m/s down.
- **Star thresholds**: race 6/10/14 m/s average gate-to-gate; hover 40/25/14 s; power loop 4/3/2.2 s; dive 6/3/1.5 m.
- Is the target ring and arrow useful in FPV, or distracting?
- On a phone: menu, results and replay bar readability, and fps during replay with graphs open.

## Next: M6 — Cities

Procedural low-poly city recipe with instancing/merging; fly-between-buildings playability. Acceptance: holds 60 fps on the target phone; collision feels right between buildings.
