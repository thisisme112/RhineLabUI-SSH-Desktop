import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DECK_PARTS } from "./deck-motion";
import terminalAsset from "./assets/ssh-terminal.glb?url";

export { DECK_PARTS, DECK_REST_Y, deckBacklight, deckOpenStep, deckPose, SCREEN } from "./deck-motion";
export type { DeckPartId, DeckPose, ShellPartId } from "./deck-motion";
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
