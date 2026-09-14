import { el } from './dom.js';

const opened = new Map();

/** Keep disclosure choices when a view refreshes its records. */
export function disclosure(key, title, children, { open = false, className = '' } = {}) {
  const node = el('details', { class: `workspace-disclosure ${className}`, open: opened.has(key) ? opened.get(key) : open }, [
    el('summary', {}, [el('span', { text: title }), el('span', { class: 'workspace-chevron', 'aria-hidden': 'true', text: '+' })]),
    el('div', { class: 'workspace-disclosure-body' }, children),
  ]);
  node.addEventListener('toggle', () => { if (node.isConnected) opened.set(key, node.open); });
  return node;
}

export function reveal(node) {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  node.scrollIntoView?.({ block: 'start', behavior: 'auto' });
}
