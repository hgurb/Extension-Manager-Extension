'use strict';

function setupChromeShortcuts(extensionsButton, dashboardButton) {
  makeIconButton(extensionsButton, 'Chrome extensions', ['M20 11h-1V7c0-1.1-.9-2-2-2h-4V4c0-1.66-1.34-3-3-3S7 2.34 7 4v1H3c-1.1 0-2 .9-2 2v3.8h1.5c1.79 0 3.25 1.46 3.25 3.25S4.29 17.3 2.5 17.3H1V21c0 1.1.9 2 2 2h3.8v-1.5c0-1.79 1.46-3.25 3.25-3.25s3.25 1.46 3.25 3.25V23H17c1.1 0 2-.9 2-2v-4h1c1.66 0 3-1.34 3-3s-1.34-3-3-3Z']);
  extensionsButton.classList.add('extensions-shortcut');
  makeIconButton(dashboardButton, 'Chrome Web Store developer dashboard', ['M4 9h16v12H4Z', 'M3 9l2-6h14l2 6', 'M8 13v4h8v-4']);
  for (const [button, url] of [[extensionsButton, 'chrome://extensions/'], [dashboardButton, 'https://chrome.google.com/webstore/devconsole/']]) {
    button.addEventListener('click', async () => {
      try { await chrome.tabs.create({ url }); } catch (error) { report(error); }
    });
  }
}

// Preserve the visible row, rather than its old scroll offset, when content above grows.
function preserveListPosition(root, rowSelector, headingSelector, scroller = window) {
  const viewport = scroller === window ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  };
  const row = [...root.querySelectorAll(rowSelector)].find(visible);
  const heading = root.querySelector(headingSelector);
  const anchor = row || (heading && visible(heading) ? heading : null);
  if (!anchor) return () => {};
  const top = anchor.getBoundingClientRect().top;
  const id = row?.dataset.id;
  return () => {
    const replacement = id
      ? [...root.querySelectorAll(rowSelector)].find(element => element.dataset.id === id)
      : root.querySelector(headingSelector);
    if (!replacement) return;
    const delta = replacement.getBoundingClientRect().top - top;
    if (scroller === window) window.scrollBy({ top: delta, behavior: 'instant' });
    else scroller.scrollTop += delta;
  };
}

function burstFavoriteStar(star) {
  if (!star) return;
  const glyph = star.querySelector('svg');
  const blue = getComputedStyle(star).color;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  glyph.animate(reducedMotion ? [{ color: '#ffd578' }, { color: blue }] : [
    { color: '#ffd578', transform: 'scale(1)' },
    { color: '#ffe49a', transform: 'scale(1.4) rotate(-12deg)', offset: .28 },
    { color: '#ffd578', transform: 'scale(.95) rotate(5deg)', offset: .65 },
    { color: blue, transform: 'scale(1)' }
  ], { duration: 580, easing: 'ease-out' });
  if (reducedMotion) return;
  const rect = star.getBoundingClientRect();
  for (let index = 0; index < 8; index++) {
    const angle = index * Math.PI / 4;
    const spark = document.createElement('span');
    spark.className = 'favorite-spark';
    spark.setAttribute('aria-hidden', 'true');
    spark.style.left = `${rect.left + rect.width / 2}px`;
    spark.style.top = `${rect.top + rect.height / 2}px`;
    document.body.append(spark);
    const animation = spark.animate([
      { transform: `translate(${Math.cos(angle) * 9}px, ${Math.sin(angle) * 9}px) scale(.5)`, opacity: 1 },
      { transform: `translate(${Math.cos(angle) * 28}px, ${Math.sin(angle) * 28}px) scale(0)`, opacity: 0 }
    ], { duration: 520, easing: 'cubic-bezier(.15,.65,.35,1)' });
    animation.finished.finally(() => spark.remove());
  }
}

const fadingFavorites = new Map();
function trackFavoriteRemovals(previous, current, refresh) {
  for (const id of previous) {
    if (id === chrome.runtime.id || current.has(id) || fadingFavorites.has(id)) continue;
    const started = performance.now();
    const timer = setTimeout(() => { fadingFavorites.delete(id); void refresh(); }, 2400);
    fadingFavorites.set(id, { started, timer });
  }
  for (const id of current) {
    const pending = fadingFavorites.get(id);
    if (pending) { clearTimeout(pending.timer); fadingFavorites.delete(id); }
  }
}

function fadeFavorite(element, id) {
  const pending = fadingFavorites.get(id);
  if (!pending) return;
  element.classList.add('favorite-leaving');
  element.style.setProperty('--favorite-fade-elapsed', `${-(performance.now() - pending.started)}ms`);
}

const EXTENSION_GROUPS = [
  ['enabled-local', 'Enabled · Local unpacked'],
  ['enabled-store', 'Enabled · Chrome Web Store'],
  ['disabled-local', 'Disabled · Local unpacked'],
  ['disabled-store', 'Disabled · Chrome Web Store'],
  ['enabled-other', 'Enabled · Other installations'],
  ['disabled-other', 'Disabled · Other installations']
];

function sourceLabel(info) {
  if (info.installType === 'development') return 'Local · unpacked';
  if (/^https:\/\/chrome(webstore\.google\.com|\.google\.com\/webstore)(\/|$)/.test(info.updateUrl || '')) return 'Chrome Web Store';
  // management does not expose fromWebstore. Google's update service is
  // strong evidence of store distribution, but normal alone also includes CRX.
  if (/^https:\/\/clients2\.google\.com\/service\/update2\/crx(?:[/?]|$)/.test(info.updateUrl || '')) return 'Chrome Web Store';
  return { admin: 'Managed by your organization', sideload: 'Installed by other software', normal: 'Installed · source unavailable' }[info.installType] || 'Other installation';
}

function groupKey(info) {
  const source = info.installType === 'development' ? 'local' : sourceLabel(info) === 'Chrome Web Store' ? 'store' : 'other';
  return `${info.enabled ? 'enabled' : 'disabled'}-${source}`;
}

function icon(info) {
  const holder = document.createElement('span');
  holder.className = 'icon fallback';
  holder.textContent = info.name.slice(0, 1).toUpperCase();
  holder.setAttribute('aria-hidden', 'true');
  const best = [...(info.icons || [])].sort((a, b) => b.size - a.size)[0];
  if (best) {
    const image = document.createElement('img');
    image.className = 'icon';
    image.alt = '';
    image.src = best.url;
    image.addEventListener('error', () => image.remove());
    image.addEventListener('load', () => { holder.classList.remove('fallback'); holder.firstChild?.remove(); });
    holder.append(image);
  }
  return holder;
}

function identity(info) {
  const container = document.createElement('div');
  container.className = 'identity';
  const name = document.createElement('h3');
  name.className = 'name';
  name.textContent = info.name;
  name.addEventListener('pointerenter', () => {
    const clipped = name.scrollHeight > name.clientHeight + 1 || name.scrollWidth > name.clientWidth + 1;
    if (clipped) name.title = info.name;
    else name.removeAttribute('title');
  });
  const source = document.createElement('span');
  source.className = 'source';
  source.textContent = sourceLabel(info);
  const sourceIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sourceIcon.setAttribute('viewBox', '0 0 24 24');
  sourceIcon.setAttribute('fill', 'none');
  sourceIcon.setAttribute('stroke', 'currentColor');
  sourceIcon.setAttribute('stroke-width', '1.7');
  sourceIcon.setAttribute('stroke-linecap', 'round');
  sourceIcon.setAttribute('stroke-linejoin', 'round');
  sourceIcon.setAttribute('aria-hidden', 'true');
  const sourcePaths = info.installType === 'development'
    ? ['M3 6h7l2 2h9v12H3Z', 'M3 6V4h7l2 2']
    : sourceLabel(info) === 'Chrome Web Store'
      ? ['M4 9h16v12H4Z', 'M3 9l2-6h14l2 6', 'M8 13v4h8v-4']
      : ['M12 3 2 8l10 5 10-5Z', 'M2 12l10 5 10-5', 'M2 16l10 5 10-5'];
  for (const d of sourcePaths) {
    const path = document.createElementNS(sourceIcon.namespaceURI, 'path');
    path.setAttribute('d', d);
    sourceIcon.append(path);
  }
  source.prepend(sourceIcon);
  const state = document.createElement('span');
  state.className = `extension-state ${info.enabled ? 'is-enabled' : 'is-disabled'}`;
  state.textContent = info.enabled ? 'Enabled' : 'Disabled';
  container.append(name, source, state);
  return container;
}

function button(text, handler, className = '') {
  const element = document.createElement('button');
  element.textContent = text;
  element.className = className;
  element.addEventListener('click', async () => {
    element.disabled = true;
    try { await handler(); } catch (error) { report(error); }
    finally { element.disabled = false; }
  });
  return element;
}

async function openDetails(id) {
  await chrome.tabs.create({ url: `chrome://extensions/?id=${encodeURIComponent(id)}` });
}

function makeIconButton(element, name, paths) {
  element.setAttribute('aria-label', name);
  const tooltip = { 'Manager details': 'Details', 'Reload manager': 'Reload', 'Refresh extension': 'Reload', 'Restart extension': 'Reload', 'Reload this extension': 'Reload', 'Uninstall extension': 'Uninstall', 'Remove from this page': 'Hide card' };
  element.title ||= tooltip[name] || name;
  element.classList.add('icon-button');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  element.replaceChildren(svg);
  return element;
}
