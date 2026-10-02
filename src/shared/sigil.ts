/**
 * A host's mark (the Unreal build's RhineLabel::Sigil, RhineLabel.h): five rows
 * mirrored about the middle column, from an FNV-1a hash of its identity mixed
 * once per cell. Bit `row * 5 + column` is a filled cell. The same key gives the
 * same mark on both sides, cell for cell.
 */
export function sigil(key: string): number {
  let h = 2166136261;
  // UTF-16 code units, as Unreal walks an FString's TCHARs.
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  let bits = 0;
  for (let row = 0; row < 5; row++) {
    const half = [0, 0, 0];
    let any = false;
    for (let cell = 0; cell < 3; cell++) {
      h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
      h = (h ^ (h >>> 13)) >>> 0;
      half[cell] = (h >>> 9) & 1;
      any ||= half[cell] !== 0;
    }
    if (!any) half[row % 3] = 1;
    const full = [half[0], half[1], half[2], half[1], half[0]];
    for (let column = 0; column < 5; column++) if (full[column]) bits |= 1 << (row * 5 + column);
  }
  return bits >>> 0;
}
