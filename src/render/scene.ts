/**
 * Stylized scene: gradient sky, linear fog, lights, and the current world's
 * view (sandbox or streaming terrain). Everything is drawn relative to the
 * floating origin.
 */
import * as THREE from 'three';
import { RECIPES, type GameWorld } from '../world/recipes';
import type { FloatingOrigin } from './origin';
import { createWorldView, type WorldView } from './worldView';

const SUN_DIR = new THREE.Vector3(-0.4, 0.55, -0.7).normalize();

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private readonly sky: THREE.Mesh;
  private readonly skyUniforms: { uZenith: { value: THREE.Color }; uHorizon: { value: THREE.Color }; uSun: { value: THREE.Color } };
  private readonly fogColor = new THREE.Color();
  private view: WorldView | null = null;
  private drawDistance = 600;

  constructor(canvas: HTMLCanvasElement, opts: { antialias: boolean }) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: opts.antialias, powerPreference: 'high-performance' });
    this.renderer.info.autoReset = false; // we reset per frame so the debug overlay sees totals
    this.scene.fog = new THREE.Fog(this.fogColor, 80, 600);
    this.scene.background = this.fogColor;

    this.scene.add(new THREE.HemisphereLight(0xe4eeff, 0x6f7f5c, 3.2));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
    sun.position.copy(SUN_DIR);
    this.scene.add(sun);

    this.skyUniforms = { uZenith: { value: new THREE.Color() }, uHorizon: { value: this.fogColor }, uSun: { value: new THREE.Color() } };
    this.sky = makeSky(this.skyUniforms);
    this.scene.add(this.sky);
  }

  /** Swap in the renderer for a new world (disposes the old one). */
  setWorld(world: GameWorld): void {
    if (this.view) {
      this.scene.remove(this.view.object);
      this.view.dispose();
    }
    const sky = RECIPES[world.id].sky;
    this.skyUniforms.uZenith.value.setHex(sky.zenith);
    this.skyUniforms.uSun.value.setHex(sky.sun);
    this.fogColor.setHex(sky.horizon);
    (this.scene.fog as THREE.Fog).color = this.fogColor;
    this.view = createWorldView(world);
    this.view.setDrawDistance(this.drawDistance);
    this.scene.add(this.view.object);
  }

  /** Fog end, camera far plane and world streaming radius follow the quality preset's draw distance. */
  setDrawDistance(d: number, camera: THREE.PerspectiveCamera): void {
    this.drawDistance = d;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = d * 0.13;
    fog.far = d;
    camera.far = d * 1.5;
    camera.updateProjectionMatrix();
    this.view?.setDrawDistance(d);
  }

  /** Stream the world around the focus (world coordinates) within budgetMs. */
  update(focusX: number, focusZ: number, origin: FloatingOrigin, budgetMs: number): void {
    this.view?.update(focusX, focusZ, origin, budgetMs);
  }

  /** Build everything around the focus right away (world load, reset). */
  prime(focusX: number, focusZ: number, origin: FloatingOrigin): void {
    this.view?.prime?.(focusX, focusZ, origin);
  }

  get worldStatus(): string {
    return this.view?.status() ?? '';
  }

  render(camera: THREE.Camera): void {
    this.sky.position.copy(camera.position);
    this.renderer.info.reset();
    this.renderer.render(this.scene, camera);
  }
}

function makeSky(uniforms: Record<string, { value: unknown }>): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { ...uniforms, uSunDir: { value: SUN_DIR } },
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
