/** M2 sandbox world: procedural grid ground that follows the drone, and all boxes in one instanced draw call. */
import * as THREE from 'three';
import type { SandboxWorld } from '../world/sandbox';
import type { FloatingOrigin } from './origin';
import type { WorldView } from './worldView';

const GROUND = {
  base: new THREE.Color(0x7fa86a),
  alt: new THREE.Color(0x8db474),
  minor: new THREE.Color(0x5f8a52),
  major: new THREE.Color(0xe9f0d8),
};

export class SandboxView implements WorldView {
  readonly object = new THREE.Group();
  private readonly ground: THREE.Mesh;
  private readonly boxes: THREE.InstancedMesh;
  private readonly originUniform = { value: new THREE.Vector2() };

  constructor(world: SandboxWorld) {
    this.ground = makeGround(this.originUniform);
    this.boxes = makeBoxes(world);
    this.object.add(this.ground, this.boxes);
  }

  update(focusX: number, focusZ: number, origin: FloatingOrigin): void {
    // Snap to the major grid so the pattern doesn't swim; the shader adds the origin back.
    this.ground.position.set(Math.round(focusX / 100) * 100 - origin.x, 0, Math.round(focusZ / 100) * 100 - origin.z);
    this.originUniform.value.set(origin.x, origin.z);
    this.boxes.position.set(-origin.x, 0, -origin.z);
  }

  setDrawDistance(): void {}

  status(): string {
    return `sandbox · ${this.boxes.count} boxes`;
  }

  dispose(): void {
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.boxes.geometry.dispose();
    (this.boxes.material as THREE.Material).dispose();
    this.boxes.dispose();
  }
}

function makeGround(origin: { value: THREE.Vector2 }): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uBase: { value: GROUND.base },
        uAlt: { value: GROUND.alt },
        uMinor: { value: GROUND.minor },
        uMajor: { value: GROUND.major },
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
      uniform vec2 uOrigin;
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
        vec2 p = vWorld.xz + uOrigin;
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
  mat.uniforms.uOrigin = origin;
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
  const up = new THREE.Vector3(0, 1, 0);
  world.boxes.forEach((b, i) => {
    q.setFromAxisAngle(up, b.yaw);
    m.compose(pos.set(b.cx, b.cy, b.cz), q, scale.set(b.hx * 2, b.hy * 2, b.hz * 2));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, color.setHex(b.color));
  });
  mesh.computeBoundingSphere();
  return mesh;
}
