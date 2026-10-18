# Freedom FPV

**Fly it in your browser: https://thulrus.github.io/Freedom/** (desktop or phone; on a phone, add it to your home screen for full-screen offline play).

A browser FPV drone simulator, mobile-first, for practicing real acro flying. It uses procedurally generated worlds. It is static files only, with no backend. The full spec is in [`docs/SPEC.md`](docs/SPEC.md).

**Status: Milestone 3 (mobile touch + performance baseline) is built.** It still needs checking on a real Android phone and an iPhone; see [`docs/DEVICE-TESTING.md`](docs/DEVICE-TESTING.md). M2 still needs a hands-on check with a real radio or gamepad. You can fly with a keyboard, a gamepad, or a radio in USB joystick mode. Touch controls and the PWA come in M3. See [`DEVLOG.md`](DEVLOG.md) for progress and open questions.

## Quick start

```bash
npm install
npm run dev       # open the printed URL and fly
npm test          # headless test suite (Vitest, Node)
npm run typecheck # whole project + sim/ checked with NO DOM types
npm run smoke     # build + headless-browser flight test, screenshots in smoke-out/
npm run smoke:mobile  # emulated phone: two-thumb touch flight, gestures, portrait, offline
npm run plots     # writes step-response plots to docs/plots/*.svg
```

## Flying

Press **H** in the app for the full list of controls.

| key | action |
|---|---|
| Space | arm / disarm (throttle must be low) |
| W / S | throttle up / down (non-centering) |
| A / D | yaw |
| Arrows | pitch / roll |
| 1 / 2 / 3 | Acro / Angle / Horizon |
| C | camera: FPV → chase → line of sight |
| R | reset to launch pad |
| T / G / O | tuning panel / debug overlay / OSD |

**Touch** (phones and tablets): the left thumb controls throttle and yaw, the right thumb pitch and roll, in Mode 2. Modes 1, 3 and 4 are in ⚙ → Touch sticks. Your thumb can land anywhere on its half of the screen and the stick never jumps. Throttle stays where you leave it; a self-centering "release = hover" option exists for beginners. Use the on-screen ARM, mode, CAM and RESET buttons. Touch sticks are only an approximation: plug in a radio or gamepad for practice that transfers to a real quad.

**Install as an app**: on Android choose "Install app"; on iPhone use Share → Add to Home Screen. It runs full-screen in landscape and works offline.

**Gamepad** (standard layout, Mode 2): left stick is throttle/yaw and right stick is pitch/roll. Start arms, Y cycles the mode, Back resets and LB changes the camera.

**Radio transmitter**: set the model to USB Joystick mode. Then open **T → Controls → Set up controller / radio…** and run the calibration wizard. It detects each axis, its direction and range, and your arm and mode switches. The mapping is saved per device.

Keyboard flight is for testing only. Use a radio or gamepad for real practice.

## Layout

```
src/
  sim/       PURE TypeScript physics + flight controller. No DOM, no Three.js.
  input/     Keyboard, Gamepad API (gamepads + radios), stick shaping -> RcChannels
  world/     Worlds as WorldQuery (M2: sandbox with ground, pillars, buildings, gates)
  render/    Three.js scene, drone model, FPV/chase/LOS camera rig
  ui/        OSD, tuning panel, debug overlay, controller setup, help
  platform/  Storage, frame stats, dynamic resolution, latency meter, fullscreen/orientation, PWA
  app.ts     Wires the loop: input -> fixed-step sim -> interpolated render
  settings.ts  Persisted app settings (sim params, camera, input, graphics)
  tests/     Headless tests
scripts/     plots, browser smoke test
docs/        Spec and generated plots
```

`game/` gets added in M5.

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
- **`WorldQuery`** is the only thing the physics knows about the world: signed `distance()`, `normal()` and optional `raycast()`. Collision is a sphere against that distance. The M2 sandbox uses the same box list for rendering and collision, so what you see is what you hit.
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

### App settings (camera, input, graphics)

These are saved in localStorage under `freedom.settings` and edited in the tuning panel.

| setting | unit | default |
|---|---|---|
| `camera.fpvTilt` | deg | 30 |
| `camera.fpvFov` | deg, screen diagonal | 120 |
| `camera.chaseDistance`, `chaseHeight` | m | 2.2, 0.7 |
| `camera.losFov` | deg, vertical | 50 |
| `input.shaping.{roll,pitch,yaw,throttle}.{deadzone,expo,sensitivity}` | 0..1 | 0.02 / 0 / 1 (throttle: no deadzone) |
| `input.keyboardStickSpeed`, `keyboardThrottleSpeed` | full travel / s | 5, 0.6 |
| `graphics.quality` | low / medium / high | high (pixel ratio 1 / 1.5 / 2, draw distance 280 / 420 / 600 m) |
| `graphics.dynamicResolution`, `autoDowngrade` | bool | true, true |
| `graphics.batterySaver` | bool | false (×0.75 resolution, max 60 fps on 90/120 Hz screens; physics unchanged) |
| `graphics.maxPixelRatio` | × | 2 |
| `touch.mode` | 1–4 | 2 |
| `touch.floating`, `throttleCentering`, `haptics` | bool | false, false, true |
| `touch.size` / `insetX` / `insetY` | fraction of screen | 0.2 / 0.16 / 0.3 |
| `touch.opacity` | 0..1 | 0.55 |
| `touch.shaping.{roll,pitch,yaw,throttle}` | deadzone / expo / sensitivity | 0.03 / 0.2 / 1 (yaw deadzone 0.05; throttle none) |

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
