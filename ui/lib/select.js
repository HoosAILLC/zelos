/** One dropdown for every view. The original select still owns form values,
 * change handlers and validation; the visible control never opens an OS menu. */
export function installSelects(root = document.body) {
  const doc = root?.ownerDocument, win = doc?.defaultView;
  if (!win?.MutationObserver || !win.HTMLSelectElement) return () => {};
  const records = new Map();
  let current = null, sequence = 0, frame = 0;
  const set = (node, key, value) => {
    if (value == null) { if (node.hasAttribute(key)) node.removeAttribute(key); }
    else if (node.getAttribute(key) !== String(value)) node.setAttribute(key, String(value));
  };
  const available = option => !option.disabled && !option.hidden && !option.closest('optgroup[disabled], optgroup[hidden]');
  const options = record => Array.from(record.select.options);
  function labelText(label) {
    return Array.from(label.childNodes).map(node => node.nodeType === 3 ? node.textContent :
      node.matches?.('select, button, input, textarea') ? '' : labelText(node)).join(' ').replace(/\s+/g, ' ').trim();
  }
  function sync(record) {
    const { select, trigger, value } = record;
    const selected = select.options[select.selectedIndex];
    const text = selected?.label || 'Choose an option';
    if (value.textContent !== text) value.textContent = text;
    const classes = select.className.split(/\s+/).filter(name => name && name !== 'zelos-select-native');
    set(trigger, 'class', [...classes, 'zelos-select'].join(' '));
    trigger.disabled = select.matches(':disabled');
    trigger.hidden = select.hidden;
    set(trigger, 'style', select.getAttribute('style'));
    set(trigger, 'title', select.getAttribute('title'));
    set(trigger, 'aria-label', select.getAttribute('aria-label') || Array.from(select.labels || []).map(labelText).join(' ') || 'Choose an option');
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-invalid']) set(trigger, attr, select.getAttribute(attr));
    set(trigger, 'aria-required', select.required ? 'true' : null);
    if (current === record && (trigger.disabled || trigger.hidden)) close();
  }
  function close() {
    if (!current) return;
    const record = current;
    current = null;
    record.popup?.remove(); record.popup = null;
    set(record.trigger, 'aria-expanded', 'false');
    set(record.trigger, 'aria-activedescendant', null);
    record.typed = '';
  }
  function position() {
    frame = 0;
    if (!current) return;
    const { trigger, popup } = current;
    const rect = trigger.getBoundingClientRect(), viewport = win.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || win.innerWidth, height = viewport?.height || win.innerHeight;
    if (!trigger.isConnected || !rect.width || rect.bottom < top || rect.top > top + height) { close(); return; }
    const below = top + height - rect.bottom - 16, above = rect.top - top - 16;
    const upward = below < Math.min(240, popup.scrollHeight) && above > below;
    popup.style.width = `${Math.min(Math.max(rect.width, 220), width - 16)}px`;
    popup.style.maxHeight = `${Math.max(44, Math.min(340, upward ? above : below))}px`;
    popup.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - popup.offsetWidth - 8))}px`;
    popup.style.top = `${upward ? Math.max(top + 8, rect.top - popup.offsetHeight - 8) : rect.bottom + 8}px`;
  }
  function reposition() { if (current && !frame) frame = win.requestAnimationFrame(position); }
  function highlight(record, index, scroll = true) {
    record.active = index;
    for (const row of record.popup.querySelectorAll('[role="option"]')) row.classList.toggle('is-active', Number(row.dataset.index) === index);
    const active = record.popup.querySelector(`[data-index="${index}"]`);
    set(record.trigger, 'aria-activedescendant', active?.id || null);
    if (scroll) active?.scrollIntoView({ block: 'nearest' });
  }
  function paint(record) {
    const { popup, select } = record;
    popup.replaceChildren();
    let group = null;
    options(record).forEach((option, index) => {
      if (option.hidden || option.closest('optgroup[hidden]')) return;
      const parent = option.parentElement;
      if (parent.tagName === 'OPTGROUP' && parent !== group) {
        group = parent;
        const heading = doc.createElement('div'); heading.className = 'zelos-select-group'; heading.textContent = parent.label;
        heading.setAttribute('role', 'presentation'); popup.append(heading);
      }
      const row = doc.createElement('div'); row.id = `${record.id}-${index}`; row.className = 'zelos-select-option';
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === select.selectedIndex));
      row.setAttribute('aria-disabled', String(!available(option))); row.dataset.index = String(index);
      const text = doc.createElement('span'); text.textContent = option.label;
      const check = doc.createElement('span'); check.className = 'zelos-select-check'; check.setAttribute('aria-hidden', 'true'); check.textContent = index === select.selectedIndex ? '✓' : '';
      row.append(text, check);
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('pointermove', () => { if (available(option)) highlight(record, index, false); });
      row.addEventListener('click', () => choose(record, index));
      popup.append(row);
    });
    const index = available(select.options[record.active] || { disabled: true }) ? record.active : options(record).findIndex(available);
    highlight(record, index, false);
  }
  function open(record) {
    sync(record);
    if (record.trigger.disabled || record.trigger.hidden || !options(record).some(available)) return;
    close(); current = record;
    const popup = doc.createElement('div'); popup.id = record.id; popup.className = 'zelos-select-menu';
    popup.setAttribute('role', 'listbox'); popup.setAttribute('aria-label', record.trigger.getAttribute('aria-label'));
    popup.setAttribute('popover', 'manual'); record.popup = popup; record.active = record.select.selectedIndex;
    (record.select.closest('dialog') || doc.body).append(popup);
    if (typeof popup.showPopover === 'function') popup.showPopover();
    else popup.removeAttribute('popover');
    paint(record); position();
    set(record.trigger, 'aria-expanded', 'true');
    record.trigger.focus({ preventScroll: true });
    highlight(record, record.active);
  }
  function choose(record, index) {
    const option = record.select.options[index];
    if (record.select.matches(':disabled') || !option || !available(option)) return;
    const changed = record.select.selectedIndex !== index;
    close(); record.select.selectedIndex = index; sync(record);
    if (changed) {
      record.select.dispatchEvent(new win.Event('input', { bubbles: true }));
      record.select.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  }
  function keydown(record, event) {
    if (event.isComposing || event.ctrlKey || event.metaKey) return;
    const expanded = current === record;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (expanded) { close(); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } }
      return;
    }
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!expanded) { open(record); return; }
      if (event.key === 'Enter' || event.key === ' ') { choose(record, record.active); return; }
      const indices = options(record).flatMap((option, index) => available(option) ? [index] : []);
      const at = indices.indexOf(record.active);
      const next = event.key === 'Home' ? indices[0] : event.key === 'End' ? indices.at(-1) : indices[(at + (event.key === 'ArrowUp' ? -1 : 1) + indices.length) % indices.length];
      highlight(record, next); return;
    }
    if (event.key.length === 1 && !event.altKey) {
      event.preventDefault(); if (!expanded) open(record); if (current !== record) return;
      const now = Date.now(); record.typed = (now - record.typedAt < 700 ? record.typed : '') + event.key.toLocaleLowerCase(); record.typedAt = now;
      const query = new Set(record.typed).size === 1 ? record.typed[0] : record.typed;
      const all = options(record), start = record.active + (query.length === 1 ? 1 : 0);
      for (let step = 0; step < all.length; step++) {
        const index = (start + step + all.length) % all.length;
        if (available(all[index]) && all[index].label.trim().toLocaleLowerCase().startsWith(query)) { highlight(record, index); break; }
      }
    }
  }
  function enhance(select) {
    if (records.has(select) || select.multiple || select.size > 1) return;
    const trigger = doc.createElement('button'); trigger.type = 'button';
    const value = doc.createElement('span'); value.className = 'zelos-select-value';
    const arrow = doc.createElement('span'); arrow.className = 'zelos-select-arrow'; arrow.setAttribute('aria-hidden', 'true');
    trigger.append(value, arrow);
    const record = { select, trigger, value, id: `zelos-select-${++sequence}`, active: -1, popup: null, typed: '', typedAt: 0, restore: [] };
    records.set(select, record);
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-controls', record.id); trigger.setAttribute('aria-expanded', 'false');
    select.classList.add('zelos-select-native'); select.after(trigger);
    // Values are also assigned by asynchronous data loads and form editors.
    // Instance accessors preserve the native semantics without polling or
    // changing the global HTMLSelectElement prototype.
    for (const property of ['value', 'selectedIndex', 'disabled']) {
      const descriptor = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, property);
      const original = Object.getOwnPropertyDescriptor(select, property);
      if (!descriptor?.set || original) continue;
      Object.defineProperty(select, property, { configurable: true, get() { return descriptor.get.call(this); }, set(next) {
        descriptor.set.call(this, next);
        if (record.onChange) record.onChange(); else sync(record);
      } });
      record.restore.push(() => { delete select[property]; });
    }
    const originalFocus = Object.getOwnPropertyDescriptor(select, 'focus');
    select.focus = settings => trigger.focus(settings);
    record.restore.push(() => { if (originalFocus) Object.defineProperty(select, 'focus', originalFocus); else delete select.focus; });
    record.onChange = () => { sync(record); if (current === record) { record.active = select.selectedIndex; paint(record); position(); } };
    select.addEventListener('change', record.onChange);
    select.addEventListener('input', record.onChange);
    trigger.addEventListener('click', event => { event.preventDefault(); current === record ? close() : open(record); });
    trigger.addEventListener('keydown', event => keydown(record, event));
    trigger.addEventListener('blur', () => { if (current === record) close(); });
    sync(record);
  }
  function dispose(record) {
    if (current === record) close();
    record.restore.forEach(restore => restore());
    record.select.removeEventListener('change', record.onChange); record.select.removeEventListener('input', record.onChange);
    record.select.classList.remove('zelos-select-native'); record.trigger.remove(); records.delete(record.select);
  }
  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.matches('select')) enhance(node);
    node.querySelectorAll('select').forEach(enhance);
  }
  const observer = new win.MutationObserver(mutations => {
    for (const record of records.values()) if (!root.contains(record.select)) dispose(record);
    const changed = new Set();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) scan(node);
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      const record = records.get(target?.closest('select'));
      if (record) changed.add(record);
      if (target?.tagName === 'FIELDSET') target.querySelectorAll('select').forEach(select => { if (records.has(select)) changed.add(records.get(select)); });
    }
    for (const record of changed) { sync(record); if (current === record) { paint(record); position(); } }
  });
  scan(root);
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['disabled', 'hidden', 'selected', 'label', 'value', 'class', 'style', 'title', 'required', 'id', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-invalid'] });
  const outside = event => { if (current && !current.trigger.contains(event.target) && !current.popup.contains(event.target)) close(); };
  const labelClick = event => {
    const label = event.target.closest?.('label'), record = records.get(label?.control);
    if (record && !event.target.closest('button, input, textarea, a')) { event.preventDefault(); record.trigger.focus(); }
  };
  const reset = () => win.setTimeout(() => { close(); records.forEach(sync); }, 0);
  const invalid = event => { const record = records.get(event.target); if (record) { event.preventDefault(); record.trigger.focus(); set(record.trigger, 'aria-invalid', 'true'); } };
  doc.addEventListener('pointerdown', outside, true); doc.addEventListener('click', labelClick);
  doc.addEventListener('reset', reset); doc.addEventListener('invalid', invalid, true);
  win.addEventListener('resize', reposition); win.addEventListener('scroll', reposition, true); win.addEventListener('hashchange', close); win.addEventListener('blur', close);
  win.visualViewport?.addEventListener('resize', reposition); win.visualViewport?.addEventListener('scroll', reposition);
  return () => {
    close(); observer.disconnect(); records.forEach(dispose); if (frame) win.cancelAnimationFrame(frame);
    doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('click', labelClick);
    doc.removeEventListener('reset', reset); doc.removeEventListener('invalid', invalid, true);
    win.removeEventListener('resize', reposition); win.removeEventListener('scroll', reposition, true); win.removeEventListener('hashchange', close); win.removeEventListener('blur', close);
    win.visualViewport?.removeEventListener('resize', reposition); win.visualViewport?.removeEventListener('scroll', reposition);
  };
}
