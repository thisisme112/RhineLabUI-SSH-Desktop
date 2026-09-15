import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import terminalAsset from "./assets/ssh-terminal.glb?url";

/** Projection and camera anchors match art/build_terminal.py. */
export const SCREEN = { width: 4.36, height: 2.42, y: 1.565, z: 0.139 } as const;
export const DECK_PARTS = [
  { id: "bezel", label: "光导与定位角", en: "LIGHT GUIDES", depth: 1.3, slide: [-1.39, 0.98], z: 0.096 },
  { id: "screen", label: "无边框显示层", en: "EDGE DISPLAY", depth: 0.5, slide: [-0.7, 0.49], z: SCREEN.z },
  { id: "vents", label: "散热层", en: "THERMAL LAYER", depth: 0.05, slide: [0, 0], z: -0.001 },
  { id: "board", label: "主板与接口", en: "BOARD & PORTS", depth: -0.45, slide: [0.7, -0.49], z: -0.045 },
  { id: "backplate", label: "背板", en: "BACKPLATE", depth: -1, slide: [1.39, -0.98], z: -0.108 },
] as const;
export type DeckPartId = (typeof DECK_PARTS)[number]["id"];
export type DeckInsert = {
  group: THREE.Group; parts: Map<string, THREE.Group>; screen: THREE.Mesh;
  setTheme(amount: number): void; setBacklight(level: number, failed: boolean): void;
};

/** Blender owns the geometry and named layers; the renderer owns live state. */
export async function buildDeckInsert(): Promise<DeckInsert> {
  const { scene: group } = await new GLTFLoader().loadAsync(terminalAsset);
  const parts = new Map<string, THREE.Group>();
  const materials = new Set<THREE.MeshStandardMaterial>();
  let screen: THREE.Mesh | undefined;
  group.traverse(object => {
    if (object.userData.deckPart) parts.set(object.userData.deckPart, object as THREE.Group);
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true; object.receiveShadow = true;
    if (object.userData.terminalScreen) {
      screen = object; (object.material as THREE.Material).dispose();
      object.material = new THREE.MeshBasicMaterial({ toneMapped: false });
    } else materials.add(object.material as THREE.MeshStandardMaterial);
  });
  if (!screen || DECK_PARTS.some(part => !parts.has(part.id))) throw new Error("终端模型层缺失");
  const colors: Record<string, [number, number]> = {
    Terminal_Shell: [0x77878c, 0x25353f], Terminal_Seam: [0x243039, 0x0b1218],
    Terminal_Board: [0x263a3f, 0x162a32], Terminal_Guide: [0x789da4, 0x8db8c0],
    Terminal_Amber: [0xb8935c, 0xd0ac72],
  };
  return { group, parts, screen,
    setTheme(amount) {
      for (const mat of materials) {
        const pair = colors[mat.name.replace(/\.\d+$/, "")];
        if (pair) mat.color.setHex(pair[0]).lerp(new THREE.Color(pair[1]), amount);
        if (/Guide|Amber/.test(mat.name)) mat.emissive.copy(mat.color);
      }
    },
    setBacklight(level, failed) {
      for (const mat of materials) if (/Guide|Amber/.test(mat.name)) {
        mat.emissive.copy(mat.color); if (failed) mat.emissive.setHex(0xd06a4a);
        mat.emissiveIntensity = 0.25 + level * 0.7;
      }
    },
  };
}
