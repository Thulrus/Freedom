/**
 * The simulated quadcopter: rigid body + motors + battery + flight controller.
 * `step(dt, rc, world)` advances one physics tick and allocates nothing.
 */
import { FlightController } from './controller';
import { clamp, Quat, RAD, rotateVec, rotateVecInverse, Vec3 } from './math';
import { Mixer } from './mixer';
import type { SimParams } from './params';
import { RcChannels } from './rc';
import type { WorldQuery } from './world';

/** Snapshot of everything the renderer / OSD / telemetry need. */
export class QuadState {
  readonly pos = new Vec3();
  readonly vel = new Vec3();
  readonly quat = new Quat();
  /** Body-frame angular velocity, rad/s. */
  readonly omega = new Vec3();
  readonly motorSpeed = new Float64Array(4);
  readonly motorCmd = new Float64Array(4);
  voltage = 0;
  current = 0;
  /** Remaining charge, 0..1. */
  charge = 1;
  armed = false;
  crashed = false;
  /** Touching the world this tick. */
  contact = false;
  time = 0;

  copy(o: QuadState): this {
    this.pos.copy(o.pos);
    this.vel.copy(o.vel);
    this.quat.copy(o.quat);
    this.omega.copy(o.omega);
    this.motorSpeed.set(o.motorSpeed);
    this.motorCmd.set(o.motorCmd);
    this.voltage = o.voltage;
    this.current = o.current;
    this.charge = o.charge;
    this.armed = o.armed;
    this.crashed = o.crashed;
    this.contact = o.contact;
    this.time = o.time;
    return this;
  }
}

export type ArmBlockReason = 'none' | 'throttle' | 'crashed' | 'switch';

export class Quad {
  readonly state = new QuadState();
  params: SimParams;
  readonly fc: FlightController;
  mixer: Mixer;
  /** Why the last arm attempt failed (for the OSD). */
  armBlock: ArmBlockReason = 'none';
  /** Whether the arm switch must be cycled before arming is allowed. */
  private needArmToggle = false;
  private prevArmSwitch = false;
  private dt: number;

  // Derived constants.
  private kT = 0;
  private kQ = 0;
  private vRef = 0;
  private omegaMax = 0;
  private aUp = 0;
  private aDown = 0;
  private frictionK = 1;
  private motorCount = 4;
  private readonly motorPos: Vec3[] = [];
  private readonly motorSpin: number[] = [];

  // Scratch (preallocated, reused every tick).
  private readonly gyroDeg = new Float64Array(3);
  private readonly rcSafe = new RcChannels();
  private readonly mixIn = new Float64Array(4);
  /** Open-circuit pack voltage for the current charge (see updateOcv). */
  private voc = 0;
  private readonly force = new Vec3();
  private readonly torque = new Vec3();
  private readonly air = new Vec3();
  private readonly normal = new Vec3();
  private readonly world2 = new Vec3();

  constructor(params: SimParams, dt = 1 / 500) {
    this.params = params;
    this.dt = dt;
    this.fc = new FlightController(params.controller, dt);
    this.mixer = new Mixer(params.quad.motors);
    this.applyParams();
    this.reset();
  }

  get timestep(): number {
    return this.dt;
  }

  /** Recompute derived constants after editing params (safe mid-flight). */
  applyParams(params: SimParams = this.params, dt: number = this.dt): void {
    this.params = params;
    this.dt = dt;
    const q = params.quad;
    this.omegaMax = q.maxMotorSpeed;
    this.kT = q.maxThrustPerMotor / (q.maxMotorSpeed * q.maxMotorSpeed);
    this.kQ = this.kT * q.torqueToThrust;
    this.vRef = q.battery.cells * 4.2;
    this.aUp = 1 - Math.exp(-dt / Math.max(q.motorTauUp, 1e-4));
    this.aDown = 1 - Math.exp(-dt / Math.max(q.motorTauDown, 1e-4));
    this.frictionK = Math.exp(-q.collision.friction * dt);
    this.motorCount = Math.min(q.motors.length, 4);
    this.motorPos.length = 0;
    this.motorSpin.length = 0;
    for (let i = 0; i < this.motorCount; i++) {
      const m = q.motors[i];
      this.motorPos.push(new Vec3(m.pos[0], m.pos[1], m.pos[2]));
      this.motorSpin.push(m.spin);
    }
    this.mixer = new Mixer(q.motors.slice(0, this.motorCount));
    this.fc.configure(params.controller, dt);
  }

  /** Place the quad at rest, disarmed, level, facing yaw (radians, 0 = -Z). */
  reset(x = 0, y = 0, z = 0, yaw = 0): void {
    const s = this.state;
    const r = this.params.quad.collision.radius;
    s.pos.set(x, y + r, z);
    s.vel.set(0, 0, 0);
    s.quat.setFromAxisAngle(0, 1, 0, yaw);
    s.omega.set(0, 0, 0);
    s.motorSpeed.fill(0);
    s.motorCmd.fill(0);
    s.charge = this.params.quad.battery.startCharge;
    s.voltage = this.openCircuitVoltage(s.charge);
    s.current = 0;
    s.armed = false;
    s.crashed = false;
    s.contact = false;
    s.time = 0;
    this.armBlock = 'none';
    this.needArmToggle = this.prevArmSwitch;
    this.fc.reset();
  }

  /** Whether the arm switch must be cycled before arming (set by reset() if it was on). */
  get armSwitchLatched(): boolean {
    return this.needArmToggle;
  }

  /**
   * Restore the arm-switch history after reset() (deterministic replays):
   * a fresh Quad doesn't know the switch was already on.
   */
  setArmSwitchLatched(on: boolean): void {
    this.prevArmSwitch = on;
    this.needArmToggle = on;
  }

  /** Pack open-circuit voltage from state of charge (simple LiPo curve). */
  openCircuitVoltage(charge: number): number {
    const saved = this.state.charge;
    this.state.charge = charge;
    this.updateOcv();
    this.state.charge = saved;
    return this.voc;
  }

  private updateOcv(): void {
    const b = this.params.quad.battery;
    const c = clamp(this.state.charge, 0, 1);
    // 3.3 V/cell empty, ~3.75 V plateau, 4.2 V full.
    const perCell = 3.3 + 0.9 * c - 0.55 * c * (1 - c) * (1 - c) + 0.35 * c * c * (1 - c);
    this.voc = perCell * b.cells;
  }

  step(rcIn: RcChannels, world: WorldQuery): void {
    const rc = sanitizeRc(rcIn, this.rcSafe);
    const dt = this.dt;
    const s = this.state;
    const P = this.params;
    const q = P.quad;

    // --- Arming ---------------------------------------------------------
    const armEdge = rc.arm && !this.prevArmSwitch;
    if (!rc.arm) {
      s.armed = false;
      this.needArmToggle = false;
      this.armBlock = 'none';
    } else if (!s.armed && armEdge) {
      if (this.needArmToggle) this.armBlock = 'switch';
      else if (s.crashed) this.armBlock = 'crashed';
      else if (rc.throttle > 0.05) this.armBlock = 'throttle';
      else {
        s.armed = true;
        this.armBlock = 'none';
      }
    }
    this.prevArmSwitch = rc.arm;
    if (s.armed && s.crashed) s.armed = false;
    if (!rc.arm) s.crashed = false; // disarming clears the crash flag

    // --- Sensors + flight controller ------------------------------------
    // Body rates -> pilot convention (roll=-wz, pitch=-wx, yaw=-wy), deg/s.
    this.gyroDeg[0] = -s.omega.z * RAD;
    this.gyroDeg[1] = -s.omega.x * RAD;
    this.gyroDeg[2] = -s.omega.y * RAD;
    const fc = this.fc;
    fc.update(rc, this.gyroDeg, s.quat, s.armed, this.mixer.saturated);

    const n = this.motorCount;
    if (s.armed) {
      const mi = this.mixIn;
      mi[0] = fc.output[0];
      mi[1] = fc.output[1];
      mi[2] = fc.output[2];
      mi[3] = fc.throttle;
      this.mixer.apply(mi, P.controller.airmode, s.motorCmd);
      const idle = P.controller.motorIdle;
      for (let i = 0; i < n; i++) s.motorCmd[i] = idle + (1 - idle) * s.motorCmd[i];
    } else {
      this.mixer.saturated = false;
      for (let i = 0; i < n; i++) s.motorCmd[i] = 0;
    }

    // --- Battery voltage (uses last tick's current) ---------------------
    let vScale = 1;
    if (q.battery.enabled) {
      this.updateOcv();
      s.voltage = Math.max(0, this.voc - s.current * q.battery.internalResistance);
      vScale = s.voltage / this.vRef;
    } else {
      s.voltage = this.vRef;
    }

    // --- Motors ---------------------------------------------------------
    const force = this.force.set(0, 0, 0);
    const torque = this.torque.set(0, 0, 0);
    let mechPower = 0;
    const omegaTop = this.omegaMax * vScale;
    for (let i = 0; i < n; i++) {
      const target = s.motorCmd[i] * omegaTop;
      const w0 = s.motorSpeed[i];
      const w = w0 + (target - w0) * (target > w0 ? this.aUp : this.aDown);
      s.motorSpeed[i] = w;
      const thrust = this.kT * w * w;
      const drag = this.kQ * w * w;
      mechPower += drag * w;
      // Thrust along body +Y at motor position: torque = r x (0, T, 0).
      const r = this.motorPos[i];
      force.y += thrust;
      torque.x += -r.z * thrust;
      torque.z += r.x * thrust;
      // Prop drag + spin-up reaction on the frame, opposite to prop spin.
      const accel = (w - w0) / dt;
      torque.y -= this.motorSpin[i] * (drag + q.rotorInertia * accel);
    }
    if (q.battery.enabled) {
      const v = Math.max(s.voltage, 1);
      s.current = mechPower / (v * q.motorEfficiency);
      s.charge = Math.max(0, s.charge - (s.current * dt) / (q.battery.capacityMah * 3.6));
    } else {
      s.current = 0;
    }

    // --- Aerodynamic drag (body frame, relative to air) -----------------
    const w = P.env.wind;
    const air = rotateVecInverse(s.quat, this.air.set(s.vel.x - w[0], s.vel.y - w[1], s.vel.z - w[2]), this.air);
    const dl = q.dragLinear, dq = q.dragQuadratic;
    force.x -= dl[0] * air.x + dq[0] * Math.abs(air.x) * air.x;
    force.y -= dl[1] * air.y + dq[1] * Math.abs(air.y) * air.y;
    force.z -= dl[2] * air.z + dq[2] * Math.abs(air.z) * air.z;

    const om = s.omega;
    const ad = q.angularDamping;
    torque.x -= ad[0] * om.x;
    torque.y -= ad[1] * om.y;
    torque.z -= ad[2] * om.z;

    // --- Integrate (semi-implicit Euler, exact rotation update) ---------
    const fw = rotateVec(s.quat, force, this.world2);
    const invM = 1 / q.mass;
    s.vel.x += fw.x * invM * dt;
    s.vel.y += (fw.y * invM - P.env.gravity) * dt;
    s.vel.z += fw.z * invM * dt;
    s.pos.addScaled(s.vel, dt);

    // Euler's rotation equation: I*dw/dt = tau - w x (I*w).
    const I = q.inertia;
    const Iwx = I[0] * om.x, Iwy = I[1] * om.y, Iwz = I[2] * om.z;
    const gx = om.y * Iwz - om.z * Iwy;
    const gy = om.z * Iwx - om.x * Iwz;
    const gz = om.x * Iwy - om.y * Iwx;
    om.x += ((torque.x - gx) / I[0]) * dt;
    om.y += ((torque.y - gy) / I[1]) * dt;
    om.z += ((torque.z - gz) / I[2]) * dt;
    // Hard safety clamp (~11,000 deg/s) so pathological params can't explode.
    const OM_MAX = 200;
    om.x = clamp(om.x, -OM_MAX, OM_MAX);
    om.y = clamp(om.y, -OM_MAX, OM_MAX);
    om.z = clamp(om.z, -OM_MAX, OM_MAX);
    s.quat.integrateBodyRate(om, dt);

    // --- Collision (sphere vs. world signed distance) -------------------
    this.collide(world);

    s.time += dt;
  }

  private collide(world: WorldQuery): void {
    const s = this.state;
    const c = this.params.quad.collision;
    const d = world.distance(s.pos);
    s.contact = false;
    if (!(d < c.radius)) return;
    s.contact = true;
    // Scalar math on purpose: helper calls returning doubles can allocate in V8.
    const n = world.normal(s.pos, this.normal);
    const nx = n.x, ny = n.y, nz = n.z;
    const pen = c.radius - d;
    s.pos.x += nx * pen;
    s.pos.y += ny * pen;
    s.pos.z += nz * pen;
    const v = s.vel;
    const vn = v.x * nx + v.y * ny + v.z * nz;
    let vnOut = vn;
    if (vn < 0) {
      if (-vn > c.crashSpeed && s.armed && c.disarmOnCrash) {
        s.crashed = true;
        s.armed = false;
      }
      vnOut = -c.restitution * vn;
    }
    // Tangential friction: v = n * vnOut + (v - n * vn) * k.
    const k = this.frictionK;
    v.x = nx * vnOut + (v.x - nx * vn) * k;
    v.y = ny * vnOut + (v.y - ny * vn) * k;
    v.z = nz * vnOut + (v.z - nz * vn) * k;
    // Spin damping from scraping.
    s.omega.x *= k;
    s.omega.y *= k;
    s.omega.z *= k;
  }
}

/** Clamp sticks to range and turn NaN into a safe value (centered / throttle 0). */
function sanitizeRc(src: RcChannels, out: RcChannels): RcChannels {
  out.throttle = src.throttle >= 0 ? (src.throttle <= 1 ? src.throttle : 1) : 0;
  out.roll = src.roll >= -1 ? (src.roll <= 1 ? src.roll : 1) : src.roll < -1 ? -1 : 0;
  out.pitch = src.pitch >= -1 ? (src.pitch <= 1 ? src.pitch : 1) : src.pitch < -1 ? -1 : 0;
  out.yaw = src.yaw >= -1 ? (src.yaw <= 1 ? src.yaw : 1) : src.yaw < -1 ? -1 : 0;
  out.arm = src.arm === true;
  out.mode = src.mode === 'angle' || src.mode === 'horizon' ? src.mode : 'acro';
  return out;
}
