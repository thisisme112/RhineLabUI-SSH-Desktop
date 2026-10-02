/**
 * What each host's 5 × 5 mark is made from (the Unreal build's HostMarks in
 * rhine-ui.json): the fingerprint of the host key a session has seen, once one
 * has; the alias until then. Kept across launches so a host keeps its mark.
 */
const KEY = "rhine-host-marks";

let marks: Record<string, string> = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
})();

export const hostMark = (alias: string) => marks[alias] || alias;

/** A session reported the host key it verified: from now on that is the host's mark. */
export function noteHostKey(alias: string, fingerprint: string) {
  if (!alias || !fingerprint || marks[alias] === fingerprint) return;
  marks = { ...marks, [alias]: fingerprint };
  try {
    localStorage.setItem(KEY, JSON.stringify(marks));
  } catch {
    /* The mark still holds for this run. */
  }
}
