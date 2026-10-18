/**
 * Stylized scene: gradient sky, linear fog, procedural grid ground that
 * follows the camera, and the world's boxes in one instanced draw call.
 */
import * as THREE from 'three';
import type { SandboxWorld } from '../world/sandbox';

export const PALETTE = {
  zenith: new THREE.Color(0x3d6fb6),
  horizon: new THREE.Color(0xbfd6e6),
  sun: new THREE.Color(0xfff1c9),
  ground: new THREE.Color(0x7fa86a),
  groundAlt: new THREE.Color(0x8db474),
  gridMinor: new THREE.Color(0x5f8a52),
  gridMajor: new THREE.Color(0xe9f0d8),
};

const SUN_DIR = new THREE.Vector3(-0.4, 0.55, -0.7).normalize();

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private readonly ground: THREE.Mesh;
  private readonly sky: THREE.Mesh;

  constructor(canvas: HTMLCanvasElement, world: SandboxWorld, opts: { antialias: boolean }) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: opts.antialias, powerPreference: 'high-performance' });
    this.renderer.info.autoReset = false; // we reset per frame so the debug overlay sees totals
    this.scene.fog = new THREE.Fog(PALETTE.horizon, 80, 600);
    this.scene.background = PALETTE.horizon;

    this.scene.add(new THREE.HemisphereLight(0xe4eeff, 0x6f7f5c, 3.2));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
    sun.position.copy(SUN_DIR);
    this.scene.add(sun);

    this.sky = makeSky();
    this.scene.add(this.sky);
    this.ground = makeGround();
    this.scene.add(this.ground);
    this.scene.add(makeBoxes(world));
  }

  /** Keep ground and sky centered on the camera (they are effectively infinite). */
  follow(camera: THREE.Camera): void {
    const p = camera.position;
    // Snap to the major grid so the pattern doesn't swim.
    this.ground.position.set(Math.round(p.x / 100) * 100, 0, Math.round(p.z / 100) * 100);
    this.sky.position.copy(p);
  }

  render(camera: THREE.Camera): void {
    this.follow(camera);
    this.renderer.info.reset();
    this.renderer.render(this.scene, camera);
  }
}

function makeSky(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: PALETTE.zenith },
      uHorizon: { value: PALETTE.horizon },
      uSun: { value: PALETTE.sun },
      uSunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // always at the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uHorizon, uSun, uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 c = mix(uHorizon, uZenith, pow(h, 0.55));
        float s = max(dot(d, uSunDir), 0.0);
        c += uSun * (smoothstep(0.9994, 0.9997, s) * 1.2 + pow(s, 32.0) * 0.25);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

function makeGround(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uBase: { value: PALETTE.ground },
        uAlt: { value: PALETTE.groundAlt },
        uMinor: { value: PALETTE.gridMinor },
        uMajor: { value: PALETTE.gridMajor },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 uBase, uAlt, uMinor, uMajor;
      varying vec3 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float grid(vec2 p, float spacing, float width) {
        vec2 q = p / spacing;
        vec2 fw = fwidth(q);
        vec2 g = abs(fract(q - 0.5) - 0.5) / max(fw, 1e-4);
        float line = 1.0 - min(min(g.x, g.y) / width, 1.0);
        // Fade lines out where they get denser than a pixel (no moire).
        return line * (1.0 - smoothstep(0.15, 0.6, max(fw.x, fw.y)));
      }
      void main() {
        vec2 p = vWorld.xz;
        // Large field patches for a stylized patchwork look.
        float field = hash(floor(p / 40.0));
        vec3 c = mix(uBase, uAlt, step(0.5, field) * 0.8 + field * 0.2);
        c = mix(c, uMinor, grid(p, 2.0, 1.0) * 0.5);
        c = mix(c, uMajor, grid(p, 20.0, 1.4) * 0.55);
        // Launch pad ring at the origin.
        float r = length(p);
        c = mix(c, vec3(0.95, 0.95, 0.9), (1.0 - smoothstep(0.05, 0.12, abs(r - 1.6))) * 0.9);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const geo = new THREE.PlaneGeometry(2400, 2400);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

function makeBoxes(world: SandboxWorld): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, world.boxes.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  world.boxes.forEach((b, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
    m.compose(pos.set(b.cx, b.cy, b.cz), q, scale.set(b.hx * 2, b.hy * 2, b.hz * 2));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, color.setHex(b.color));
  });
  mesh.computeBoundingSphere();
  return mesh;
}
