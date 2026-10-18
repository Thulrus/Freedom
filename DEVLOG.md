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

## Next: M2 — Flyable sandbox (desktop first)

Planned:
- Three.js scene with a flat ground grid, FPV and chase cameras, and an OSD.
- Keyboard and Gamepad input.
- A tuning panel bound to `SimParams`, with JSON import/export.
- A debug overlay.

Three.js is the one new runtime dependency the spec already approves.
