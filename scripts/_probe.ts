import { defaultSimParams, FixedStepper, Quad, RcChannels } from '../src/sim';
import { buildWorld } from '../src/world/recipes';
const world = buildWorld('city', 2);
const p = defaultSimParams(); p.quad.collision.disarmOnCrash = false;
const quad = new Quad(p, 1 / 500);
quad.reset(0, 2, -40, 0);
const rc0 = new RcChannels(); rc0.arm = true; quad.step(rc0, world);
let t = 0;
const st = new FixedStepper(quad, world, (r) => { t++; r.arm = true; r.mode = 'angle'; r.throttle = 0.36 + 0.08 * Math.sin(t * 0.003); r.pitch = 0.7; r.roll = 0.5 * Math.sin(t * 0.0009); r.yaw = 0.15 * Math.sin(t * 0.0005); });
for (let i = 0; i < 25000; i++) { st.advance(1 / 60); if (i % 2500 === 0) console.log('FRAME', i, quad.state.pos.x.toFixed(0), quad.state.pos.y.toFixed(1), quad.state.pos.z.toFixed(0), quad.state.contact); }
