/**
 * ui/lib/dom.js — node building.
 *
 * There is exactly one reason this file exists: `innerHTML` must never touch a
 * string that came from the server, a mail message or a model. Everything below
 * builds real nodes and assigns `textContent`, so a subject line of
 * `<img onerror=…>` is a subject line, not a script. Nothing here has an
 * innerHTML path, not even an "internal" one — the moment a helper offers it,
 * some call site will hand it a message body.
 */

/**
 * el('div', {class:'card', onclick: fn}, ['text', childNode])
 *
 * Props: `class`, `text`, `html` is deliberately unsupported, `dataset`,
 * `style` (object), `on*` handlers, anything else becomes an attribute.
 * A null/undefined/false child is skipped, so `cond && el(…)` reads naturally.
 */
export function el(tag, props = null, children = null) {
  const node = document.createElement(tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

function applyProps(node, props) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'class') {
      node.setAttribute('class', String(value));
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value)) {
        if (dv !== null && dv !== undefined) node.dataset[dk] = String(dv);
      }
    } else if (key === 'style' && typeof value === 'object') {
      for (const [sk, sv] of Object.entries(value)) {
        if (sv !== null && sv !== undefined) node.style.setProperty(sk, String(sv));
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

function append(node, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    for (const child of children) append(node, child);
    return;
  }
  if (children instanceof Node) {
    node.appendChild(children);
    return;
  }
  node.appendChild(document.createTextNode(String(children)));
}

/** Replace a container's contents with new children, in one shot. */
export function replace(node, children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

/**
 * A real <button>. Every clickable thing in Zelos goes through here — no
 * div-with-onclick, so keyboard, focus ring and screen readers work by default.
 */
export function button(label, { onClick, class: className = '', ...rest } = {}) {
  return el('button', {
    type: 'button',
    class: className,
    onclick: onClick,
    ...rest,
  }, label);
}

/**
 * The one ornament: a meander (Greek key) rule. It is a CSS mask over
 * `currentColor`, so it inherits the ink or terracotta of whatever it divides
 * and needs no image file. `aria-hidden` because it means nothing aloud.
 */
export function meander({ class: className = '' } = {}) {
  return el('div', { class: `meander ${className}`.trim(), 'aria-hidden': 'true' });
}

/** A labelled section with a meander rule under the heading. */
export function section(title, { count = null, note = null, id = null } = {}, children = null) {
  const heading = el('h2', { class: 'section-title' }, [
    el('span', { text: title }),
    count !== null ? el('span', { class: 'section-count mono', text: String(count) }) : null,
  ]);
  return el('section', { class: 'section', ...(id ? { id } : {}) }, [
    heading,
    meander(),
    note ? el('p', { class: 'section-note', text: note }) : null,
    children,
  ]);
}

/** Focus without scrolling the world; used when a view swaps in. */
export function focusQuietly(node) {
  if (!node) return;
  try {
    node.focus({ preventScroll: true });
  } catch {
    node.focus();
  }
}

/**
 * Grow a textarea to fit its content. Draft bodies are paragraphs, and a
 * three-line window with an inner scrollbar makes them unreadable.
 */
export function autogrow(textarea, { min = 96 } = {}) {
  const fit = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(min, textarea.scrollHeight)}px`;
  };
  textarea.addEventListener('input', fit);
  // Once now for the initial value, and once after layout settles — a textarea
  // measured while its container is still `display:none` reports scrollHeight 0.
  fit();
  requestAnimationFrame(fit);
  return fit;
}

/** Copy to clipboard, falling back to a hidden textarea when the API is absent. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const scratch = el('textarea', { class: 'offscreen' });
    scratch.value = text;
    document.body.appendChild(scratch);
    scratch.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    scratch.remove();
    return ok;
  }
}
