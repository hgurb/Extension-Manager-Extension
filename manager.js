'use strict';

const $ = (selector) => document.querySelector(selector);
let extensions = [];
let selected = new Set();
let theme = 'dark';
let refreshVersion = 0;
let savingSelection = false;
let grouped = false;
let rearrange = false;
let cardOrders = { ungrouped: [], grouped: {} };
let dragActive = false;
let savingOrder = false;

function groupKey(info) {
  const source = info.installType === 'development' ? 'local' : sourceLabel(info) === 'Chrome Web Store' ? 'store' : 'other';
  return `${info.enabled ? 'enabled' : 'disabled'}-${source}`;
}

function syncOrders(previous) {
  const visible = extensions.filter(info => selected.has(info.id));
  const selectedOrder = [...selected].filter(id => visible.some(info => info.id === id));
  const reconcile = (old, ids) => {
    const retained = [...new Set(Array.isArray(old) ? old : [])].filter(id => ids.includes(id));
    return [...retained, ...ids.filter(id => !retained.includes(id))];
  };
  const next = { ungrouped: reconcile(previous?.ungrouped, selectedOrder), grouped: {} };
  for (const key of ['enabled-local', 'enabled-store', 'disabled-local', 'disabled-store', 'enabled-other', 'disabled-other']) {
    const ids = selectedOrder.filter(id => groupKey(visible.find(info => info.id === id)) === key);
    next.grouped[key] = reconcile(previous?.grouped?.[key], ids);
  }
  return next;
}

async function moveCard(card, target, focusHandle = false) {
  if (savingOrder || !rearrange || !target || card === target || card.parentElement !== target.parentElement) return;
  const siblings = [...card.parentElement.children].filter(element => element.classList.contains('card'));
  const ids = siblings.map(element => element.dataset.id);
  const from = ids.indexOf(card.dataset.id);
  const to = ids.indexOf(target.dataset.id);
  ids.splice(from, 1);
  ids.splice(to, 0, card.dataset.id);
  const next = structuredClone(cardOrders);
  if (grouped) next.grouped[card.dataset.group] = ids;
  else next.ungrouped = ids;
  savingOrder = true;
  try {
    await chrome.storage.local.set({ cardOrders: next });
    cardOrders = next;
    $('#status').textContent = 'Card order saved.';
  } catch (error) { report(error); }
  finally {
    savingOrder = false;
    await refresh();
    if (focusHandle) [...document.querySelectorAll('.card')].find(element => element.dataset.id === card.dataset.id)?.querySelector('.drag-handle')?.focus();
  }
}

function dragHandle(card, info) {
  const handle = document.createElement('button');
  handle.className = 'drag-handle';
  makeIconButton(handle, `Rearrange ${info.name}`, ['M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01']);
  handle.title = 'Drag to rearrange. Or focus and use arrow keys. Grouped cards move within their group.';
  handle.addEventListener('keydown', async event => {
    const direction = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (!direction) return;
    event.preventDefault();
    const siblings = [...card.parentElement.children];
    await moveCard(card, siblings[siblings.indexOf(card) + direction], true);
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || savingOrder || dragActive) return;
    event.preventDefault();
    handle.focus();
    const start = { x: event.clientX, y: event.clientY };
    const rect = card.getBoundingClientRect();
    let ghost = null;
    let target = null;
    dragActive = true;
    handle.setPointerCapture(event.pointerId);
    const cleanup = () => {
      ghost?.remove();
      card.classList.remove('is-dragging');
      target?.classList.remove('drop-target');
      dragActive = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', cancel);
      handle.removeEventListener('lostpointercapture', cancel);
      document.removeEventListener('keydown', escape);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    const move = current => {
      if (!ghost && Math.hypot(current.clientX - start.x, current.clientY - start.y) < 5) return;
      if (!ghost) {
        ghost = card.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.inert = true;
        ghost.style.width = `${rect.width}px`;
        document.body.append(ghost);
        card.classList.add('is-dragging');
      }
      ghost.style.left = `${rect.left + current.clientX - start.x}px`;
      ghost.style.top = `${rect.top + current.clientY - start.y}px`;
      target?.classList.remove('drop-target');
      const hit = document.elementFromPoint(current.clientX, current.clientY)?.closest('.card');
      target = hit && hit !== card && hit.parentElement === card.parentElement ? hit : null;
      target?.classList.add('drop-target');
      if (current.clientY < 55) window.scrollBy(0, -18);
      else if (current.clientY > innerHeight - 55) window.scrollBy(0, 18);
    };
    const finish = async () => {
      const destination = target;
      cleanup();
      if (destination) await moveCard(card, destination, true);
      else await refresh();
    };
    const cancel = () => { cleanup(); void refresh(); };
    const escape = current => { if (current.key === 'Escape') { current.preventDefault(); cancel(); } };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', cancel);
    handle.addEventListener('lostpointercapture', cancel);
    document.addEventListener('keydown', escape);
  });
  return handle;
}

function report(error) {
  $('#status').textContent = error instanceof Error ? error.message : String(error);
}

function sourceLabel(info) {
  if (info.installType === 'development') return 'Local · unpacked';
  if (/^https:\/\/chrome(webstore\.google\.com|\.google\.com\/webstore)(\/|$)/.test(info.updateUrl || '')) return 'Chrome Web Store';
  // management does not expose fromWebstore. Google's update service is
  // strong evidence of store distribution, but normal alone also includes CRX.
  if (/^https:\/\/clients2\.google\.com\/service\/update2\/crx(?:[/?]|$)/.test(info.updateUrl || '')) return 'Chrome Web Store';
  return { admin: 'Managed by your organization', sideload: 'Installed by other software', normal: 'Installed · source unavailable' }[info.installType] || 'Other installation';
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
  element.title ||= name;
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

function renderCards() {
  const visible = extensions.filter(info => selected.has(info.id));
  if (rearrange) visible.sort((a, b) => {
    const orderA = grouped ? cardOrders.grouped[groupKey(a)] : cardOrders.ungrouped;
    const orderB = grouped ? cardOrders.grouped[groupKey(b)] : cardOrders.ungrouped;
    const rank = (order, id) => order.indexOf(id) < 0 ? Number.MAX_SAFE_INTEGER : order.indexOf(id);
    return rank(orderA, a.id) - rank(orderB, b.id);
  });
  $('#count').textContent = visible.length;
  $('#empty').hidden = visible.length > 0;
  const cards = visible.map(info => {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = info.id;
    card.dataset.group = groupKey(info);
    const heading = document.createElement('div');
    heading.className = 'card-heading';
    const label = document.createElement('label');
    label.className = 'enabled-label';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', `Enable ${info.name}`);
    toggle.checked = info.enabled;
    toggle.disabled = info.enabled ? info.mayDisable === false : info.mayEnable === false;
    toggle.title = toggle.disabled ? 'Controlled by your organization' : info.enabled ? 'Turn off' : 'Turn on';
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        await chrome.management.setEnabled(info.id, toggle.checked);
        $('#status').textContent = `${info.name} ${toggle.checked ? 'enabled' : 'disabled'}.`;
      } catch (error) { report(error); }
      finally { await refresh(); }
    });
    label.append(toggle);
    heading.append(icon(info), identity(info), label);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const options = button('Options', async () => { await chrome.tabs.create({ url: info.optionsUrl }); });
    options.disabled = !info.optionsUrl || !info.enabled;
    options.title = !info.optionsUrl ? 'This extension has no options page' : !info.enabled ? 'Enable this extension to open its options' : 'Open extension options';
    const remove = button('Remove', async () => {
      if (info.id === chrome.runtime.id) {
        await chrome.management.uninstallSelf({ showConfirmDialog: true });
      } else {
        await chrome.management.uninstall(info.id, { showConfirmDialog: true });
      }
      await refresh();
    }, 'remove');
    remove.disabled = info.mayDisable === false;
    const errors = button('Errors ↗', async () => {
      await chrome.tabs.create({ url: `chrome://extensions/?errors=${encodeURIComponent(info.id)}` });
    });
    errors.title = 'Open Chrome’s error reports. This shortcut does not indicate whether errors exist; Developer mode may be required.';
    const restart = button('Restart ↻', async () => {
      if (info.id === chrome.runtime.id) {
        chrome.runtime.reload();
        return;
      }
      try {
        await chrome.management.setEnabled(info.id, false);
        try {
          await chrome.management.setEnabled(info.id, true);
        } catch (error) {
          throw new Error(`${info.name} was turned off but could not be turned back on. Use its enable switch to try again. ${error.message || error}`);
        }
        $('#status').textContent = `${info.name} restarted.`;
      } finally { await refresh(); }
    });
    restart.disabled = !info.enabled || info.mayDisable === false;
    restart.title = !info.enabled ? 'Enable this extension before restarting it' : info.mayDisable === false ? 'Controlled by your organization' : 'Turn off and back on. To reload unpacked file changes, use Chrome’s Reload button.';
    makeIconButton(restart, 'Restart extension', ['M20 7v5h-5', 'M20 12a8 8 0 1 0-2.3 5.7', 'M20 12a8 8 0 0 0-2.3-5.7']);
    if (info.id === chrome.runtime.id) {
      restart.setAttribute('aria-label', 'Reload this extension');
      restart.title = 'Reload Extension Manager Extension and apply file changes';
      toggle.title = 'Turn off this manager. Re-enable it from chrome://extensions.';
    }
    restart.classList.add('restart');
    heading.insertBefore(restart, label);
    const details = makeIconButton(button('Details', () => openDetails(info.id)), 'Details', ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v6', 'M12 7h.01']);
    makeIconButton(options, 'Options', ['M9 3h6l.6 3 2.6 1.5 2.9-.9 3 5.2-2.3 2v3l2.3 2-3 5.2-2.9-.9-2.6 1.5L15 27H9l-.6-3-2.6-1.5-2.9.9-3-5.2 2.3-2v-3l-2.3-2 3-5.2 2.9.9L8.4 6Z', 'M12 10a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z']);
    // Fit the cog's gear and hub in the same 24px view box.
    options.querySelector('svg').setAttribute('viewBox', '-2 1 28 28');
    makeIconButton(errors, 'Errors', ['M10.3 4.2 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z', 'M12 9v5', 'M12 17h.01']);
    makeIconButton(remove, 'Uninstall extension', ['M3 6h18', 'M9 6V3h6v3', 'M5 6l1 15h12l1-15', 'M10 10v7', 'M14 10v7']);
    remove.title = 'Uninstall';
    // Chrome's public API exposes neither error counts nor other extensions'
    // incognito grants. Link to the real setting rather than inventing state.
    const incognito = button('Allow in incognito ↗', () => openDetails(info.id), 'incognito');
    incognito.title = 'Open Chrome settings to view or change Allow in incognito';
    makeIconButton(incognito, 'Allow in incognito', ['M4 10h16', 'M7 10l2-7h6l2 7', 'M3 17a4 4 0 1 0 8 0 4 4 0 0 0-8 0Z', 'M13 17a4 4 0 1 0 8 0 4 4 0 0 0-8 0Z', 'M11 17h2']);
    const hide = makeIconButton(button('', async () => {
      const prefs = await chrome.storage.local.get('selectedIds');
      await chrome.storage.local.set({ selectedIds: (prefs.selectedIds || []).filter(id => id !== info.id) });
      await refresh();
      $('#status').textContent = `${info.name} hidden from this page. Add it back using Choose extensions.`;
    }, 'hide-card'), 'Remove from this page', ['M6 6l12 12', 'M18 6 6 18']);
    hide.title = 'Remove from this page only. Keep the extension installed.';
    actions.append(options, details, errors, incognito, remove);
    if (rearrange) actions.append(dragHandle(card, info));
    actions.append(hide);
    card.append(heading, actions);
    return card;
  });
  $('#cards').classList.toggle('grouped', grouped);
  if (grouped) {
    const definitions = [
      ['Enabled · Local unpacked', info => info.enabled && info.installType === 'development'],
      ['Enabled · Chrome Web Store', info => info.enabled && sourceLabel(info) === 'Chrome Web Store'],
      ['Disabled · Local unpacked', info => !info.enabled && info.installType === 'development'],
      ['Disabled · Chrome Web Store', info => !info.enabled && sourceLabel(info) === 'Chrome Web Store'],
      ['Enabled · Other installations', info => info.enabled && info.installType !== 'development' && sourceLabel(info) !== 'Chrome Web Store'],
      ['Disabled · Other installations', info => !info.enabled && info.installType !== 'development' && sourceLabel(info) !== 'Chrome Web Store'],
    ];
    const sections = [];
    for (const [title, matches] of definitions) {
      const members = cards.filter((_, index) => matches(visible[index]));
      if (!members.length) continue;
      const section = document.createElement('section');
      section.className = 'extension-group';
      section.setAttribute('aria-label', title);
      const heading = document.createElement('h3');
      heading.className = 'group-heading';
      heading.textContent = `${title} (${members.length})`;
      const grid = document.createElement('div');
      grid.className = 'group-grid';
      grid.append(...members);
      section.append(heading, grid);
      sections.push(section);
    }
    $('#cards').replaceChildren(...sections);
  } else {
    $('#cards').replaceChildren(...cards);
  }
  $('#selected-count').textContent = `${visible.length} selected`;
}

function renderChoices() {
  if (savingSelection) return;
  const query = $('#search').value.trim().toLocaleLowerCase();
  const checked = name => new Set([...document.querySelectorAll(`[name="filter-${name}"]:checked`)].map(input => input.value));
  const selection = checked('selection');
  const source = checked('source');
  const status = checked('status');
  const matches = extensions.filter(info => {
    if (!info.name.toLocaleLowerCase().includes(query)) return false;
    if (selection.size && !selection.has(selected.has(info.id) ? 'selected' : 'unselected')) return false;
    if (status.size && !status.has(info.enabled ? 'enabled' : 'disabled')) return false;
    const sourceType = info.installType === 'development' ? 'unpacked' : sourceLabel(info) === 'Chrome Web Store' ? 'store' : 'other';
    return !source.size || source.has(sourceType);
  });
  $('#match-count').textContent = `${matches.length} of ${extensions.length} shown`;
  $('#clear-filters').disabled = !query && !selection.size && !source.size && !status.size;
  $('#no-results').hidden = matches.length > 0;
  $('#choices').replaceChildren(...matches.map(info => {
    const row = document.createElement('label');
    row.className = 'choice';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(info.id);
    check.setAttribute('aria-label', `Show ${info.name}`);
    check.addEventListener('change', async () => {
      savingSelection = true;
      for (const input of $('#choices').querySelectorAll('input')) input.disabled = true;
      const next = new Set(selected);
      if (check.checked) next.add(info.id); else next.delete(info.id);
      try {
        await chrome.storage.local.set({ selectedIds: [...next] });
        selected = next;
        renderCards();
      } catch (error) { check.checked = selected.has(info.id); report(error); }
      finally { savingSelection = false; await refresh(); renderChoices(); }
    });
    const details = identity(info);
    const state = details.querySelector('.extension-state');
    row.append(check, icon(info), details, state);
    return row;
  }));
}

async function refresh() {
  if (dragActive || savingOrder) return;
  const version = ++refreshVersion;
  try {
    const [all, prefs] = await Promise.all([chrome.management.getAll(), chrome.storage.local.get(['selectedIds', 'theme', 'selfIncluded', 'grouped', 'rearrange', 'cardOrders'])]);
    if (version !== refreshVersion) return;
    extensions = all.filter(info => info.type === 'extension').sort((a, b) => a.name.localeCompare(b.name));
    selected = new Set(prefs.selectedIds || []);
    if (!prefs.selfIncluded) {
      selected.add(chrome.runtime.id);
      await chrome.storage.local.set({ selectedIds: [...selected], selfIncluded: true });
      if (version !== refreshVersion) return;
    }
    theme = prefs.theme === 'light' ? 'light' : 'dark';
    grouped = prefs.grouped === true;
    rearrange = prefs.rearrange === true;
    cardOrders = syncOrders(prefs.cardOrders);
    if (JSON.stringify(cardOrders) !== JSON.stringify(prefs.cardOrders)) {
      await chrome.storage.local.set({ cardOrders });
      if (version !== refreshVersion) return;
    }
    $('#rearrange').checked = rearrange;
    for (const radio of document.querySelectorAll('[name="view-mode"]')) radio.checked = radio.value === (grouped ? 'grouped' : 'ungrouped');
    applyTheme();
    renderCards();
    if ($('#picker').open) renderChoices();
  } catch (error) { report(error); }
}

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('#theme').textContent = theme === 'dark' ? '☀' : '☾';
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
  $('#theme').setAttribute('aria-label', label);
  $('#theme').title = label;
}

function openPicker() {
  resetPickerFilters();
  renderChoices();
  $('#picker').showModal();
  $('#search').focus();
}

function resetPickerFilters() {
  $('#search').value = '';
  for (const checkbox of document.querySelectorAll('#picker-filters input')) checkbox.checked = false;
}

$('#choose').addEventListener('click', openPicker);
$('#empty-choose').addEventListener('click', openPicker);
$('#close-picker').addEventListener('click', () => $('#picker').close());
$('#done').addEventListener('click', () => $('#picker').close());
// Chrome 120–133 need an explicit backdrop handler; newer versions use closedby.
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const picker = $('#picker');
  const isOutside = event => {
    const rect = picker.getBoundingClientRect();
    return event.target === picker && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  };
  let startedOutside = false;
  picker.addEventListener('pointerdown', event => { startedOutside = isOutside(event); });
  picker.addEventListener('click', event => {
    if (startedOutside && isOutside(event)) picker.close();
    startedOutside = false;
  });
}
$('#search').addEventListener('input', renderChoices);
$('#picker-filters').addEventListener('change', renderChoices);
$('#clear-filters').addEventListener('click', () => { resetPickerFilters(); renderChoices(); });
$('#rearrange').addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ rearrange: $('#rearrange').checked });
    await refresh();
  } catch (error) { report(error); await refresh(); }
});
for (const radio of document.querySelectorAll('[name="view-mode"]')) radio.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ grouped: radio.value === 'grouped' });
    await refresh();
  } catch (error) { report(error); await refresh(); }
});
$('#chrome-page').addEventListener('click', async () => {
  try { await chrome.tabs.create({ url: 'chrome://extensions/' }); } catch (error) { report(error); }
});
$('#theme').addEventListener('click', async () => {
  try {
    const next = theme === 'dark' ? 'light' : 'dark';
    await chrome.storage.local.set({ theme: next });
    theme = next;
    applyTheme();
  } catch (error) { report(error); }
});

if (globalThis.chrome?.management) {
  for (const event of ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled']) chrome.management[event].addListener(refresh);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.selectedIds || changes.theme || changes.grouped || changes.rearrange || changes.cardOrders)) void refresh();
  });
  window.addEventListener('focus', refresh);
  void refresh();
} else {
  report('Load this folder as an unpacked extension in Chrome, then click its toolbar icon.');
}
