/** Tiny DOM builder: h('div', { class: 'x', onclick: fn }, child, 'text'). */
type Attrs = Record<string, unknown>;
export type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** Set textContent only when it changed (avoids layout churn). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** True if the event target is a text field (so global hotkeys should be ignored). */
export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox', 'button'].includes((t as HTMLInputElement).type));
}

/**
 * Attributes for a dialog backdrop that closes it on a tap. The press must
 * also start on the backdrop: touch-bar buttons act on pointerup, and the
 * browser's follow-up click would otherwise land on the dialog they just
 * opened and close it again.
 */
export function backdropClose(onClose: () => void): Attrs {
  let armed = false;
  return {
    class: 'modal',
    onpointerdown: (e: Event) => (armed = e.target === e.currentTarget),
    onclick: (e: Event) => {
      if (armed && e.target === e.currentTarget) onClose();
      armed = false;
    },
  };
}
