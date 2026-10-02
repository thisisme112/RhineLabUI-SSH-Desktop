import * as THREE from "three";
import { DESIGNS, REFERENCE_ROLES, roleOf, type ThemeDesign, type ThemeName } from "./theme-design";

const surfaces: Record<string, string> = {
  Frosted_Polymer: "#626b70", Ivory_Edges: "#687277", Optical_Diffuser: "#192226",
  Titanium_Fasteners: "#b1b9bb", Index_Inlay: "#c6a36b", Printed_Label: "#303a3e",
  Subsurface_Optics: "#939e9f", Optical_Edges: "#bbc3bc", Carbon_Ink: "#b6bdb8",
};
if (import.meta.env?.MODE === "desktop") Object.assign(surfaces, {
  Frosted_Polymer: "#62747e", Ivory_Edges: "#6f8188", Optical_Diffuser: "#1b2c35",
  Titanium_Fasteners: "#b7c7c9", Index_Inlay: "#c7a679", Printed_Label: "#30464e",
});

// ── Theme-aware surfaces ────────────────────────────────────────────────────
// Every archive surface holds two themes, the one it is leaving and the one it
// is turning to (Unreal ApplyThemeArchive: BaseColorFactor and BaseColorTo), and
// a per-card flip chooses between them. A light theme's colour is the shader's
// own times a per-role tint (its role over the measured paper role); a dark
// theme's replaces it with the role colour scaled by how bright the surface is
// against the measured night role, so the model keeps its internal contrast
// (RhineTheme::Surface). `paper` and `night` keep the measured tables.
const luminance = (c: THREE.Color) => .2126 * c.r + .7152 * c.g + .0722 * c.b;
const lum = (hex: string) => luminance(new THREE.Color(hex));
const WHITE = new THREE.Color(1, 1, 1);
type Slot = { tint: THREE.Color; dark: THREE.Color; amount: { value: number } };
type Bound = { name: string; from: Slot; to: Slot };
const bound = new Set<Bound>();
const shown = { from: "paper" as ThemeName, to: "paper" as ThemeName };

function darkFor(design: ThemeDesign, name: string): THREE.Color {
  const measured = new THREE.Color(surfaces[name] ?? (name.includes("Orange") ? "#bb8850" : "#969f9f"));
  if (!design.roles) return measured;
  const role = roleOf(name);
  const shade = THREE.MathUtils.clamp(luminance(measured) / Math.max(lum(REFERENCE_ROLES[1][role]), .001), .55, 1.2);
  const result = new THREE.Color(design.roles[role]).multiplyScalar(shade);
  return result.setRGB(Math.min(1, result.r), Math.min(1, result.g), Math.min(1, result.b));
}
function tintFor(design: ThemeDesign, name: string): THREE.Color {
  if (!design.roles || design.dark || name === "Printed_Canvas") return WHITE.clone();
  const role = roleOf(name), light = new THREE.Color(design.roles[role]), reference = new THREE.Color(REFERENCE_ROLES[0][role]);
  return new THREE.Color(
    THREE.MathUtils.clamp(light.r / Math.max(reference.r, .02), .35, 1.25),
    THREE.MathUtils.clamp(light.g / Math.max(reference.g, .02), .35, 1.25),
    THREE.MathUtils.clamp(light.b / Math.max(reference.b, .02), .35, 1.25),
  );
}
const slot = (): Slot => ({ tint: WHITE.clone(), dark: new THREE.Color(), amount: { value: 0 } });
function fill(target: Slot, theme: ThemeName, name: string) {
  const design = DESIGNS[theme];
  target.tint.copy(tintFor(design, name));
  target.dark.copy(darkFor(design, name));
  target.amount.value = design.dark ? 1 : 0;
}

// The room: what each theme sets, blended from the old to the new by themeEnvironment.
const desktop = import.meta.env?.MODE === "desktop";
const DEFAULT_DARK = {
  background: desktop ? "#15232b" : "#11181b",
  floor: desktop ? "#203039" : "#192125",
  mist: desktop ? "#30434c" : "#263136",
};
type Lighting = { exposure: number; env: number; fill: number; tint: THREE.Color };
/** A light room without a scene of its own keeps the shell's (null: the baseline captured from the scene). */
type Room = { dark: boolean; background: THREE.Color | null; floor: THREE.Color | null; mist: THREE.Color | null; light: Lighting };
function roomOf(theme: ThemeName): Room {
  const design = DESIGNS[theme], scene = design.scene;
  const color = (value: string | undefined, fallback: string | null) => {
    const hex = value ?? fallback;
    return hex ? new THREE.Color(hex) : null;
  };
  return {
    dark: design.dark,
    background: color(scene?.background, design.dark ? DEFAULT_DARK.background : null),
    floor: color(scene?.floor, design.dark ? DEFAULT_DARK.floor : null),
    mist: color(scene?.fog, design.dark ? DEFAULT_DARK.mist : null),
    light: {
      exposure: design.room.exposure, env: design.room.env, fill: design.room.fill,
      // Half strength: a cast, not a colour wash.
      tint: new THREE.Color(1, 1, 1).lerp(new THREE.Color(design.room.tint ?? "#ffffff"), .5),
    },
  };
}
const rooms = { from: roomOf("paper"), to: roomOf("paper") };

/**
 * Hold two themes: surfaces show `from` until their flip turns them to `to`, and
 * themeEnvironment blends the room between them. Called when a change starts
 * (`from` is what is on screen) and with the same theme twice when it settles.
 * Compiled surfaces are recoloured in place.
 */
export function setSceneThemes(from: ThemeName, to: ThemeName) {
  shown.from = from; shown.to = to;
  rooms.from = roomOf(from); rooms.to = roomOf(to);
  for (const entry of bound) { fill(entry.from, from, entry.name); fill(entry.to, to, entry.name); }
}
export const sceneThemes = (): Readonly<typeof shown> => shown;

/**
 * Extend existing optical shaders with the two themes. Returns the flip a single
 * mesh is shown at (0 the old theme, 1 the new); instanced rows read theirs per
 * card from `archiveTheme`, and `archiveFlash` is the flash a card gives as it turns.
 */
export function themeMaterial(material: THREE.Material, name: string, instanced = false, subduedIndex = { value: 0 }) {
  const flip = { value: 0 };
  const before = material.onBeforeCompile;
  const cache = material.customProgramCacheKey.bind(material)();
  const entry: Bound = { name, from: slot(), to: slot() };
  fill(entry.from, shown.from, name); fill(entry.to, shown.to, name);
  bound.add(entry);
  material.addEventListener("dispose", () => bound.delete(entry));
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.rhineTheme = flip;
    shader.uniforms.rhineFromTint = { value: entry.from.tint };
    shader.uniforms.rhineFromDark = { value: entry.from.dark };
    shader.uniforms.rhineFromAmount = entry.from.amount;
    shader.uniforms.rhineToTint = { value: entry.to.tint };
    shader.uniforms.rhineToDark = { value: entry.to.dark };
    shader.uniforms.rhineToAmount = entry.to.amount;
    shader.uniforms.rhineSubduedIndex = subduedIndex;
    if (instanced) {
      shader.uniforms.rhineFlashColor = flashUniform;
      shader.uniforms.rhineFlashGain = flashGain;
      shader.vertexShader = "attribute float archiveTheme; attribute float archiveFlash; varying float vRhineTheme; varying float vRhineFlash;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvRhineTheme = archiveTheme; vRhineFlash = archiveFlash;");
      shader.fragmentShader = "varying float vRhineTheme; varying float vRhineFlash; uniform vec3 rhineFlashColor; uniform float rhineFlashGain;\n" + shader.fragmentShader;
    }
    shader.fragmentShader = "uniform float rhineTheme; uniform vec3 rhineFromTint; uniform vec3 rhineFromDark; uniform float rhineFromAmount;\n" +
      "uniform vec3 rhineToTint; uniform vec3 rhineToDark; uniform float rhineToAmount; uniform float rhineSubduedIndex;\n" + shader.fragmentShader;
    const flipOf = instanced ? "vRhineTheme" : "rhineTheme";
    const printed = name === "Printed_Canvas";
    const anchor = printed ? "#include <opaque_fragment>" : "#include <roughnessmap_fragment>";
    // A dark theme's surface, given its colour.
    const dark = (surface: string) => printed
      ? "mix(vec3(0.023, 0.032, 0.037), vec3(0.78, 0.78, 0.71), 1.0 - smoothstep(0.12, 0.65, dot(diffuseColor.rgb, vec3(.2126,.7152,.0722))))"
      : name === "Frosted_Polymer" && !instanced
        ? `mix(${surface}, vec3(0.92, 0.96, 0.97), glassRevealAtHeight(archiveClarity, vArchiveHeight))`
        : name === "Index_Inlay" ? `mix(${surface}, vec3(0.030, 0.042, 0.048), rhineSubduedIndex)` : surface;
    const output = printed ? "outgoingLight" : "diffuseColor.rgb";
    const flash = instanced ? `\n${output} = mix(${output}, rhineFlashColor, vRhineFlash * rhineFlashGain);` : "";
    shader.fragmentShader = shader.fragmentShader.replace(anchor,
      `vec3 rhineOwn = ${output};\n` +
      `vec3 rhineFrom = mix(rhineOwn * rhineFromTint, ${dark("rhineFromDark")}, rhineFromAmount);\n` +
      `vec3 rhineTo = mix(rhineOwn * rhineToTint, ${dark("rhineToDark")}, rhineToAmount);\n` +
      `${output} = mix(rhineFrom, rhineTo, ${flipOf});${flash}\n${anchor}`);
  };
  material.customProgramCacheKey = () => `${cache}-rhine-theme-${name}-${instanced}`;
  return flip;
}

/** The colour a card flashes as it turns: the new theme's mark, a glint on a light theme and brighter on a dark one. */
const flashUniform = { value: new THREE.Color("#ffffff") };
const flashGain = { value: .4 };
export function setFlashColor(hex: string, dark = false) {
  flashUniform.value.set(hex);
  flashGain.value = dark ? .65 : .4;
}

const mixed = new THREE.Color();
type Baseline = { background: THREE.Color; fog?: THREE.Color; intensity: number; exposure: number; lights: { light: THREE.Light; intensity: number; color: THREE.Color }[]; floor?: { material: THREE.MeshStandardMaterial; color: THREE.Color } };
const scenes = new WeakMap<THREE.Scene, Baseline>();
/**
 * The room, `blend` of the way from the old theme to the new one. A light theme
 * scales the shell's own light room, a dark one the shell's night room
 * (Unreal ApplyThemeRoom / ApplyThemeRoomBlend).
 */
export function themeEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer, blend: number) {
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
  const a = rooms.from, b = rooms.to, base = baseline;
  const value = (room: Room, light: number, dark: number) => room.dark ? dark : light;
  (scene.background as THREE.Color).copy(a.background ?? base.background).lerp(b.background ?? base.background, blend);
  if (scene.fog && base.fog) scene.fog.color.copy(a.mist ?? base.fog).lerp(b.mist ?? base.fog, blend);
  if (base.floor) base.floor.material.color.copy(a.floor ?? base.floor.color).lerp(b.floor ?? base.floor.color, blend);
  scene.environmentIntensity = THREE.MathUtils.lerp(value(a, base.intensity, .32) * a.light.env, value(b, base.intensity, .32) * b.light.env, blend);
  renderer.toneMappingExposure = THREE.MathUtils.lerp(value(a, base.exposure, .98) * a.light.exposure, value(b, base.exposure, .98) * b.light.exposure, blend);
  mixed.copy(a.light.tint).lerp(b.light.tint, blend);
  const fillScale = THREE.MathUtils.lerp(value(a, 1, .65) * a.light.fill, value(b, 1, .65) * b.light.fill, blend);
  for (const { light, intensity, color } of base.lights) {
    light.intensity = intensity * fillScale;
    // The cast reaches the room's own light, not a directional key or its shadow.
    if (light instanceof THREE.AmbientLight || light instanceof THREE.HemisphereLight) light.color.copy(color).multiply(mixed);
  }
}

/** How dark the room is `blend` of the way through a change (Unreal HomeTheme). */
export function themeDarkness(blend: number) {
  return THREE.MathUtils.lerp(rooms.from.dark ? 1 : 0, rooms.to.dark ? 1 : 0, blend);
}
