import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { renderDimensions, type RenderQuality } from "./render-quality";

export function applyTextureQuality(
  root: THREE.Object3D,
  renderer: THREE.WebGLRenderer,
  quality: RenderQuality,
) {
  const maximum = Math.min(
    quality.anisotropy,
    renderer.capabilities.getMaxAnisotropy(),
  );
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !value.isRenderTargetTexture)
          textures.add(value);
      }
    }
  });
  for (const texture of textures) {
    if (texture.anisotropy === maximum) continue;
    texture.anisotropy = maximum;
    texture.needsUpdate = true;
  }
}

export function resizeQuality(
  renderer: THREE.WebGLRenderer,
  composer: EffectComposer,
  host: HTMLElement,
  quality: RenderQuality,
  superPerformance = false,
  /** The frame governor's share of the resolution (ResolutionGovernor); 1 leaves the quality as chosen. */
  dynamicScale = 1,
  /** False when the frame is drawn straight to the canvas: the composer's targets are let go instead of kept at full size. */
  composed = true,
) {
  const width = Math.max(1, host.clientWidth),
    height = Math.max(1, host.clientHeight);
  const dimensions = renderDimensions(
    dynamicScale === 1 ? quality : { ...quality, scale: quality.scale * dynamicScale },
    width,
    height,
    host.getBoundingClientRect().width / width,
    devicePixelRatio,
    renderer.capabilities.maxTextureSize,
    superPerformance ? 921_600 : 8_294_400,
  );
  renderer.setPixelRatio(dimensions.ratio);
  renderer.setSize(width, height);
  // A phone at three times density would hold two half-float targets of its whole screen for nothing.
  composer.setPixelRatio(composed ? dimensions.ratio : 1);
  composer.setSize(composed ? width : 1, composed ? height : 1);
  // With the rows opaque (transmission 0) the capture holds the raised file alone: half size reads the same.
  renderer.transmissionResolutionScale = quality.transmission || 0.5;
  host.dataset.renderQuality = JSON.stringify({
    ...dimensions,
    antialias: quality.antialias,
    transmission: quality.transmission,
    anisotropy: Math.min(
      quality.anisotropy,
      renderer.capabilities.getMaxAnisotropy(),
    ),
    superPerformance,
    dynamicScale,
  });
  return dimensions;
}

export function createViewerPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
) {
  const composer = new EffectComposer(renderer);
  const smaa = new SMAAPass();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(smaa);
  composer.addPass(new OutputPass());
  return { composer, smaa };
}
