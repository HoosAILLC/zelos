/** Small local line icons. Paths are fixed artwork; user content is always text. */
const paths = {
  documents: 'M5 2h7l4 4v12H5ZM12 2v5h4M8 11h5M8 14h5',
  booking: 'M6 2v4m8-4v4M3 8h14M3 4h14v14H3Zm4 9 2 2 4-5',
  shopping: 'M2 3h2l2 10h10l2-7H5M7 17h1m6 0h1',
  progress: 'M3 17V3m0 14h14M6 13l4-5 3 2 4-6',
  finance: 'M2 5h16v11H2ZM2 8h16m-5 4h3',
  health: 'M10 17 3 10C-2 3 7 0 10 6c3-6 12-3 7 4l-7 7ZM3 10h4l2-4 2 8 2-4h4',
  jobs: 'M4 5h12v12H4ZM7 5V3h6v2M7 9h6M7 13h4',
  now: 'm11 2-7 10h6l-1 8 7-11h-6l1-7Z',
  today: 'M10 2v2m0 12v2M2 10h2m12 0h2M4.3 4.3l1.4 1.4m8.6 8.6 1.4 1.4m0-11.4-1.4 1.4m-8.6 8.6-1.4 1.4M14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  owed: 'M4 6h12m-4-4 4 4-4 4M16 14H4m4-4-4 4 4 4',
  mail: 'M3 4h14v12H3ZM3 5l7 6 7-6',
  calendar: 'M6 2v4m8-4v4M3 8h14M4 4h12a1 1 0 0 1 1 1v12H3V5a1 1 0 0 1 1-1Z',
  search: 'm14 14 4 4M15 8.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z',
  ask: 'M4 3h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8l-5 3V5a2 2 0 0 1 1-2ZM7 7h7M7 11h4',
  settings: 'M10 6a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM10 2v2m0 12v2M2 10h2m12 0h2M4.3 4.3l1.4 1.4m8.6 8.6 1.4 1.4m0-11.4-1.4 1.4m-8.6 8.6-1.4 1.4',
  panel: 'M3 3h14v14H3ZM7 3v14',
  plus: 'M10 4v12M4 10h12',
  command: 'M7 7H4a2 2 0 1 1 2-2v10a2 2 0 1 1-2-2h12a2 2 0 1 1-2 2V5a2 2 0 1 1 2 2H7Z',
};

export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(key, value);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', paths[name] || paths.now);
  svg.appendChild(path);
  return svg;
}
