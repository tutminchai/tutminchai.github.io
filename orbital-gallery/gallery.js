'use strict';
const grid = document.querySelector('#film-cards');
const filters = document.querySelector('.filters');
const dialog = document.querySelector('#work-dialog');
const player = document.querySelector('#work-video');
const closeButton = dialog.querySelector('.close-btn');
const themes = ['全部作品', '天空與宇宙', '山林', '公路', '城市', '靜觀'];
const featured = ['cosmos', 'cedar', 'flight'];
const byId = new Map(films.map(film => [film.id, film]));
let lastOpener;
let currentFilm;
let currentTheme = themes[0];

const clock = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>';
function assetUrl(film, suffix) {
  const version = film.assetVersion ? '?v=' + film.assetVersion : '';
  return 'assets/' + film.id + suffix + version;
}
function showCollection(theme) {
  currentTheme = theme;
  const selection = theme === themes[0] ? films : films.filter(film => film.category === theme);
  for (const button of filters.children) button.setAttribute('aria-pressed', String(button.textContent === theme));
  grid.innerHTML = selection.map((film, index) =>
    `<a class="film-card" href="#work/${film.id}" aria-label="觀看《${film.title}》">
      <div class="thumb"><img src="${assetUrl(film, '.webp')}" width="960" height="540" alt="" loading="${index < 3 ? 'eager' : 'lazy'}">
        <span class="thumb-play" aria-hidden="true"></span><span class="duration">${clock}${film.duration}</span></div>
      <div class="card-label">${film.category}</div><h3>${film.title}</h3><p>${film.short}</p>
    </a>`).join('');
  document.querySelector('#filter-status').textContent = `${theme}，共 ${selection.length} 部作品`;
}
themes.forEach(theme => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = theme;
  button.addEventListener('click', () => { if (currentTheme !== theme) showCollection(theme); });
  filters.append(button);
});
showCollection(currentTheme);

const heroArt = document.querySelector('#hero-art');
const featureControls = document.querySelector('.feature-dots');
function showFeatured(id) {
  const film = byId.get(id);
  const base = id === 'cosmos' ? 'gallery-hero' : id;
  heroArt.querySelector('source').srcset = 'assets/' + base + (id === 'cosmos' ? '-small' : '') + '.webp';
  heroArt.querySelector('img').src = 'assets/' + base + '.webp';
  document.querySelector('#featured-name').textContent = film.title;
  const watch = document.querySelector('#featured-watch');
  watch.href = '#work/' + id;
  watch.setAttribute('aria-label', '觀看精選《' + film.title + '》');
  Array.from(featureControls.children).forEach((b, i) => b.setAttribute('aria-pressed', String(featured[i] === id)));
}
featured.forEach(id => {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-label', '切換至《' + byId.get(id).title + '》');
  b.addEventListener('click', () => showFeatured(id));
  featureControls.append(b);
});
showFeatured(featured[0]);

function showWork(film, playNow) {
  if (currentFilm !== film.id) {
    currentFilm = film.id;
    const content = {
      'work-name': film.title, 'work-en': film.english, 'work-concept': film.concept,
      'work-description': film.description, 'work-meta': [film.category, film.format, film.duration].join('　／　')
    };
    Object.entries(content).forEach(([id, value]) => document.getElementById(id).textContent = value);
    const youtubeLink = document.getElementById('work-youtube');
    youtubeLink.hidden = !film.youtube;
    if (film.youtube) youtubeLink.href = film.youtube;
    else youtubeLink.removeAttribute('href');
    const projections = document.getElementById('work-projections');
    const projectionLinks = film.projectionLinks || [];
    projections.replaceChildren(...projectionLinks.map(({ label, url }) => {
      const link = document.createElement('a');
      link.textContent = label + ' ↗';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    }));
    projections.hidden = !projectionLinks.length;
    player.pause();
    player.poster = assetUrl(film, '-screen.webp');
    player.src = assetUrl(film, '.mp4');
    player.setAttribute('aria-label', film.title + '，' + film.format);
    document.title = film.title + '｜星間映廊';
  }
  if (!dialog.open) dialog.showModal();
  document.body.classList.add('modal');
  dialog.scrollTop = 0;
  if (playNow) player.play().catch(() => {});
}
function dismissWork() {
  if (!dialog.open) return;
  player.pause();
  player.removeAttribute('src');
  player.load();
  dialog.close();
  document.body.classList.remove('modal');
  currentFilm = null;
  document.title = '星間映廊｜謝旻儕的沉浸式影像作品集';
  if (lastOpener && lastOpener.isConnected) lastOpener.focus({preventScroll:true});
}
function syncRoute(playNow = false) {
  const match = /^#work\/([a-z]+)$/.exec(location.hash);
  const film = match && byId.get(match[1]);
  if (film) showWork(film, playNow);
  else dismissWork();
}
function leaveWork() {
  if (history.state?.galleryWork) history.back();
  else {
    history.replaceState(null, '', '#collection');
    dismissWork();
    document.querySelector('#collection').scrollIntoView();
  }
}
closeButton.addEventListener('click', leaveWork);
dialog.addEventListener('cancel', event => {event.preventDefault(); leaveWork();});
dialog.addEventListener('click', event => {if(event.target === dialog) leaveWork();});
document.addEventListener('click', event => {
  const trigger = event.target.closest('a[href^="#work/"]');
  if (!trigger || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  lastOpener = trigger;
  history.pushState({galleryWork:true}, '', trigger.hash);
  syncRoute(true);
});
window.addEventListener('hashchange', () => syncRoute());
window.addEventListener('pagehide', () => player.pause());
syncRoute();

const navLinks = Array.from(document.querySelectorAll('.mast nav a'));
function setSection() {
  const border = window.innerHeight * .32;
  const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 3;
  const id = (document.querySelector('#about').getBoundingClientRect().top < border || atEnd) ? '#about' :
    document.querySelector('#collection').getBoundingClientRect().top < border ? '#collection' : '#home';
  navLinks.forEach(a => {
    a.classList.toggle('active', a.hash === id);
    if (a.hash === id) a.setAttribute('aria-current','location'); else a.removeAttribute('aria-current');
  });
}
let navFrame;
window.addEventListener('scroll', () => { if (!navFrame) navFrame = requestAnimationFrame(() => {navFrame = null;setSection();}); },{passive:true});
window.addEventListener('resize', setSection);
setSection();
const fullscreen = document.querySelector('.fullscreen-btn');
if (document.fullscreenEnabled && document.documentElement.requestFullscreen) {
  fullscreen.hidden = false;
  fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { fullscreen.hidden = true; }
  });
  document.addEventListener('fullscreenchange', () => {
    const label = document.fullscreenElement ? '離開全螢幕' : '進入全螢幕';
    fullscreen.title = label;
    fullscreen.setAttribute('aria-label',label);
  });
}
