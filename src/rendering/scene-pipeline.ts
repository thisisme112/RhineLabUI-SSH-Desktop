import type * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import type { LightingLook } from "./archive-lighting";

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
  composer.addPass(new RenderPass(scene, camera));
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
  return { composer, ao, bokeh, smaa };
}
