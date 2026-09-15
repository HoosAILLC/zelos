'use strict';

// Match each film to the screen before playback. Keep an in-progress film
// uninterrupted if the visitor rotates their phone or resizes the window.
const phone = window.matchMedia('(max-width: 760px)');
const players = [...document.querySelectorAll('video[data-film-landscape]')];

function prepare(video) {
  if (!video.paused || video.currentTime > 0) return;
  const format = phone.matches ? 'portrait' : 'landscape';
  if (video.dataset.filmFormat === format) return;
  video.dataset.filmFormat = format;
  video.poster = phone.matches ? video.dataset.posterPortrait : video.dataset.posterLandscape;
  video.src = phone.matches ? video.dataset.filmPortrait : video.dataset.filmLandscape;
  video.load();
}

players.forEach(video => {
  prepare(video);
  video.addEventListener('play', () => {
    players.forEach(other => { if (other !== video) other.pause(); });
  });
});
phone.addEventListener('change', () => players.forEach(prepare));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) players.forEach(video => video.pause());
});
