import * as THREE from "three";
import { DESIGNS, REFERENCE_ROLES, roleOf, type ThemeDesign } from "./theme-design";

const surfaces: Record<string, string> = {
  Frosted_Polymer: "#626b70", Ivory_Edges: "#687277", Optical_Diffuser: "#192226",
  Titanium_Fasteners: "#b1b9bb", Index_Inlay: "#c6a36b", Printed_Label: "#303a3e",
  Subsurface_Optics: "#939e9f", Optical_Edges: "#bbc3bc", Carbon_Ink: "#b6bdb8",
};
if (import.meta.env?.MODE === "desktop") Object.assign(surfaces, {
  Frosted_Polymer: "#62747e", Ivory_Edges: "#6f8188", Optical_Diffuser: "#1b2c35",
  Titanium_Fasteners: "#b7c7c9", Index_Inlay: "#c7a679", Printed_Label: "#30464e",
});

// ── Palette-aware surfaces ──────────────────────────────────────────────────
// A palette with `roles` recolours the archive by role (Unreal RhineTheme::Surface):
// a surface takes its role's colour scaled by how bright it is against the measured
// night role colour, so the model keeps its internal contrast. The dark end is the
// recoloured `rhineDarkSurface`; the light end is the shader's own colour times a
// per-role tint (this theme's light role over the measured paper role).
const luminance = (c: THREE.Color) => .2126 * c.r + .7152 * c.g + .0722 * c.b;
const lum = (hex: string) => luminance(new THREE.Color(hex));
type Bound = { name: string; dark: THREE.Color; tint: THREE.Color };
const bound = new Set<Bound>();
let design: ThemeDesign | undefined;

function darkFor(name: string): THREE.Color {
  const measured = new THREE.Color(surfaces[name] ?? (name.includes("Orange") ? "#bb8850" : "#969f9f"));
  const roles = design?.roles;
  if (!roles) return measured;
  const role = roleOf(name);
  const shade = THREE.MathUtils.clamp(luminance(measured) / Math.max(lum(REFERENCE_ROLES[1][role]), .001), .55, 1.2);
  const result = new THREE.Color(roles[1][role]).multiplyScalar(shade);
  return result.setRGB(Math.min(1, result.r), Math.min(1, result.g), Math.min(1, result.b));
}
function tintFor(name: string): THREE.Color {
  const roles = design?.roles;
  if (!roles || name === "Printed_Canvas") return new THREE.Color(1, 1, 1);
  const role = roleOf(name), light = new THREE.Color(roles[0][role]), reference = new THREE.Color(REFERENCE_ROLES[0][role]);
  return new THREE.Color(
    THREE.MathUtils.clamp(light.r / Math.max(reference.r, .02), .35, 1.25),
    THREE.MathUtils.clamp(light.g / Math.max(reference.g, .02), .35, 1.25),
    THREE.MathUtils.clamp(light.b / Math.max(reference.b, .02), .35, 1.25),
  );
}

// The room. `dark*` are the dark end; a themed scene also replaces the light end.
const desktop = import.meta.env?.MODE === "desktop";
const defaultDark = {
  background: new THREE.Color(desktop ? "#15232b" : "#11181b"),
  floor: new THREE.Color(desktop ? "#203039" : "#192125"),
  mist: new THREE.Color(desktop ? "#30434c" : "#263136"),
};
const room = {
  dark: { background: defaultDark.background.clone(), floor: defaultDark.floor.clone(), mist: defaultDark.mist.clone() },
  light: undefined as undefined | { background: THREE.Color; floor: THREE.Color; mist: THREE.Color },
};

/**
 * Switch the scene and the archive to a palette's design. Surfaces that are
 * already compiled are recoloured in place, so this is safe to call at the
 * moment a change-over covers the screen.
 */
export function setSurfacePalette(name: string) {
  design = (DESIGNS as Record<string, ThemeDesign>)[name];
  const scene = design?.scene;
  room.dark.background.set(scene?.[1].background ?? defaultDark.background);
  room.dark.floor.set(scene?.[1].floor ?? defaultDark.floor);
  room.dark.mist.set(scene?.[1].fog ?? defaultDark.mist);
  room.light = scene ? { background: new THREE.Color(scene[0].background), floor: new THREE.Color(scene[0].floor), mist: new THREE.Color(scene[0].fog) } : undefined;
  lighting.light = lightingOf(design?.room?.[0]);
  lighting.dark = lightingOf(design?.room?.[1]);
  for (const entry of bound) { entry.dark.copy(darkFor(entry.name)); entry.tint.copy(tintFor(entry.name)); }
}

/** Extend existing optical shaders; one float per instance avoids new meshes or passes. */
export function themeMaterial(material: THREE.Material, name: string, instanced = false, subduedIndex = { value: 0 }) {
  const amount = { value: 0 };
  const before = material.onBeforeCompile;
  const cache = material.customProgramCacheKey.bind(material)();
  const entry: Bound = { name, dark: darkFor(name), tint: tintFor(name) };
  bound.add(entry);
  material.addEventListener("dispose", () => bound.delete(entry));
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.rhineTheme = amount;
    shader.uniforms.rhineDarkSurface = { value: entry.dark };
    shader.uniforms.rhineLightTint = { value: entry.tint };
    shader.uniforms.rhineSubduedIndex = subduedIndex;
    if (instanced) {
      // archiveFlash: the flash a card gives at the top of its turn after a theme change (PaletteFlip).
      shader.uniforms.rhineFlashColor = flashUniform;
      shader.vertexShader = "attribute float archiveTheme; attribute float archiveFlash; varying float vRhineTheme; varying float vRhineFlash;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvRhineTheme = archiveTheme; vRhineFlash = archiveFlash;");
      shader.fragmentShader = "varying float vRhineTheme; varying float vRhineFlash; uniform vec3 rhineFlashColor;\n" + shader.fragmentShader;
    }
    shader.fragmentShader = "uniform float rhineTheme; uniform vec3 rhineDarkSurface; uniform vec3 rhineLightTint; uniform float rhineSubduedIndex;\n" + shader.fragmentShader;
    const mix = instanced ? "vRhineTheme" : "rhineTheme";
    const printed = name === "Printed_Canvas";
    const anchor = printed ? "#include <opaque_fragment>" : "#include <roughnessmap_fragment>";
    const dark = printed
      ? "mix(vec3(0.023, 0.032, 0.037), vec3(0.78, 0.78, 0.71), 1.0 - smoothstep(0.12, 0.65, dot(diffuseColor.rgb, vec3(.2126,.7152,.0722))))"
      : name === "Frosted_Polymer" && !instanced
        ? "mix(rhineDarkSurface, vec3(0.92, 0.96, 0.97), glassRevealAtHeight(archiveClarity, vArchiveHeight))"
        : name === "Index_Inlay" ? "mix(rhineDarkSurface, vec3(0.030, 0.042, 0.048), rhineSubduedIndex)" : "rhineDarkSurface";
    const output = printed ? "outgoingLight" : "diffuseColor.rgb";
    const flash = instanced ? `\n${output} = mix(${output}, rhineFlashColor, vRhineFlash * 0.5);` : "";
    shader.fragmentShader = shader.fragmentShader.replace(anchor, `${output} = mix(${output} * rhineLightTint, ${dark}, ${mix});${flash}\n${anchor}`);
  };
  material.customProgramCacheKey = () => `${cache}-rhine-theme-${name}-${instanced}`;
  return amount;
}

/** The colour a card flashes at the top of its turn: the new theme's accent (set by the change-over). */
const flashUniform = { value: new THREE.Color("#ffffff") };
export function setFlashColor(hex: string) { flashUniform.value.set(hex); }

// How the theme lights the room at each end (ThemeDesign.room): multiples of the shell's own values,
// and the cast the ambient light takes. Neutral for a theme without one.
type Lighting = { exposure: number; env: number; fill: number; tint: THREE.Color };
const lightingOf = (source?: { exposure: number; env: number; fill: number; tint?: string }): Lighting => ({
  exposure: source?.exposure ?? 1, env: source?.env ?? 1, fill: source?.fill ?? 1,
  // Half strength: a cast, not a colour wash.
  tint: new THREE.Color(1, 1, 1).lerp(new THREE.Color(source?.tint ?? "#ffffff"), .5),
});
const lighting = { light: lightingOf(), dark: lightingOf() };
const mixed = new THREE.Color();

type Baseline = { background: THREE.Color; fog?: THREE.Color; intensity: number; exposure: number; lights: { light: THREE.Light; intensity: number; color: THREE.Color }[]; floor?: { material: THREE.MeshStandardMaterial; color: THREE.Color } };
const scenes = new WeakMap<THREE.Scene, Baseline>();
export function themeEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer, amount: number) {
  let baseline = scenes.get(scene);
  if (!baseline) {
    const lights: Baseline["lights"] = [];
    scene.traverse(object => { if (object instanceof THREE.Light) lights.push({ light: object, intensity: object.intensity, color: object.color.clone() }); });
    const floor = scene.getObjectByName("archive-floor") as THREE.Mesh | undefined;
    const material = floor?.material as THREE.MeshStandardMaterial | undefined;
    baseline = { background: (scene.background as THREE.Color).clone(), fog: scene.fog?.color.clone(), intensity: scene.environmentIntensity,
      exposure: renderer.toneMappingExposure, lights, floor: material ? { material, color: material.color.clone() } : undefined };
    scenes.set(scene, baseline);
  }
  const lit = room.light;
  (scene.background as THREE.Color).copy(lit?.background ?? baseline.background).lerp(room.dark.background, amount);
  if (scene.fog && baseline.fog) scene.fog.color.copy(lit?.mist ?? baseline.fog).lerp(room.dark.mist, amount);
  if (baseline.floor) baseline.floor.material.color.copy(lit?.floor ?? baseline.floor.color).lerp(room.dark.floor, amount);
  const bright = lighting.light, night = lighting.dark;
  scene.environmentIntensity = THREE.MathUtils.lerp(baseline.intensity * bright.env, .32 * night.env, amount);
  renderer.toneMappingExposure = THREE.MathUtils.lerp(baseline.exposure * bright.exposure, .98 * night.exposure, amount);
  mixed.copy(bright.tint).lerp(night.tint, amount);
  for (const { light, intensity, color } of baseline.lights) {
    light.intensity = intensity * THREE.MathUtils.lerp(bright.fill, .65 * night.fill, amount);
    // The cast reaches the room's own light, not a directional key or its shadow.
    if (light instanceof THREE.AmbientLight || light instanceof THREE.HemisphereLight) light.color.copy(color).multiply(mixed);
  }
}
