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
let renderAllExtensions = () => {};


function syncOrders(previous) {
  const visible = extensions.filter(info => (selected.has(info.id) || fadingFavorites.has(info.id)) && info.id !== chrome.runtime.id);
  const selectedOrder = [...new Set([...selected, ...fadingFavorites.keys()])].filter(id => visible.some(info => info.id === id));
  const reconcile = (old, ids) => {
    const retained = [...new Set(Array.isArray(old) ? old : [])].filter(id => ids.includes(id));
    return [...retained, ...ids.filter(id => !retained.includes(id))];
  };
  const next = { ungrouped: reconcile(previous?.ungrouped, selectedOrder), grouped: {} };
  for (const [key] of EXTENSION_GROUPS) {
    const ids = selectedOrder.filter(id => groupKey(visible.find(info => info.id === id)) === key);
    next.grouped[key] = reconcile(previous?.grouped?.[key], ids);
  }
  return next;
}

async function moveCard(card, target, focusHandle = false, mode = 'move') {
  if (savingOrder || !rearrange || !target || card === target || card.parentElement !== target.parentElement) return;
  const siblings = [...card.parentElement.children].filter(element => element.classList.contains('card'));
  const ids = siblings.map(element => element.dataset.id);
  const from = ids.indexOf(card.dataset.id);
  const to = ids.indexOf(target.dataset.id);
  if (mode === 'swap') {
    [ids[from], ids[to]] = [ids[to], ids[from]];
  } else {
    ids.splice(from, 1);
    ids.splice(to, 0, card.dataset.id);
  }
  await saveCardOrder(card, ids, focusHandle);
}

async function saveCardOrder(card, ids, focusHandle = false) {
  const next = structuredClone(cardOrders);
  const original = grouped ? next.grouped[card.dataset.group] : next.ungrouped;
  const moved = new Set(ids);
  let index = 0;
  const merged = original.map(id => moved.has(id) ? ids[index++] : id);
  while (index < ids.length) merged.push(ids[index++]);
  if (grouped) next.grouped[card.dataset.group] = merged;
  else next.ungrouped = merged;
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

function cardDropAt(card, x, y) {
  const grid = card.parentElement;
  const bounds = grid.getBoundingClientRect();
  if (x < bounds.left - 16 || x > bounds.right + 16 || y < bounds.top - 8 || y > bounds.bottom + 8) return null;
  const items = [...grid.children].filter(element => element.classList.contains('card')).map((element, index) => ({ element, index, rect: element.getBoundingClientRect() }));
  const rows = [];
  for (const item of items) {
    const row = rows.find(row => Math.abs(row.top - item.rect.top) < 2);
    if (row) { row.items.push(item); row.bottom = Math.max(row.bottom, item.rect.bottom); }
    else rows.push({ top: item.rect.top, bottom: item.rect.bottom, items: [item] });
  }
  const insertion = (index, left, top, width, height) => ({ mode: 'insert', index, marker: { left, top, width, height } });
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (y >= row.top - (rowIndex === 0 ? 8 : 0) && y <= row.bottom + (rowIndex === rows.length - 1 ? 8 : 0)) {
      const before = item => insertion(item.index, item.rect.left - 7, row.top, 3, row.bottom - row.top);
      const after = item => insertion(item.index + 1, item.rect.right + 4, row.top, 3, row.bottom - row.top);
      if (x < row.items[0].rect.left) return before(row.items[0]);
      for (let i = 0; i < row.items.length; i++) {
        const item = row.items[i];
        if (x <= item.rect.right) {
          if (x < item.rect.left) {
            const previous = row.items[i - 1];
            return insertion(item.index, (previous.rect.right + item.rect.left) / 2 - 1.5, row.top, 3, row.bottom - row.top);
          }
          const edge = Math.min(24, item.rect.width * .1);
          if (x < item.rect.left + edge) return before(item);
          if (x > item.rect.right - edge) return after(item);
          return item.element === card ? null : { mode: 'swap', target: item.element };
        }
      }
      return after(row.items[row.items.length - 1]);
    }
    const next = rows[rowIndex + 1];
    if (next && y > row.bottom && y < next.top) return insertion(next.items[0].index, bounds.left, (row.bottom + next.top) / 2 - 1.5, bounds.width, 3);
  }
  return null;
}

async function insertCard(card, index) {
  if (savingOrder || !rearrange) return;
  const ids = [...card.parentElement.children].map(element => element.dataset.id);
  const from = ids.indexOf(card.dataset.id);
  ids.splice(from, 1);
  ids.splice(index > from ? index - 1 : index, 0, card.dataset.id);
  await saveCardOrder(card, ids, true);
}

function dragHandle(card, info) {
  const handle = document.createElement('button');
  handle.className = 'drag-handle';
  makeIconButton(handle, `Rearrange ${info.name}`, ['M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01']);
  handle.title = 'Rearrange';
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
    let placement = null;
    let indicator = null;
    dragActive = true;
    handle.setPointerCapture(event.pointerId);
    const cleanup = () => {
      ghost?.remove();
      card.classList.remove('is-dragging');
      placement?.target?.classList.remove('drop-target');
      indicator?.remove();
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
      placement?.target?.classList.remove('drop-target');
      indicator?.remove();
      placement = cardDropAt(card, current.clientX, current.clientY);
      if (placement?.mode === 'swap') placement.target.classList.add('drop-target');
      if (placement?.mode === 'insert') {
        indicator = document.createElement('div');
        indicator.className = 'drop-insert-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        for (const [key, value] of Object.entries(placement.marker)) indicator.style[key] = `${value}px`;
        document.body.append(indicator);
      }
      if (current.clientY < 55) window.scrollBy(0, -18);
      else if (current.clientY > innerHeight - 55) window.scrollBy(0, 18);
    };
    const finish = async () => {
      const destination = placement;
      cleanup();
      if (destination?.mode === 'swap') await moveCard(card, destination.target, true, 'swap');
      else if (destination?.mode === 'insert') await insertCard(card, destination.index);
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







function renderCards() {
  $('#reset-order').hidden = !rearrange;
  const chosen = extensions.filter(info => selected.has(info.id));
  const selectedExtensions = extensions.filter(info => info.id !== chrome.runtime.id && (selected.has(info.id) || fadingFavorites.has(info.id)));
  const query = $('#page-selected-search').value.trim().toLocaleLowerCase();
  const visible = selectedExtensions.filter(info => info.name.toLocaleLowerCase().includes(query));
  if (rearrange) visible.sort((a, b) => {
    const orderA = grouped ? cardOrders.grouped[groupKey(a)] : cardOrders.ungrouped;
    const orderB = grouped ? cardOrders.grouped[groupKey(b)] : cardOrders.ungrouped;
    const rank = (order, id) => order.indexOf(id) < 0 ? Number.MAX_SAFE_INTEGER : order.indexOf(id);
    return rank(orderA, a.id) - rank(orderB, b.id);
  });
  $('#count').textContent = chosen.filter(info => info.id !== chrome.runtime.id).length;
  $('#empty').hidden = selectedExtensions.length > 0;
  $('#cards-no-results').hidden = visible.length > 0 || selectedExtensions.length === 0;
  const makeCard = info => {
    const card = document.createElement('article');
    card.className = 'card';
    if (!selected.has(info.id)) fadeFavorite(card, info.id);
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
    toggle.title = toggle.disabled ? 'Managed' : info.enabled ? 'Disable' : 'Enable';
    toggle.addEventListener('change', async () => {
      if (info.id === chrome.runtime.id && !toggle.checked &&
          !confirm('Turn off the Extension Manager Extension extension? Turning off this extension will close this extension’s extension page. You can turn the extension back on using Chrome’s extension manager.')) {
        toggle.checked = true;
        return;
      }
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
    options.title = !info.optionsUrl ? 'No options' : !info.enabled ? 'Enable first' : 'Options';
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
    errors.title = 'Errors';
    const restart = button('Restart ↻', async () => {
      if (info.id === chrome.runtime.id) {
        if (!confirm('Reload the Extension Manager Extension extension? Reloading this extension will close this extension’s extension page. You can reopen the extension page using the extension’s extension icon.')) return;
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
    restart.title = !info.enabled ? 'Enable first' : info.mayDisable === false ? 'Managed' : 'Reload';
    makeIconButton(restart, 'Restart extension', ['M3 12a9 9 0 0 1 15.36-6.36L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-15.36 6.36L3 16', 'M3 21v-5h5']);
    if (info.id === chrome.runtime.id) {
      restart.setAttribute('aria-label', 'Reload this extension');
      restart.title = 'Reload';
      toggle.title = 'Disable';
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
    const hide = makeIconButton(button('', async () => {
      const prefs = await chrome.storage.local.get('selectedIds');
      const next = new Set(prefs.selectedIds || []);
      if (next.has(info.id)) next.delete(info.id); else next.add(info.id);
      next.add(chrome.runtime.id);
      await chrome.storage.local.set({ selectedIds: [...next] });
      await refresh();
      burstFavoriteStar([...document.querySelectorAll('#cards .card')].find(card => card.dataset.id === info.id)?.querySelector('.hide-card'));
      $('#status').textContent = `${info.name} ${next.has(info.id) ? 'added to' : 'removed from'} Favorites.`;
    }, 'hide-card'), selected.has(info.id) ? 'Remove from Favorites' : 'Add to Favorites', ['m12 3 2.8 5.7 6.3.9-4.55 4.43 1.08 6.27L12 17.34l-5.63 2.96 1.08-6.27L2.9 9.6l6.3-.9Z']);
    hide.title = selected.has(info.id) ? 'Unfavorite' : 'Favorite';
    hide.setAttribute('aria-pressed', String(selected.has(info.id)));
    actions.append(options, details, errors, remove);
    if (rearrange && info.id !== chrome.runtime.id) actions.append(dragHandle(card, info));
    if (info.id !== chrome.runtime.id) actions.append(hide);
    card.append(heading, actions);
    return card;
  };
  const cards = visible.map(makeCard);
  const remaining = extensions.filter(info => info.id !== chrome.runtime.id);
  $('#page-all-count').textContent = `(${remaining.length})`;
  renderAllExtensions = () => {
    if (!$('#page-all-extensions').open) { $('#page-all-list').replaceChildren(); return; }
    const query = $('#page-all-search').value.trim().toLocaleLowerCase();
    const matches = remaining.filter(info => info.name.toLocaleLowerCase().includes(query));
    $('#page-all-empty').hidden = matches.length > 0;
    const compactRow = info => {
      const original = makeCard(info);
      const row = document.createElement('div');
      row.className = 'all-extension-row';
      row.dataset.id = info.id;
      const link = document.createElement('a');
      link.className = 'all-extension-link';
      link.setAttribute('aria-label', `Options for ${info.name}`);
      link.title = !info.optionsUrl ? 'No options' : !info.enabled ? 'Enable first' : 'Options';
      if (info.enabled && info.optionsUrl) {
        link.href = info.optionsUrl;
        link.addEventListener('click', async event => { event.preventDefault(); try { await chrome.tabs.create({ url: info.optionsUrl }); } catch (error) { report(error); } });
      } else link.setAttribute('aria-disabled', 'true');
      const identity = original.querySelector('.identity');
      identity.querySelector('.extension-state').remove();
      link.append(original.querySelector('.icon'), identity);
      const controls = document.createElement('div');
      controls.className = 'all-extension-controls';
      const isFavorite = selected.has(info.id);
      const add = makeIconButton(button('', async () => {
        const prefs = await chrome.storage.local.get('selectedIds');
        const next = new Set(prefs.selectedIds || []);
        next.add(chrome.runtime.id);
        if (next.has(info.id)) next.delete(info.id);
        else next.add(info.id);
        await chrome.storage.local.set({ selectedIds: [...next] });
        await refresh();
        const favoriteButton = [...document.querySelectorAll('#page-all-list .all-extension-row')].find(element => element.dataset.id === info.id)?.querySelector('.add-extension');
        burstFavoriteStar(favoriteButton);
        $('#status').textContent = `${info.name} ${next.has(info.id) ? 'added to' : 'removed from'} Favorites.`;
      }, 'add-extension'), isFavorite ? 'Remove from Favorites' : 'Add to Favorites', ['m12 3 2.8 5.7 6.3.9-4.55 4.43 1.08 6.27L12 17.34l-5.63 2.96 1.08-6.27L2.9 9.6l6.3-.9Z']);
      add.title = isFavorite ? 'Unfavorite' : 'Favorite';
      add.setAttribute('aria-pressed', String(isFavorite));
      add.classList.toggle('is-favorite', isFavorite);
      controls.append(
        original.querySelector('[aria-label="Options"]'),
        original.querySelector('[aria-label="Details"]'),
        original.querySelector('[aria-label="Errors"]'),
        original.querySelector('[aria-label="Uninstall extension"]'),
        original.querySelector('.restart'),
        original.querySelector('.enabled-label')
      );
      row.append(add, link, controls);
      return row;
    };
    if (!grouped) $('#page-all-list').replaceChildren(...matches.map(compactRow));
    else {
      const sections = [];
      for (const [key, title] of EXTENSION_GROUPS) {
        const members = matches.filter(info => groupKey(info) === key);
        if (!members.length) continue;
        const section = document.createElement('section');
        section.className = 'extension-group';
        const heading = document.createElement('h3');
        heading.className = 'group-heading';
        heading.textContent = title;
        section.append(heading, ...members.map(compactRow));
        sections.push(section);
      }
      $('#page-all-list').replaceChildren(...sections);
    }
  };
  renderAllExtensions();
  const self = extensions.find(info => info.id === chrome.runtime.id);
  $('#manager-controls').replaceChildren();
  if (self) {
    const selfCard = makeCard(self);
    selfCard.querySelector('[aria-label="Options"]').remove();
    $('#manager-controls').append(selfCard.querySelector('.restart'), selfCard.querySelector('.enabled-label'), ...selfCard.querySelector('.card-actions').children);
  }
  $('#cards').classList.toggle('grouped', grouped);
  if (grouped) {
    const sections = [];
    for (const [key, title] of EXTENSION_GROUPS) {
      const members = cards.filter((_, index) => groupKey(visible[index]) === key);
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
  $('#selected-count').textContent = `${chosen.length} selected`;
}

function renderChoices() {
  if (savingSelection) return;
  const query = $('#search').value.trim().toLocaleLowerCase();
  const checked = name => new Set([...document.querySelectorAll(`[name="filter-${name}"]:checked`)].map(input => input.value));
  const selection = checked('selection');
  const source = checked('source');
  const status = checked('status');
  const pinManager = !query && !selection.size && !source.size && !status.size;
  const matches = extensions.filter(info => {
    if (!info.name.toLocaleLowerCase().includes(query)) return false;
    if (selection.size && !selection.has(selected.has(info.id) ? 'selected' : 'unselected')) return false;
    if (status.size && !status.has(info.enabled ? 'enabled' : 'disabled')) return false;
    const sourceType = info.installType === 'development' ? 'unpacked' : sourceLabel(info) === 'Chrome Web Store' ? 'store' : 'other';
    return !source.size || source.has(sourceType);
  }).sort((a, b) => (pinManager ? Number(b.id === chrome.runtime.id) - Number(a.id === chrome.runtime.id) : 0) || a.name.localeCompare(b.name));
  $('#match-count').textContent = `${matches.length} of ${extensions.length} shown`;
  $('#clear-filters').disabled = !query && !selection.size && !source.size && !status.size;
  $('#no-results').hidden = matches.length > 0;
  $('#choices').replaceChildren(...matches.map(info => {
    const row = document.createElement('label');
    row.className = 'choice';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(info.id);
    check.disabled = info.id === chrome.runtime.id;
    if (check.disabled) check.title = 'Always selected';
    check.setAttribute('aria-label', `Show ${info.name}`);
    check.addEventListener('change', async () => {
      if (info.id === chrome.runtime.id) { check.checked = true; return; }
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
    const nextSelection = new Set(prefs.selectedIds || []);
    trackFavoriteRemovals(selected, nextSelection, refresh);
    selected = nextSelection;
    if (!selected.has(chrome.runtime.id) || !prefs.selfIncluded) {
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
    const restoreListPosition = $('#picker').open ? () => {} : preserveListPosition(document, '#page-all-list .all-extension-row', '#page-all-extensions[open] > summary');
    renderCards();
    restoreListPosition();
    if ($('#picker').open) renderChoices();
  } catch (error) { report(error); }
}

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('#theme').textContent = theme === 'dark' ? '☀' : '☾';
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode';
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
  $('#picker-search-clear').hidden = true;
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
$('#search').addEventListener('input', () => {
  $('#picker-search-clear').hidden = !$('#search').value;
  renderChoices();
});
$('#picker-search-clear').addEventListener('click', () => {
  $('#search').value = '';
  $('#picker-search-clear').hidden = true;
  renderChoices();
  $('#search').focus({ preventScroll: true });
});
$('#page-all-extensions').addEventListener('toggle', () => renderAllExtensions());
$('#page-all-search').addEventListener('input', () => renderAllExtensions());
$('#page-selected-search').addEventListener('input', renderCards);
for (const wrapper of document.querySelectorAll('.page-search-control')) {
  const input = wrapper.querySelector('input');
  const clear = wrapper.querySelector('button');
  input.addEventListener('input', () => { clear.hidden = !input.value; });
  clear.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus({ preventScroll: true });
  });
}
$('#picker-filters').addEventListener('change', renderChoices);
$('#clear-filters').addEventListener('click', () => { resetPickerFilters(); renderChoices(); });
$('#rearrange').addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ rearrange: $('#rearrange').checked });
    await refresh();
  } catch (error) { report(error); await refresh(); }
});
$('#reset-order').addEventListener('click', async () => {
  if (!rearrange || savingOrder || dragActive) return;
  const next = structuredClone(cardOrders);
  const alphabetical = extensions.filter(info => selected.has(info.id) && info.id !== chrome.runtime.id).map(info => info.id);
  if (grouped) {
    for (const [key] of EXTENSION_GROUPS) next.grouped[key] = extensions.filter(info => selected.has(info.id) && info.id !== chrome.runtime.id && groupKey(info) === key).map(info => info.id);
  } else {
    next.ungrouped = alphabetical;
  }
  savingOrder = true;
  $('#reset-order').disabled = true;
  try {
    await chrome.storage.local.set({ cardOrders: next });
    cardOrders = next;
    $('#status').textContent = 'Card order reset to alphabetical.';
  } catch (error) { report(error); }
  finally {
    savingOrder = false;
    $('#reset-order').disabled = false;
    await refresh();
  }
});
for (const radio of document.querySelectorAll('[name="view-mode"]')) radio.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ grouped: radio.value === 'grouped' });
    await refresh();
  } catch (error) { report(error); await refresh(); }
});
setupChromeShortcuts($('#chrome-page'), $('#developer-dashboard'));
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
