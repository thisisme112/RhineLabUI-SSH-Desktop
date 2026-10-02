/**
 * Writes for code that runs every animation frame. Each compares against the
 * live DOM and leaves it alone when nothing changed: writing an attribute or a
 * style back unchanged still invalidates the element's style, and the next size
 * or computed-style read in the same frame then pays for a recalculation.
 * Comparing with the DOM rather than a private cache means another writer can
 * never leave a stale value behind; a value the browser serialises differently
 * is simply written, as it was before.
 */
export function setInert(element: HTMLElement, value: boolean) {
  if (element.inert !== value) element.inert = value;
}

export function setData(element: HTMLElement | SVGElement, key: string, value: string) {
  if (element.dataset[key] !== value) element.dataset[key] = value;
}

export function setAttr(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

export function setClass(element: Element, name: string, on: boolean) {
  if (element.classList.contains(name) !== on) element.classList.toggle(name, on);
}

/** A custom property (`--name`) or a hyphenated property name such as `opacity` or `translate`. */
export function setStyle(element: HTMLElement | SVGElement, property: string, value: string) {
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
}
