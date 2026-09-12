/** Searchable actions. The shell supplies effects; opening and filtering the
 * menu never reads a source, sends a model request, or changes user data. */
import { el, button, replace, focusQuietly } from './dom.js';

export function filterCommands(commands, query) {
  const words = String(query).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return commands.filter(command => words.every(word =>
    `${command.label} ${command.keywords || ''}`.toLocaleLowerCase().includes(word)));
}

export function commandShortcut(event) {
  return !event.isComposing && !event.repeat && !event.altKey &&
    (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'p';
}

export function createCommandMenu({ getCommands, fallbackFocus, onError }) {
  let opened = false;
  let previousFocus = null;
  let matches = [];
  let selected = -1;
  const input = el('input', {
    type: 'search', class: 'input command-search', role: 'combobox',
    'aria-label': 'Find a command', 'aria-autocomplete': 'list',
    'aria-controls': 'command-results', 'aria-expanded': 'true',
    autocomplete: 'off', placeholder: 'Search commands…',
  });
  const list = el('div', { id: 'command-results', class: 'command-results', role: 'listbox', 'aria-label': 'Commands' });
  const status = el('p', { class: 'quiet-note', role: 'status' });
  const closeButton = button('Close', { class: 'btn quiet', onClick: close });
  const node = el('dialog', { class: 'command-menu', 'aria-labelledby': 'command-title' }, [
    el('div', { class: 'command-head' }, [el('h2', { id: 'command-title', text: 'Commands' }), closeButton]),
    input, list, status,
    el('p', { class: 'quiet-note', text: '↑ ↓ to choose · Enter to run · Esc to close' }),
  ]);

  function paintSelection() {
    [...list.children].forEach((option, index) => {
      const active = index === selected;
      option.setAttribute('aria-selected', String(active));
      if (active) option.scrollIntoView({ block: 'nearest' });
    });
    if (selected >= 0) input.setAttribute('aria-activedescendant', `command-option-${selected}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function refresh() {
    const previous = matches[selected]?.id;
    matches = filterCommands(getCommands(), input.value);
    selected = matches.findIndex(command => command.id === previous && !command.disabled);
    if (selected < 0) selected = matches.findIndex(command => !command.disabled);
    replace(list, matches.map((command, index) => el('div', {
      id: `command-option-${index}`, class: 'command-option', role: 'option',
      'aria-disabled': String(Boolean(command.disabled)),
      onmousedown: event => event.preventDefault(),
      onclick: () => activate(command.id),
    }, [
      el('span', { text: command.label }),
      command.disabled && command.reason ? el('span', { class: 'quiet-note', text: command.reason })
        : command.shortcut ? el('kbd', { text: command.shortcut }) : null,
    ])));
    status.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'command' : 'commands'}` : 'No matching commands. Try another word.';
    paintSelection();
  }

  async function activate(id) {
    const command = getCommands().find(entry => entry.id === id);
    if (!command || command.disabled) { refresh(); return; }
    close();
    try { await command.run(); }
    catch (err) { onError?.(err); }
  }

  function finishClose() {
    if (!opened) return;
    opened = false;
    focusQuietly(previousFocus?.isConnected ? previousFocus : fallbackFocus());
    previousFocus = null;
  }

  function close() {
    if (node.open) node.close();
    finishClose();
  }

  function open() {
    if (opened) { focusQuietly(input); return; }
    previousFocus = document.activeElement;
    if (!node.isConnected) document.body.appendChild(node);
    input.value = '';
    opened = true;
    node.showModal();
    refresh();
    focusQuietly(input);
  }

  input.addEventListener('input', refresh);
  node.addEventListener('cancel', event => { event.preventDefault(); close(); });
  node.addEventListener('close', finishClose);
  node.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') {
      // The options use active-descendant focus; only the field and Close are
      // tab stops. Native showModal also keeps the background out of reach.
      event.preventDefault();
      focusQuietly(document.activeElement === input ? closeButton : input);
      return;
    }
    if (event.target !== input) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (selected >= 0) activate(matches[selected].id);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const enabled = matches.map((command, index) => command.disabled ? -1 : index).filter(index => index >= 0);
      if (!enabled.length) return;
      const next = enabled.indexOf(selected) + (event.key === 'ArrowDown' ? 1 : -1);
      selected = enabled[(next + enabled.length) % enabled.length];
      paintSelection();
    }
  });

  return { node, open, close, refresh, get isOpen() { return opened; } };
}
