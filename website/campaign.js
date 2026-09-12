'use strict';
document.documentElement.classList.add('js-ready');
const menu = document.querySelector('.menu');
const navigation = document.querySelector('#navigation');
function closeMenu() { menu.setAttribute('aria-expanded', 'false'); navigation.classList.remove('is-open'); }
menu.addEventListener('click', () => { const open = menu.getAttribute('aria-expanded') !== 'true'; menu.setAttribute('aria-expanded', String(open)); navigation.classList.toggle('is-open', open); });
navigation.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
const shots = [...document.querySelectorAll('.product-picker [data-shot]')];
const screen = document.querySelector('#product-image');
const dialog = document.querySelector('#screen-dialog');
let current = 0;
function select(index) {
  current = (index + shots.length) % shots.length;
  const button = shots[current];
  const { shot, title, description } = button.dataset;
  const label = button.textContent;
  const url = `/img/workspace/${shot}.png`;
  for (const item of shots) item.setAttribute('aria-pressed', String(item === button));
  screen.src = url;
  screen.alt = `Zelos ${label}: ${description} Actual app capture with fictional sample data.`;
  document.querySelector('#shot-title').textContent = title;
  document.querySelector('#shot-description').textContent = description;
  document.querySelector('#chapter').textContent = `${String(current + 1).padStart(2, '0')} / ${label}`;
  document.querySelector('#shot-count').textContent = `${String(current + 1).padStart(2, '0')} / ${shots.length}`;
  document.querySelector('#dialog-title').textContent = `Zelos — ${label}`;
  document.querySelector('#large-image').src = url;
  document.querySelector('#large-image').alt = screen.alt;
  document.querySelector('#original-image').href = url;
}
shots.forEach((button, index) => button.addEventListener('click', () => select(index)));
document.querySelectorAll('[data-direction]').forEach(button => button.addEventListener('click', () => select(current + Number(button.dataset.direction))));
document.querySelectorAll('[data-show-shot]').forEach(link => link.addEventListener('click', () => { const index = shots.findIndex(button => button.dataset.shot === link.dataset.showShot); if (index >= 0) select(index); }));
document.querySelector('.enlarge').addEventListener('click', () => dialog.showModal());
document.querySelector('.close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
