# Freedom FPV

A browser FPV drone simulator, mobile-first, for practicing real acro flying. It uses procedurally generated worlds. It is static files only, with no backend. The full spec is in [`docs/SPEC.md`](docs/SPEC.md).

**Status: Milestone 1 (headless physics core) is complete.** There is no renderer yet. See [`DEVLOG.md`](DEVLOG.md) for progress and open questions.

## Quick start

```bash
npm install
npm test          # headless sim test suite (Vitest, Node)
npm run typecheck # whole project + sim/ checked with NO DOM types
npm run plots     # writes step-response plots to docs/plots/*.svg
npm run dev       # Vite dev server (M1: placeholder page that runs the sim)
```

## Layout

```
src/
  sim/      PURE TypeScript physics + flight controller. No DOM, no Three.js.
  tests/    Headless tests (hover, step response, determinism, allocation, ...)
  main.ts   Placeholder entry (M2 replaces it with the real app)
scripts/    Dev tools (plot generation)
docs/       Spec and generated plots
```

These directories are added in later milestones: `input/`, `world/`, `render/`, `game/`, `ui/`, `platform/`.

The `sim/` boundary is enforced in two ways. `tsconfig.sim.json` type-checks it without DOM libs. `src/tests/boundaries.test.ts` fails if it imports anything outside `sim/`, or if it uses browser globals or nondeterministic sources such as `Math.random` and `Date.now`.

## How the sim works

```
input → RcChannels (sampled every physics tick) → Quad.step(dt) → QuadState → render interpolates prev/curr
```

- **`FixedStepper`** runs whole ticks at 500 Hz by default. Pass a different `dt` to `Quad` for up to 1 kHz. It uses an accumulator with a max-substeps clamp. It calls your `InputSampler` once per tick and exposes `prev`, `curr` and `alpha` for interpolation.
- **`Quad`** combines a rigid body, motors, a battery and a flight controller. Orientation is a quaternion, integrated with the exact exponential map. Translation uses semi-implicit Euler.
- **`FlightController`** is Betaflight-style:
  - Rate curves feed setpoint smoothing.
  - PID + feedforward then works on angular rate, with D on measurement, I-term relax and anti-windup.
  - Angle and Horizon modes add self-leveling. It uses the shortest rotation, so Angle mode also recovers from inverted.
- **`Mixer`** derives quad-X factors from motor geometry and desaturates in airmode style, like BF `mixer.c`.
- **`WorldQuery`** is the only thing the physics knows about the world: signed `distance()`, `normal()` and optional `raycast()`. Collision is a sphere against that distance.
- **Zero allocation per tick**, verified with V8's sampling heap profiler (`alloc.test.ts`).
- **Deterministic**: the same params and inputs give a bit-identical trajectory.

### Conventions

- World: right-handed, **+Y up**, matching Three.js. Body: **+X right, +Y up (thrust), −Z forward**.
- `RcChannels`: `throttle` is 0..1. `roll`, `pitch` and `yaw` are −1..1. Positive means stick right or stick forward: roll right, nose down, yaw right.
- Motor order is Betaflight's: 1 rear-right, 2 front-right, 3 rear-left, 4 front-left. Spin directions are "props in".

## Tuning parameters

All params are plain JSON (`SimParams = { quad, controller, env }`). They can be exported with `JSON.stringify` and imported with `mergeParams(defaults, json)`, which ignores unknown or invalid fields. After editing params live, call `quad.applyParams(params)`.

### Rates (`controller.rates.{roll,pitch,yaw}`): enter your Betaflight numbers

| type | fields | example (BF Configurator) |
|---|---|---|
| `actual` (BF default) | `center` deg/s, `max` deg/s, `expo` 0..1 | 70 / 670 / 0 |
| `betaflight` | `rcRate`, `superRate` 0..0.99, `expo` 0..1 | 1.00 / 0.70 / 0.00 |
| `quick` | `rcRate` (×200 deg/s at center), `max` deg/s, `expo` | 1.00 / 670 / 0 |

Presets in `RATE_PRESETS`: `beginner`, `betaflightDefault`, `freestyle`, `racing`, `classic`.

### Controller (`controller`)

| param | unit | default | notes |
|---|---|---|---|
| `pid.{roll,pitch,yaw}.{p,i,d,ff}` | BF units | 45/80/40/120, 47/84/46/125, 45/80/0/120 | Scaled with BF's own constants |
| `throttleMid`, `throttleExpo` | 0..1 | 0.5, 0 | BF `thr_mid` / `thr_expo` |
| `airmode` | bool | true | |
| `airmodeStartThrottle` | 0..1 | 0.25 | I-term enables after this |
| `itermLimit` | BF units | 400 | |
| `itermRelaxThreshold` | deg/s | 40 | 0 disables |
| `pidSumLimit`, `pidSumLimitYaw` | BF units | 500, 400 | |
| `gyroLpfHz`, `dtermLpfHz` | Hz | 250, 100 | PT1; 0 disables |
| `rcSmoothingHz` | Hz | 40 | PT2 on setpoint |
| `ffSmoothingHz` | Hz | 25 | PT1 on feedforward |
| `motorIdle` | 0..1 | 0.055 | BF `dshot_idle_value` |
| `angleLimit` | deg | 60 | Angle/Horizon max tilt |
| `angleStrength`, `horizonStrength` | BF units (÷10 = deg/s per deg) | 50, 50 | |
| `horizonTransition` | stick 0..1 | 0.75 | Self-level fades out by here |

### Airframe (`quad`): default is a 5" 6S freestyle quad

| param | unit | default |
|---|---|---|
| `mass` | kg | 0.65 |
| `inertia` [pitch, yaw, roll axes] | kg·m² | 0.0019, 0.003, 0.0016 |
| `motors[].pos`, `motors[].spin` | m, ±1 | quad-X, 113 mm arms |
| `maxThrustPerMotor` | N (full battery) | 13.0 (TWR ≈ 8.2) |
| `torqueToThrust` | m | 0.016 |
| `maxMotorSpeed` | rad/s | 3500 |
| `rotorInertia` | kg·m² | 2.5e-6 |
| `motorTauUp`, `motorTauDown` | s | 0.022, 0.04 |
| `motorEfficiency` | 0..1 | 0.8 |
| `dragLinear` [x,y,z body] | N/(m/s) | 0.2, 0.12, 0.2 |
| `dragQuadratic` [x,y,z body] | N/(m/s)² | 0.009, 0.016, 0.007 |
| `angularDamping` | N·m/(rad/s) | 0.0004, 0.0006, 0.0004 |
| `battery.{enabled,cells,capacityMah,internalResistance,startCharge}` | –, –, mAh, Ω, 0..1 | true, 6, 1300, 0.025, 1 |
| `collision.{radius,restitution,friction,crashSpeed,disarmOnCrash}` | m, –, 1/s, m/s, – | 0.12, 0.2, 6, 6, true |

### Environment (`env`)

| param | unit | default | notes |
|---|---|---|---|
| `gravity` | m/s² | 9.81 | Training worlds always use 9.81 |
| `wind` | m/s (world) | 0,0,0 | Constant wind. Gusts come later |

## Current numbers (default 5", from `npm run plots`)

| check | result |
|---|---|
| Hover throttle | ~31% |
| Roll / pitch step (half stick → 185°/s) | 90% rise in 30 / 32 ms, 10% / 7% overshoot |
| Yaw step | 90% rise in 66 ms, 12% overshoot |
| Full-stick roll | 670°/s reached in < 100 ms; 360° flip in ~0.6 s |
| Flat free-fall terminal velocity | ~16.6 m/s |
