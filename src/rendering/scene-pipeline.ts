import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { LightingLook } from "./archive-lighting";

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/**
 * How far into the fog each pixel lies (M_ArchiveField's smoothstep(Start, Start + Range,
 * SceneDepth)), from the scene pass's depth. A cross of five taps softens the cut along a
 * near card's edge by a pixel.
 */
const FarShader = {
  uniforms: {
    tDepth: { value: null },
    texel: { value: new THREE.Vector2() },
    cameraNear: { value: 1 },
    cameraFar: { value: 1000 },
    start: { value: 0 },
    range: { value: 1 },
  },
  vertexShader: QUAD_VERTEX,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDepth;
    uniform vec2 texel;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float start;
    uniform float range;
    varying vec2 vUv;
    float farAt(vec2 uv) {
      float viewDepth = -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
      return smoothstep(start, start + max(range, 0.001), viewDepth);
    }
    void main() {
      float around = farAt(vUv + vec2(texel.x, 0.0)) + farAt(vUv - vec2(texel.x, 0.0))
        + farAt(vUv + vec2(0.0, texel.y)) + farAt(vUv - vec2(0.0, texel.y));
      gl_FragColor = vec4(0.5 * farAt(vUv) + 0.125 * around, 0.0, 0.0, 1.0);
    }`,
};

/**
 * The scene pass, which also leaves the far mask in a target of its own while `far.on`:
 * the passes after it reuse the buffer its depth lands in (the bokeh pass clears it).
 */
class SceneRenderPass extends RenderPass {
  readonly far = {
    on: false,
    target: new THREE.WebGLRenderTarget(1, 1, { format: THREE.RedFormat, depthBuffer: false }),
    material: new THREE.ShaderMaterial({ ...FarShader, uniforms: THREE.UniformsUtils.clone(FarShader.uniforms) }),
  };
  private quad = new FullScreenQuad(this.far.material);
  constructor(scene: THREE.Scene, private readonly view: THREE.PerspectiveCamera) {
    super(scene, view);
  }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean) {
    // Three swaps a depth texture in for the buffer's depth renderbuffer on its next use.
    if (this.far.on && !this.renderToScreen) readBuffer.depthTexture ??= new THREE.DepthTexture(readBuffer.width, readBuffer.height);
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    if (!this.far.on || this.renderToScreen) return;
    const uniforms = this.far.material.uniforms;
    uniforms.tDepth.value = readBuffer.depthTexture;
    uniforms.texel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    uniforms.cameraNear.value = this.view.near;
    uniforms.cameraFar.value = this.view.far;
    renderer.setRenderTarget(this.far.target);
    this.quad.render(renderer);
  }
  override setSize(width: number, height: number) {
    this.far.target.setSize(width, height);
  }
  override dispose() {
    this.far.target.dispose();
    this.far.material.dispose();
    this.quad.dispose();
  }
}

/**
 * The theme's poster over the far rows (the Unreal build's M_ArchiveField): after the
 * output pass, so its flat colours are not tone-mapped, and only where the far mask
 * says the fog has taken the rows — the near rows, the raised archive and the
 * inspected one stay in front of it. The canvas holds straight sRGB values, as the
 * output does, so the mix is the one the page made when it lay over the scene.
 */
const PosterShader = {
  uniforms: {
    tDiffuse: { value: null },
    tFar: { value: null },
    tPoster: { value: null },
    amount: { value: 0 },
  },
  vertexShader: QUAD_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tFar;
    uniform sampler2D tPoster;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec4 poster = texture2D(tPoster, vUv);
      gl_FragColor = vec4(mix(base.rgb, poster.rgb, poster.a * texture2D(tFar, vUv).r * amount), base.a);
    }`,
};

export function createScenePipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  lightingLook: LightingLook,
) {
  const smaa = new SMAAPass();
  const composer = new EffectComposer(renderer);
  const render = new SceneRenderPass(scene, camera);
  composer.addPass(render);
  const ao = new SSAOPass(scene, camera, width, height);
  ao.kernelRadius = lightingLook === "refined" ? 0.44 : 0.38;
  ao.minDistance = 0.001;
  ao.maxDistance = 0.09;
  composer.addPass(ao);
  const bokeh = new BokehPass(scene, camera, {
    focus: 25,
    aperture: 0.0018,
    maxblur: 0.011,
  });
  composer.addPass(bokeh);
  smaa.enabled = false;
  composer.addPass(smaa);
  composer.addPass(new OutputPass());
  const poster = new ShaderPass(PosterShader);
  poster.enabled = false;
  poster.uniforms.tFar.value = render.far.target.texture;
  composer.addPass(poster);
  return { composer, ao, bokeh, smaa, far: render.far, poster };
}
