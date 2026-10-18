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

## Next: M3 — Mobile touch and performance baseline

Touch sticks with full settings, PWA (manifest, service worker, offline), landscape and fullscreen, safe areas, gesture suppression, dynamic resolution and quality presets, and latency measurement.
