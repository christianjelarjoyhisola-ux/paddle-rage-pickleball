/* Seasonal decorations for the public booking site.
 *
 * The `seasonal_theme` setting chooses the mode: 'auto' (default) follows the
 * Asia/Manila calendar, 'off' disables decorations, and a theme name forces it.
 * Decorations are purely visual: pointer-events are off, nothing is added to
 * dialogs, and motion stops for visitors who prefer reduced motion.
 */
(function (root) {
  'use strict';

  const THEMES = {
    halloween: {
      // Oct 15 – Oct 31
      from: [10, 15], to: [10, 31],
      particle: 'bat', desktopCount: 6, mobileCount: 3,
      logoBadge: 'pumpkin',
      banner: 'Spooky season at Paddle Rage — book a night game 🎃',
    },
    christmas: {
      // Nov 1 – Jan 6 (wraps the new year)
      from: [11, 1], to: [1, 6],
      particle: 'snow', desktopCount: 28, mobileCount: 14,
      logoBadge: 'santa-hat',
      banner: 'Merry Christmas from Paddle Rage Pickleball 🎄',
    },
  };

  const MODES = ['auto', 'off', ...Object.keys(THEMES)];

  function manilaMonthDay(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila', month: 'numeric', day: 'numeric', year: 'numeric',
    }).formatToParts(date);
    const get = type => Number(parts.find(p => p.type === type)?.value);
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  function inWindow({ month, day }, from, to) {
    const value = month * 100 + day;
    const start = from[0] * 100 + from[1];
    const end = to[0] * 100 + to[1];
    return start <= end ? value >= start && value <= end : value >= start || value <= end;
  }

  function normalizeMode(mode) {
    const value = String(mode || '').trim().toLowerCase();
    return MODES.includes(value) ? value : 'auto';
  }

  // Returns the active theme name, or null.
  function themeFor(date = new Date(), mode = 'auto') {
    const chosen = normalizeMode(mode);
    if (chosen === 'off') return null;
    if (chosen !== 'auto') return chosen;
    const today = manilaMonthDay(date);
    return Object.keys(THEMES).find(name => inWindow(today, THEMES[name].from, THEMES[name].to)) || null;
  }

  // The banner may be dismissed once per theme per season.
  function seasonKey(name, date = new Date()) {
    const { year, month } = manilaMonthDay(date);
    const seasonYear = name === 'christmas' && month === 1 ? year - 1 : year;
    return `pr-season-banner-${name}-${seasonYear}`;
  }

  const BAT_SVG = '<svg viewBox="0 0 64 28" aria-hidden="true"><path d="M32 9c-2-4-4-5-4-5s-1 3 0 6c-5-4-13-6-20-4 3 1 5 4 5 7-3-2-8-2-13 0 6 2 10 7 11 13 3-4 8-6 13-5 2 1 4 3 5 5h6c1-2 3-4 5-5 5-1 10 1 13 5 1-6 5-11 11-13-5-2-10-2-13 0 0-3 2-6 5-7-7-2-15 0-20 4 1-3 0-6 0-6s-2 1-4 5z" fill="currentColor"/></svg>';
  const PUMPKIN_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 6c0-2 1-4 3-4" stroke="#3f6b2a" stroke-width="2.4" fill="none" stroke-linecap="round"/><ellipse cx="10" cy="18" rx="7.5" ry="10" fill="#e8741e"/><ellipse cx="22" cy="18" rx="7.5" ry="10" fill="#e8741e"/><ellipse cx="16" cy="18" rx="7" ry="11" fill="#f28c28"/><path d="M10 15l3 3h-4zM22 15l-3 3h4zM10 22c2 2 4 3 6 2 2 1 4 0 6-2-2 1-4 1-6 0-2 1-4 1-6 0z" fill="#3a1d05"/></svg>';
  const HAT_SVG = '<svg viewBox="0 0 40 34" aria-hidden="true"><path d="M5 26C8 13 17 4 27 5c5 1 8 6 8 12l-4-3c-1 5 0 9 1 12z" fill="#d62f2f"/><path d="M27 5c5 1 8 6 8 12l-4-3c0-4-1-7-4-9z" fill="#a91f22"/><rect x="2" y="24" width="33" height="8" rx="4" fill="#fff"/><circle cx="35" cy="18" r="4.5" fill="#fff"/></svg>';

  function decorateLogos(doc, badge) {
    const svg = badge === 'pumpkin' ? PUMPKIN_SVG : HAT_SVG;
    doc.querySelectorAll('.logo .logo-img').forEach(img => {
      if (img.parentElement?.classList.contains('season-logo')) return;
      const wrap = doc.createElement('span');
      wrap.className = 'season-logo';
      img.replaceWith(wrap);
      wrap.appendChild(img);
      const deco = doc.createElement('span');
      deco.className = `season-logo-badge season-${badge}`;
      deco.innerHTML = svg;
      wrap.appendChild(deco);
    });
  }

  // The splash is the first screen visitors see, so it gets its own layer and
  // a badge on the large logo. Both leave with the splash.
  function decorateSplash(doc, theme, reducedMotion, narrow) {
    const splash = doc.getElementById('splashScreen');
    if (!splash) return;
    const stage = splash.querySelector('.pr-splash-logo-stage');
    if (stage && !stage.querySelector('.season-splash-badge')) {
      const deco = doc.createElement('span');
      deco.className = `season-splash-badge season-${theme.logoBadge}`;
      deco.setAttribute('aria-hidden', 'true');
      deco.innerHTML = theme.logoBadge === 'pumpkin' ? PUMPKIN_SVG : HAT_SVG;
      stage.appendChild(deco);
    }
    addParticles(doc, theme, reducedMotion, narrow, splash);
  }

  function addParticles(doc, theme, reducedMotion, narrow, container = doc.body) {
    if (reducedMotion) return;
    const layer = doc.createElement('div');
    layer.className = `season-layer season-${theme.particle}-layer${container === doc.body ? '' : ' in-splash'}`;
    layer.setAttribute('aria-hidden', 'true');
    const count = narrow ? theme.mobileCount : theme.desktopCount;
    for (let i = 0; i < count; i += 1) {
      const item = doc.createElement('span');
      item.className = `season-${theme.particle}`;
      const rand = (min, max) => (min + Math.random() * (max - min)).toFixed(2);
      if (theme.particle === 'snow') {
        item.style.left = `${rand(0, 100)}%`;
        item.style.setProperty('--size', `${rand(3, 7)}px`);
        item.style.setProperty('--drift', `${rand(-40, 40)}px`);
        item.style.animationDuration = `${rand(9, 18)}s`;
        item.style.animationDelay = `-${rand(0, 18)}s`;
        item.style.opacity = rand(0.45, 0.9);
      } else {
        item.innerHTML = BAT_SVG;
        item.style.top = `${rand(4, 32)}vh`;
        item.style.setProperty('--size', `${rand(26, 44)}px`);
        item.style.animationDuration = `${rand(14, 24)}s`;
        item.style.animationDelay = `-${rand(0, 24)}s`;
      }
      layer.appendChild(item);
    }
    container.appendChild(layer);
  }

  function addBanner(doc, name, theme, storage) {
    const key = seasonKey(name);
    try { if (storage?.getItem(key) === '1') return; } catch (_) { /* storage blocked */ }
    const nav = doc.querySelector('nav.nav');
    if (!nav) return;
    const banner = doc.createElement('div');
    banner.className = 'season-banner';
    banner.setAttribute('role', 'note');
    const text = doc.createElement('span');
    text.textContent = theme.banner;
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'season-banner-close';
    close.setAttribute('aria-label', 'Dismiss seasonal greeting');
    close.textContent = '✕';
    close.addEventListener('click', () => {
      banner.remove();
      try { storage?.setItem(key, '1'); } catch (_) { /* storage blocked */ }
    });
    banner.append(text, close);
    nav.insertAdjacentElement('afterend', banner);
  }

  function apply(mode, doc = root.document) {
    const name = themeFor(new Date(), mode);
    if (!name || !doc?.body || doc.body.dataset.season) return name;
    const theme = THEMES[name];
    const win = doc.defaultView || root;
    const reducedMotion = !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const narrow = !!win.matchMedia?.('(max-width: 640px)').matches;
    doc.body.dataset.season = name;
    decorateLogos(doc, theme.logoBadge);
    decorateSplash(doc, theme, reducedMotion, narrow);
    addParticles(doc, theme, reducedMotion, narrow);
    let storage = null;
    try { storage = win.localStorage; } catch (_) { /* storage blocked */ }
    addBanner(doc, name, theme, storage);
    return name;
  }

  const api = { THEMES, MODES, themeFor, normalizeMode, seasonKey, apply };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SeasonalTheme = api;
})(typeof window !== 'undefined' ? window : globalThis);
