'use strict';

const $ = selector => document.querySelector(selector);
let busy = false;
let renderVersion = 0;
let remainingOpen = null;
let remainingQuery = '';
let selectedQuery = '';
let queriesLoaded = false;
let opened = false;
let favoriteIds = new Set();

async function saveSearches() {
  try { await chrome.storage.session.set({ popupSelectedQuery: selectedQuery, popupRemainingQuery: remainingQuery }); }
  catch (error) { report(error); }
}

function searchControl(input, label) {
  const wrapper = document.createElement('div');
  wrapper.className = 'popup-search-control';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'popup-search-clear';
  clear.textContent = '×';
  clear.title = 'Clear';
  clear.setAttribute('aria-label', label);
  clear.hidden = !input.value;
  input.addEventListener('input', () => { clear.hidden = !input.value; });
  clear.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus({ preventScroll: true });
  });
  wrapper.append(input, clear);
  return wrapper;
}

function report(error) {
  $('#status').textContent = error instanceof Error ? error.message : String(error);
}

async function openManager() {
  const url = chrome.runtime.getURL('manager.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function perform(action, success) {
  if (busy) return;
  busy = true;
  $('#popup-list').inert = true;
  try {
    await action();
    $('#status').textContent = success || '';
  } catch (error) { report(error); }
  finally {
    busy = false;
    $('#popup-list').inert = false;
    await refreshPopup();
  }
}

function control(name, paths, handler, className = '') {
  return makeIconButton(button('', handler, className), name, paths);
}

function popupCard(info, showSource = true, inFavorites = false) {
  const card = document.createElement('article');
  card.className = `popup-card${info.enabled ? '' : ' is-disabled'}`;
  if (inFavorites && !favoriteIds.has(info.id)) fadeFavorite(card, info.id);
  card.dataset.id = info.id;
  const nameRow = document.createElement('a');
  nameRow.className = 'popup-name-row';
  const hasOptions = info.enabled && !!info.optionsUrl;
  if (hasOptions) nameRow.href = info.optionsUrl;
  else nameRow.setAttribute('aria-disabled', 'true');
  nameRow.tabIndex = hasOptions ? 0 : -1;
  nameRow.title = !info.optionsUrl ? 'No options' : !info.enabled ? 'Enable first' : 'Options';
  nameRow.setAttribute('aria-label', `Options for ${info.name}`);
  nameRow.addEventListener('click', async event => {
    event.preventDefault();
    if (!hasOptions) return;
    try {
      if (info.id === chrome.runtime.id) await openManager();
      else await chrome.tabs.create({ url: info.optionsUrl });
    } catch (error) { report(error); }
  });
  const name = document.createElement('h2');
  name.className = 'popup-name';
  const text = document.createElement('span');
  text.textContent = info.name;
  name.append(text);
  const markedIcon = document.createElement('span');
  markedIcon.className = 'popup-marked-icon';
  markedIcon.append(icon(info));
  if (showSource) {
    const source = identity(info).querySelector('.source');
    const marker = document.createElement('span');
    marker.className = 'popup-source-marker';
    marker.title = info.installType === 'development' ? 'Unpacked' : sourceLabel(info) === 'Chrome Web Store' ? 'Web Store' : 'Other';
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', sourceLabel(info));
    marker.append(source.querySelector('svg'));
    markedIcon.append(marker);
  }
  nameRow.append(markedIcon, name);

  const primary = document.createElement('div');
  primary.className = 'popup-primary';
  const details = control('Details', ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v6', 'M12 7h.01'], () => openDetails(info.id));
  const isFavorite = favoriteIds.has(info.id);
  const favorite = control(isFavorite ? 'Remove from Favorites' : 'Add to Favorites', ['m12 3 2.8 5.7 6.3.9-4.55 4.43 1.08 6.27L12 17.34l-5.63 2.96 1.08-6.27L2.9 9.6l6.3-.9Z'], () => perform(async () => {
    const prefs = await chrome.storage.local.get('selectedIds');
    const next = new Set(prefs.selectedIds || []);
    next.add(chrome.runtime.id);
    if (next.has(info.id)) next.delete(info.id);
    else next.add(info.id);
    await chrome.storage.local.set({ selectedIds: [...next] });
  }).then(() => {
    const section = inFavorites ? '#popup-selected' : '.remaining-content';
    const row = [...document.querySelectorAll(`${section} .popup-card`)].find(element => element.dataset.id === info.id);
    burstFavoriteStar(row?.querySelector('.favorite-toggle'));
  }), 'favorite-toggle');
  favorite.title = isFavorite ? 'Unfavorite' : 'Favorite';
  favorite.setAttribute('aria-pressed', String(isFavorite));
  favorite.classList.toggle('is-favorite', isFavorite);
  primary.append(favorite, details);

  const state = document.createElement('div');
  state.className = 'popup-state';
  const refresh = control('Refresh extension', ['M20 7v5h-5', 'M20 12a8 8 0 1 0-2.3 5.7', 'M20 12a8 8 0 0 0-2.3-5.7'], () => perform(async () => {
    if (info.id === chrome.runtime.id) { chrome.runtime.reload(); return; }
    await chrome.management.setEnabled(info.id, false);
    try { await chrome.management.setEnabled(info.id, true); }
    catch (error) { throw new Error(`${info.name} was turned off but could not be turned back on. Enable it to try again. ${error.message || error}`); }
  }, `${info.name} refreshed.`), 'restart');
  refresh.disabled = !info.enabled || info.mayDisable === false;
  refresh.title = !info.enabled ? 'Enable first' : info.mayDisable === false ? 'Managed' : 'Reload';
  const label = document.createElement('label');
  label.className = 'enabled-label';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'switch';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', `Enable ${info.name}`);
  toggle.checked = info.enabled;
  toggle.disabled = info.enabled ? info.mayDisable === false : info.mayEnable === false;
  toggle.title = toggle.disabled ? 'Managed' : info.enabled ? 'Disable' : 'Enable';
  toggle.addEventListener('change', () => perform(() => chrome.management.setEnabled(info.id, toggle.checked)));
  label.append(toggle);
  state.append(refresh, label);
  const controls = document.createElement('div');
  controls.className = 'popup-controls';
  controls.append(primary, state);
  card.append(nameRow, controls);
  return card;
}

function popupEntries(visible, prefs, customOrder = true) {
  if (!prefs.grouped) return visible.map(info => popupCard(info, true, customOrder));
  const groups = [];
  for (const [key, title] of EXTENSION_GROUPS) {
    const members = visible.filter(info => groupKey(info) === key);
    if (!members.length) continue;
    if (prefs.rearrange && customOrder) {
      const stored = prefs.cardOrders?.grouped?.[key] || [];
      const order = [...new Set([...stored, ...(prefs.selectedIds || [])])];
      members.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    }
    const section = document.createElement('section');
    section.className = 'popup-group';
    section.setAttribute('aria-label', title);
    const heading = document.createElement('h3');
    heading.className = 'popup-group-title';
    heading.textContent = title;
    section.append(heading, ...members.map(info => popupCard(info, false, customOrder)));
    groups.push(section);
  }
  return groups;
}

function prepareMarquees(root) {
  for (const name of root.querySelectorAll('.popup-name:not(.has-overflow)')) {
    const text = name.firstChild;
    if (text.scrollWidth - name.clientWidth <= 1) continue;
    const loopDistance = text.scrollWidth + 24;
    const track = document.createElement('span');
    track.className = 'popup-name-track';
    const repeat = text.cloneNode(true);
    repeat.setAttribute('aria-hidden', 'true');
    track.append(text, repeat);
    name.replaceChildren(track);
    name.classList.add('has-overflow');
    name.style.setProperty('--scroll-distance', `${-loopDistance}px`);
    name.style.setProperty('--scroll-duration', `${Math.max(5, loopDistance / 30)}s`);
  }
}

async function refreshPopup() {
  if (busy) return;
  const version = ++renderVersion;
  try {
    const [all, prefs, session] = await Promise.all([chrome.management.getAll(), chrome.storage.local.get(['selectedIds', 'theme', 'grouped', 'rearrange', 'cardOrders']), chrome.storage.session.get(['popupRemainingOpen', 'popupSelectedQuery', 'popupRemainingQuery'])]);
    if (version !== renderVersion || busy) return;
    const scrollTop = $('#popup-list').scrollTop;
    const focusedSearch = document.activeElement?.classList.contains('popup-search') ? document.activeElement.getAttribute('aria-label') : null;
    const caret = focusedSearch ? document.activeElement.selectionStart : null;
    if (!queriesLoaded) {
      selectedQuery = typeof session.popupSelectedQuery === 'string' ? session.popupSelectedQuery : '';
      remainingQuery = typeof session.popupRemainingQuery === 'string' ? session.popupRemainingQuery : '';
      queriesLoaded = true;
    }
    document.documentElement.dataset.theme = prefs.theme === 'light' ? 'light' : 'dark';
    const ids = new Set(prefs.selectedIds || []);
    trackFavoriteRemovals(favoriteIds, ids, refreshPopup);
    favoriteIds = ids;
    const extensions = all.filter(info => info.type === 'extension' && info.id !== chrome.runtime.id).sort((a, b) => a.name.localeCompare(b.name));
    const visible = extensions.filter(info => ids.has(info.id) || fadingFavorites.has(info.id));
    const remaining = extensions;
    if (remainingOpen === null) remainingOpen = session.popupRemainingOpen === true;
    $('#popup-empty').hidden = visible.length > 0;
    const selectedList = document.createElement('div');
    selectedList.id = 'popup-selected';
    const selectedSearch = document.createElement('input');
    selectedSearch.type = 'search';
    selectedSearch.className = 'popup-search';
    selectedSearch.placeholder = 'Search selected extensions…';
    selectedSearch.setAttribute('aria-label', 'Search selected extensions');
    selectedSearch.autocomplete = 'off';
    selectedSearch.value = selectedQuery;
    const selectedEmpty = document.createElement('p');
    selectedEmpty.className = 'remaining-empty';
    selectedEmpty.textContent = 'No matching selected extensions.';
    selectedEmpty.setAttribute('role', 'status');
    selectedEmpty.hidden = true;
    const populateSelected = () => {
      const query = selectedQuery.trim().toLocaleLowerCase();
      const matches = visible.filter(info => info.name.toLocaleLowerCase().includes(query));
      selectedList.replaceChildren(...popupEntries(matches, prefs));
      selectedEmpty.hidden = matches.length > 0 || visible.length === 0;
      prepareMarquees(selectedList);
    };
    selectedSearch.addEventListener('input', () => { selectedQuery = selectedSearch.value; populateSelected(); void saveSearches(); });
    $('#popup-list').replaceChildren(searchControl(selectedSearch, 'Clear selected search'), selectedList, selectedEmpty);
    populateSelected();
    if (remaining.length) {
      const details = document.createElement('details');
      details.className = 'popup-remaining';
      details.open = remainingOpen;
      const summary = document.createElement('summary');
      summary.textContent = `All extensions (${remaining.length})`;
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'popup-search remaining-search';
      search.placeholder = 'Search extensions…';
      search.setAttribute('aria-label', 'Search all extensions');
      search.autocomplete = 'off';
      search.value = remainingQuery;
      const content = document.createElement('div');
      content.className = 'remaining-content';
      const empty = document.createElement('p');
      empty.className = 'remaining-empty';
      empty.textContent = 'No matching extensions.';
      empty.setAttribute('role', 'status');
      empty.hidden = true;
      details.append(summary, searchControl(search, 'Clear all extensions search'), content, empty);
      const scrollToSection = () => {
        if (!details.open) return;
        const list = $('#popup-list');
        const inset = parseFloat(getComputedStyle(list).paddingTop) || 0;
        const top = list.scrollTop + summary.getBoundingClientRect().top - list.getBoundingClientRect().top - inset;
        list.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      };
      let scrollOnOpen = false;
      summary.addEventListener('click', () => { scrollOnOpen = !details.open; });
      search.addEventListener('click', scrollToSection);
      search.addEventListener('focus', scrollToSection);
      const populate = () => {
        if (!details.open) return;
        const query = remainingQuery.trim().toLocaleLowerCase();
        const matches = remaining.filter(info => info.name.toLocaleLowerCase().includes(query));
        content.replaceChildren(...popupEntries(matches, prefs, false));
        empty.hidden = matches.length > 0;
        prepareMarquees(content);
      };
      search.addEventListener('input', () => { remainingQuery = search.value; populate(); void saveSearches(); });
      details.addEventListener('toggle', async () => {
        if (!details.isConnected) return;
        remainingOpen = details.open;
        populate();
        if (details.open && scrollOnOpen) scrollToSection();
        scrollOnOpen = false;
        try { await chrome.storage.session.set({ popupRemainingOpen: details.open }); }
        catch (error) { report(error); }
      });
      $('#popup-list').append(details);
      populate();
    }
    $('#popup-list').scrollTop = scrollTop;
    prepareMarquees(selectedList);
    const focusTarget = !opened ? selectedSearch : [...document.querySelectorAll('.popup-search')].find(input => input.getAttribute('aria-label') === focusedSearch);
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
      const position = caret === null ? focusTarget.value.length : caret;
      focusTarget.setSelectionRange(position, position);
    }
    opened = true;
  } catch (error) { report(error); }
}

$('#open-manager').addEventListener('click', async () => { try { await openManager(); } catch (error) { report(error); } });
$('#manager-tools').append(
  control('Manager details', ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v6', 'M12 7h.01'], () => openDetails(chrome.runtime.id)),
  control('Reload manager', ['M20 7v5h-5', 'M20 12a8 8 0 1 0-2.3 5.7', 'M20 12a8 8 0 0 0-2.3-5.7'], () => { chrome.runtime.reload(); })
);
$('#open-chrome').addEventListener('click', async () => { try { await chrome.tabs.create({ url: 'chrome://extensions/' }); } catch (error) { report(error); } });
for (const name of ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled']) chrome.management[name].addListener(refreshPopup);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['selectedIds', 'theme', 'grouped', 'rearrange', 'cardOrders'].some(key => key in changes)) void refreshPopup();
});
void refreshPopup();
