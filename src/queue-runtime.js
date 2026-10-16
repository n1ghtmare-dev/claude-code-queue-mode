/*
 * Claude Queue — Codex-style follow-up queue for the Claude Code webview.
 *
 * Injected at the top of webview/index.js by patch.js. It does not depend on
 * minified names: sessions are found through React fibers (prop `session`),
 * the UI is mounted into the composer's `inputContainer_*` element, and the
 * session's own methods (send / interrupt) are wrapped at runtime.
 *
 * Modes (setting claudeCode.followUpQueueMode):
 *   queue     — messages sent while Claude works wait in a list above the composer
 *               and are sent one by one, each as a new turn, when Claude is idle;
 *   steer     — messages go into the running turn right away (stock behaviour);
 *   interrupt — the running turn is stopped and the new message runs at once.
 * Ctrl+Enter (Ctrl+Shift+Enter when "Use Ctrl+Enter to send" is on) does the
 * opposite of the mode for one message.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.__claudeQueue) return;

  var VERSION = '__CQ_VERSION__';
  var LS_PREFIX = 'claude-queue:v1:';
  var MODES = ['queue', 'steer', 'interrupt'];
  var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
  var MOD = IS_MAC ? '⌘' : 'Ctrl';
  var STOCK_BUSY_PLACEHOLDER = 'Queue another message…';
  var PLACEHOLDERS = {
    queue: STOCK_BUSY_PLACEHOLDER,
    steer: 'Steer the current run…',
    interrupt: 'Interrupt and send a new message…'
  };
  var COMPOSER_SEL = '[role="textbox"][aria-label="Message input"]';

  var states = new WeakMap();
  var allStates = new Set();
  var modeOverride = null; // {value, at} until the host echoes the new setting back
  var synthetic = false;
  var scanQueued = false;
  var openMenu = null; // {st, itemId, el}

  function log() {
    try { console.warn.apply(console, ['[claude-queue]'].concat([].slice.call(arguments))); } catch (e) { /* ignore */ }
  }

  function peek(sig) {
    if (!sig) return undefined;
    try { return typeof sig.peek === 'function' ? sig.peek() : sig.value; } catch (e) { return undefined; }
  }

  function uid() {
    try { return crypto.randomUUID(); } catch (e) { return 'cq-' + Date.now().toString(36) + Math.random().toString(36).slice(2); }
  }

  function isSession(o) {
    return !!o && typeof o === 'object' && typeof o.send === 'function' &&
      typeof o.interrupt === 'function' && !!o.busy && typeof o.busy === 'object' && 'value' in o.busy;
  }

  function isRunning(s) {
    try { return !!s.turnRunningOrQueued || (s.sendsInFlight | 0) > 0; } catch (e) { return !!peek(s.busy); }
  }

  function sameSel(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }

  function errText(e) {
    return (e && e.message) ? String(e.message) : String(e);
  }

  // ---------------------------------------------------------------- settings

  function configOf(s) {
    var c = peek(s.config);
    if (c === undefined) {
      var conn = peek(s.connection);
      c = conn && peek(conn.config);
    }
    return c || {};
  }

  function getMode(st) {
    var v = configOf(st.session).followUpQueueMode;
    if (modeOverride) {
      if (v === modeOverride.value || Date.now() - modeOverride.at > 5000) modeOverride = null;
      else return modeOverride.value;
    }
    return MODES.indexOf(v) >= 0 ? v : 'queue';
  }

  function setMode(st, mode) {
    modeOverride = { value: mode, at: Date.now() };
    try {
      var conn = peek(st.session.connection);
      if (conn && typeof conn.send === 'function') conn.send({ type: 'cq_set_mode', mode: mode });
    } catch (e) { log('could not save mode', e); }
    allStates.forEach(function (x) { render(x); refreshPlaceholder(x); });
  }

  function useCtrlEnter(s) {
    return !!configOf(s).useCtrlEnterToSend;
  }

  function invertOf(action) {
    return action === 'queue' ? 'steer' : 'queue';
  }

  function actionLabel(a) {
    return a === 'queue' ? 'Queue' : a === 'steer' ? 'Steer' : 'Interrupt & send';
  }

  function shortcuts(s) {
    return useCtrlEnter(s)
      ? { send: MOD + '+Enter', invert: MOD + '+Shift+Enter' }
      : { send: 'Enter', invert: MOD + '+Enter' };
  }

  // ------------------------------------------------------------------- state

  function stateFor(s) {
    var st = states.get(s);
    if (!st) {
      st = {
        session: s, items: [], paused: null, draining: false, host: null,
        editAnchor: null, invertAt: 0, loadedKey: null,
        attached: false, rawSend: null, rawInterrupt: null, drainTimer: 0, dragging: false
      };
      states.set(s, st);
    }
    return st;
  }

  function attach(s) {
    var st = stateFor(s);
    if (st.attached) return st;
    st.attached = true;
    allStates.add(st);

    var origSend = s.send;
    st.rawSend = function () { return origSend.apply(s, arguments); };
    s.send = function () {
      var args = [].slice.call(arguments);
      var handled = false;
      try { handled = intercept(st, args); } catch (e) { log('intercept failed', e); }
      if (handled) return Promise.resolve();
      return origSend.apply(this, args);
    };

    var origInterrupt = s.interrupt;
    st.rawInterrupt = function () { return origInterrupt.apply(s, arguments); };
    s.interrupt = function () {
      try { onUserInterrupt(st); } catch (e) { log('interrupt hook failed', e); }
      return origInterrupt.apply(this, arguments);
    };

    try { s.busy.subscribe(function (busy) { if (!busy) scheduleDrain(st, 400); refreshPlaceholder(st); }); } catch (e) { log(e); }
    try { if (s.sessionId && s.sessionId.subscribe) s.sessionId.subscribe(function () { ensureLoaded(st); }); } catch (e) { log(e); }
    ensureLoaded(st);
    return st;
  }

  // ----------------------------------------------------------- persistence

  function storageKey(st) {
    var id = peek(st.session.sessionId);
    return id ? LS_PREFIX + id : null;
  }

  function serializeItem(it) {
    return {
      id: it.id, text: it.text, sel: it.sel, origin: it.origin, opts: it.opts, createdAt: it.createdAt, error: it.error,
      atts: (it.atts || []).map(function (a) {
        var f = a && a.file;
        return { name: f && f.name, type: f && f.type, lastModified: f && f.lastModified, dataUrl: a && a.dataUrl };
      })
    };
  }

  function dataUrlToFile(dataUrl, name, type, lastModified) {
    var comma = dataUrl.indexOf(',');
    var meta = dataUrl.slice(0, comma);
    var body = dataUrl.slice(comma + 1);
    var bytes;
    if (/;base64/i.test(meta)) {
      var bin = atob(body);
      bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    return new File([bytes], name || 'attachment', { type: type || meta.replace(/^data:/, '').split(';')[0], lastModified: lastModified || Date.now() });
  }

  function deserializeItem(o) {
    if (!o || typeof o.text !== 'string') return null;
    var atts = [];
    (o.atts || []).forEach(function (a) {
      if (!a || typeof a.dataUrl !== 'string') return;
      try { atts.push({ file: dataUrlToFile(a.dataUrl, a.name, a.type, a.lastModified), dataUrl: a.dataUrl }); } catch (e) { log('attachment restore failed', e); }
    });
    return { id: o.id || uid(), text: o.text, sel: o.sel, origin: o.origin || { kind: 'human' }, opts: o.opts, createdAt: o.createdAt || Date.now(), error: o.error, atts: atts };
  }

  function save(st) {
    var k = storageKey(st);
    if (!k) return;
    try {
      if (!st.items.length) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify({ v: 1, paused: st.paused, items: st.items.map(serializeItem) }));
    } catch (e) { log('could not persist queue', e); }
  }

  function ensureLoaded(st) {
    var k = storageKey(st);
    if (!k || st.loadedKey === k) return;
    var oldKey = st.loadedKey;
    st.loadedKey = k;
    if (st.items.length) {
      // The session got a new id: the queue moves with it.
      if (oldKey) { try { localStorage.removeItem(oldKey); } catch (e) { /* ignore */ } }
      save(st);
      return;
    }
    try {
      var raw = localStorage.getItem(k);
      if (!raw) return;
      var data = JSON.parse(raw);
      var items = (data.items || []).map(deserializeItem).filter(Boolean);
      if (!items.length) return;
      st.items = items;
      st.paused = 'restored'; // never auto-send right after a reload
      render(st);
    } catch (e) { log('could not restore queue', e); }
  }

  function changed(st) {
    render(st);
    save(st);
  }

  // ------------------------------------------------------------------ logic

  function consumeInvert(st) {
    var v = st.invertAt && Date.now() - st.invertAt < 600;
    st.invertAt = 0;
    return !!v;
  }

  function makeItem(st, args) {
    var s = st.session;
    var text = args[0], atts = args[1], includeSelection = args[2], origin = args[3], opts = args[4];
    var sel;
    if (includeSelection) {
      var cur = peek(s.selection);
      if (cur && !sameSel(s.lastSentSelection, cur)) { sel = cur; s.lastSentSelection = cur; }
    }
    var copy;
    if (opts && typeof opts === 'object') { copy = {}; for (var k in opts) copy[k] = opts[k]; }
    return {
      id: uid(), text: text, atts: Array.isArray(atts) ? atts.slice() : [], sel: sel,
      origin: origin ? { kind: origin.kind } : { kind: 'human' }, opts: copy, createdAt: Date.now()
    };
  }

  // Returns true when the message was taken over (queued or held for a dialog).
  function intercept(st, args) {
    var s = st.session;
    var text = args[0], origin = args[3];
    if (!origin || origin.kind !== 'human' || typeof text !== 'string') return false;
    if (text.trimStart().charAt(0) === '/') return false; // slash commands keep stock behaviour
    ensureLoaded(st);
    var invert = consumeInvert(st);
    var anchor = st.editAnchor;
    st.editAnchor = null;

    if (!isRunning(s)) {
      if (st.paused && st.items.length) {
        openSendDialog(st, makeItem(st, args));
        return true;
      }
      return false;
    }

    var action = anchor ? 'queue' : getMode(st);
    if (invert) action = invertOf(action);
    if (action === 'queue') {
      insertItem(st, makeItem(st, args), anchor);
      return true;
    }
    if (action === 'interrupt') {
      // Same as pressing Stop (the transcript gets "[Request interrupted by user]"),
      // but without pausing the queue; the CLI runs the message right after the abort.
      try { st.rawInterrupt(); } catch (e) { log('interrupt failed', e); }
    }
    return false; // steer / interrupt: the stock send delivers it to the running process
  }

  function insertItem(st, item, anchor) {
    var idx = st.items.length;
    if (anchor) {
      var ni = anchor.next ? indexOf(st, anchor.next) : -1;
      var pi = anchor.prev ? indexOf(st, anchor.prev) : -1;
      if (ni >= 0) idx = ni;
      else if (pi >= 0) idx = pi + 1;
      else if (!anchor.prev) idx = 0;
    }
    item.isNew = true;
    st.items.splice(idx, 0, item);
    changed(st);
  }

  function indexOf(st, id) {
    for (var i = 0; i < st.items.length; i++) if (st.items[i].id === id) return i;
    return -1;
  }

  function removeItem(st, id) {
    var i = indexOf(st, id);
    if (i < 0) return null;
    return st.items.splice(i, 1)[0];
  }

  function sendItem(st, item) {
    var s = st.session;
    var restore = null;
    if (item.sel && s.selection) {
      var prevSel = peek(s.selection);
      s.lastSentSelection = undefined;
      s.selection.value = item.sel;
      restore = function () { s.selection.value = prevSel; s.lastSentSelection = item.sel; };
    }
    var p;
    try {
      p = st.rawSend(item.text, item.atts, !!item.sel, item.origin || { kind: 'human' }, item.opts ? Object.assign({}, item.opts) : undefined);
    } catch (e) {
      p = Promise.reject(e);
    } finally {
      if (restore) { try { restore(); } catch (e) { log(e); } }
    }
    return Promise.resolve(p);
  }

  function scheduleDrain(st, ms) {
    if (!st.items.length) return;
    clearTimeout(st.drainTimer);
    st.drainTimer = setTimeout(function () { drain(st); }, ms || 0);
  }

  function drain(st) {
    var s = st.session;
    if (st.draining || st.paused || !st.items.length) return;
    if (isRunning(s)) return;
    if (peek(s.heldElsewhere) || peek(s.isLoading)) return;
    if (peek(s.error)) {
      st.paused = 'error';
      changed(st);
      return;
    }
    var item = st.items[0];
    if (item.error) return;
    st.draining = true;
    st.items.shift();
    changed(st);
    sendItem(st, item).catch(function (e) {
      item.error = errText(e);
      st.items.unshift(item);
    }).then(function () {
      st.draining = false;
      changed(st);
    });
  }

  function onUserInterrupt(st) {
    if (!st.session.turnRunningOrQueued) return;
    if (st.items.length && !st.paused) {
      st.paused = 'interrupted';
      changed(st);
    }
  }

  function resume(st) {
    st.paused = null;
    changed(st);
    scheduleDrain(st, 0);
  }

  // "Steer" on a queued item: into the running turn, or a new turn when idle.
  function steerItem(st, item) {
    var i = indexOf(st, item.id);
    if (i < 0) return;
    st.items.splice(i, 1);
    delete item.error;
    changed(st);
    sendItem(st, item).catch(function (e) {
      item.error = errText(e);
      st.items.splice(Math.min(i, st.items.length), 0, item);
      changed(st);
    });
  }

  function editItem(st, item) {
    var s = st.session;
    var i = indexOf(st, item.id);
    if (i < 0) return;
    st.editAnchor = {
      prev: i > 0 ? st.items[i - 1].id : null,
      next: i < st.items.length - 1 ? st.items[i + 1].id : null
    };
    st.items.splice(i, 1);
    changed(st);
    try {
      if (item.atts && item.atts.length && s.composerAttachments) s.composerAttachments.value = item.atts.slice();
      if (s.initialPrompt) s.initialPrompt.value = item.text;
    } catch (e) { log('could not restore message into the composer', e); }
    setTimeout(function () { focusComposer(st); }, 50);
  }

  function deleteItem(st, item) {
    if (removeItem(st, item.id)) changed(st);
  }

  function focusComposer(st) {
    var c = st.host && st.host.parentElement && st.host.parentElement.querySelector(COMPOSER_SEL);
    if (!c) return;
    try {
      c.focus();
      var r = document.createRange();
      r.selectNodeContents(c);
      r.collapse(false);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------- DOM

  function h(tag, cls, attrs, children) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (attrs) for (var k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }

  var ICON = {
    arrow: '<svg class="cq-arrow" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5v5a2.5 2.5 0 0 0 2.5 2.5H13"/><path d="M10 7l3 3-3 3"/></svg>',
    grip: '<svg class="cq-grip" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="6" cy="3.5" r="1.1"/><circle cx="10" cy="3.5" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12.5" r="1.1"/><circle cx="10" cy="12.5" r="1.1"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11"/><path d="M6 4V2.8c0-.4.3-.8.8-.8h2.4c.5 0 .8.4.8.8V4"/><path d="M3.8 4l.7 9.2c0 .5.5.8 1 .8h5c.5 0 .9-.3 1-.8l.7-9.2"/><path d="M6.7 6.8v4.4M9.3 6.8v4.4"/></svg>',
    more: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.5" cy="8" r="1.25"/></svg>',
    warn: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8l6.4 11.4H1.6z"/><path d="M8 6.2v3.2"/><path d="M8 11.6v.1"/></svg>',
    clip: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 7.5l-5.6 5.6a3.5 3.5 0 0 1-5-5l5.9-5.9a2.3 2.3 0 0 1 3.3 3.3l-5.9 5.9a1.2 1.2 0 0 1-1.7-1.7l5.3-5.3"/></svg>',
    edit: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11.2 2.3l2.5 2.5-8.2 8.2-3 .5.5-3z"/></svg>',
    queue: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h7"/></svg>'
  };

  function render(st) {
    var host = st.host;
    if (!host || st.dragging) return;
    if (openMenu && openMenu.st === st) closeMenu();
    host.textContent = '';
    if (!st.items.length) { host.removeAttribute('data-active'); return; }
    host.setAttribute('data-active', '');

    var panel = h('div', 'cq-panel');
    if (st.paused) {
      var reason = st.paused === 'interrupted' ? 'Queue paused because you interrupted'
        : st.paused === 'error' ? 'Queue paused because Claude stopped with an error'
        : 'Queue paused';
      panel.appendChild(h('div', 'cq-paused', null, [
        h('span', null, { text: reason }),
        h('button', 'cq-btn', { type: 'button', text: 'Resume', onclick: function (e) { e.preventDefault(); resume(st); } })
      ]));
    }
    var list = h('div', 'cq-list', { role: 'list', 'aria-label': 'Queued messages' });
    st.items.forEach(function (item) { list.appendChild(renderRow(st, item)); });
    panel.appendChild(list);
    host.appendChild(panel);
  }

  function renderRow(st, item) {
    var firstLine = (item.text || '').split(/\r?\n/).filter(function (l) { return l.trim(); })[0] || '';
    var n = (item.atts || []).length;
    var textEl = firstLine
      ? h('span', 'cq-text', { text: firstLine, title: item.text })
      : h('span', 'cq-text cq-muted', { text: n ? n + (n === 1 ? ' attachment' : ' attachments') : 'Empty message' });

    var steerBtn = h('button', 'cq-btn cq-steer', {
      type: 'button',
      text: item.error ? 'Retry' : 'Steer',
      title: item.error ? 'Try sending this queued message again\nEdit or delete it if retry keeps failing' : 'Submit without interrupting the model',
      onclick: function (e) { e.preventDefault(); e.stopPropagation(); steerItem(st, item); }
    });
    var delBtn = h('button', 'cq-icon-btn', {
      type: 'button', 'aria-label': 'Delete queued message', title: 'Delete queued message', html: ICON.trash,
      onclick: function (e) { e.preventDefault(); e.stopPropagation(); deleteItem(st, item); }
    });
    var moreBtn = h('button', 'cq-icon-btn', {
      type: 'button', 'aria-label': 'Queued message actions', title: 'More actions', 'aria-haspopup': 'menu', html: ICON.more,
      onclick: function (e) { e.preventDefault(); e.stopPropagation(); toggleMenu(st, item, moreBtn); }
    });

    var row = h('div', 'cq-row' + (item.isNew ? ' cq-new' : ''), { role: 'listitem', 'data-id': item.id }, [
      h('span', 'cq-lead', { html: ICON.arrow + ICON.grip, 'aria-hidden': 'true' }),
      textEl,
      n && firstLine ? h('span', 'cq-badge', { html: ICON.clip + '<span>' + n + '</span>', title: n + (n === 1 ? ' attachment' : ' attachments') }) : null,
      item.error ? h('span', 'cq-warn', {
        html: ICON.warn,
        title: 'This queued message could not be sent\n' + item.error + '\nRetry, edit, or delete it to continue the queue'
      }) : null,
      h('span', 'cq-actions', null, [steerBtn, delBtn, moreBtn])
    ]);
    delete item.isNew;
    row.addEventListener('pointerdown', function (e) { startDrag(st, item, row, e); });
    return row;
  }

  // ---------------------------------------------------------------- menu

  function toggleMenu(st, item, anchorEl) {
    if (openMenu && openMenu.itemId === item.id) { closeMenu(); return; }
    closeMenu();
    var queueing = getMode(st) === 'queue';
    var menu = h('div', 'cq-menu', { role: 'menu' }, [
      h('button', null, {
        type: 'button', role: 'menuitem', html: ICON.edit + '<span>Edit message</span>',
        onclick: function (e) { e.preventDefault(); closeMenu(); editItem(st, item); }
      }),
      h('button', null, {
        type: 'button', role: 'menuitem', html: ICON.queue + '<span>' + (queueing ? 'Turn off queueing' : 'Turn on queueing') + '</span>',
        onclick: function (e) { e.preventDefault(); closeMenu(); setMode(st, queueing ? 'steer' : 'queue'); }
      })
    ]);
    document.body.appendChild(menu);
    var r = anchorEl.getBoundingClientRect();
    var mr = menu.getBoundingClientRect();
    var top = r.top - mr.height - 4;
    if (top < 4) top = r.bottom + 4;
    var left = Math.max(4, Math.min(r.right - mr.width, window.innerWidth - mr.width - 4));
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    openMenu = { st: st, itemId: item.id, el: menu, anchor: anchorEl };
    var first = menu.querySelector('button');
    if (first) first.focus();
  }

  function closeMenu() {
    if (!openMenu) return;
    var m = openMenu.el;
    openMenu = null;
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }

  document.addEventListener('pointerdown', function (e) {
    if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  // ---------------------------------------------------------------- drag

  function startDrag(st, item, row, e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    var list = row.parentElement;
    var startY = e.clientY;
    var lastY = startY;
    var active = false;
    var pointerId = e.pointerId;

    function move(ev) {
      if (ev.pointerId !== pointerId) return;
      if (!active) {
        if (Math.abs(ev.clientY - startY) < 6) return;
        active = true;
        st.dragging = true;
        row.classList.add('cq-dragging');
        try { row.setPointerCapture(pointerId); } catch (x) { /* ignore */ }
      }
      ev.preventDefault();
      var dy = ev.clientY - lastY;
      lastY = ev.clientY;
      if (dy < 0) {
        var prev = row.previousElementSibling;
        if (prev) {
          var pr = prev.getBoundingClientRect();
          if (ev.clientY < pr.top + pr.height / 2) list.insertBefore(row, prev);
        }
      } else if (dy > 0) {
        var next = row.nextElementSibling;
        if (next) {
          var nr = next.getBoundingClientRect();
          if (ev.clientY > nr.top + nr.height / 2) list.insertBefore(next, row);
        }
      }
    }

    function end(ev) {
      if (ev.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', end, true);
      document.removeEventListener('pointercancel', end, true);
      if (!active) return;
      st.dragging = false;
      var order = [].map.call(list.children, function (el) { return el.getAttribute('data-id'); });
      var byId = {};
      st.items.forEach(function (it) { byId[it.id] = it; });
      var reordered = order.map(function (id) { return byId[id]; }).filter(Boolean);
      st.items.forEach(function (it) { if (reordered.indexOf(it) < 0) reordered.push(it); });
      st.items = reordered;
      changed(st);
    }

    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
  }

  // -------------------------------------------------------------- dialog

  function openSendDialog(st, item) {
    var s = st.session;
    var n = st.items.length;
    var overlay;
    var settled = false;

    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function cancel() {
      if (settled) return;
      settled = true;
      close();
      try {
        if (item.atts.length && s.composerAttachments) s.composerAttachments.value = item.atts.slice();
        if (s.initialPrompt) s.initialPrompt.value = item.text;
      } catch (e) { log(e); }
      setTimeout(function () { focusComposer(st); }, 50);
    }
    function go(clear) {
      if (settled) return;
      settled = true;
      close();
      if (clear) st.items = [];
      st.paused = null;
      changed(st);
      sendItem(st, item).catch(function (e) { log('send failed', e); });
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    }

    var sendBtn = h('button', 'cq-btn cq-primary', { type: 'button', text: 'Send message', onclick: function () { go(false); } });
    overlay = h('div', 'cq-overlay', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Send message?' }, [
      h('div', 'cq-dialog', null, [
        h('div', 'cq-dialog-title', { text: 'Send message?' }),
        h('div', 'cq-dialog-body', {
          text: 'You are about to send a message. Do you want to clear the ' + n + ' previously queued ' + (n === 1 ? 'message' : 'messages') + '?'
        }),
        h('div', 'cq-dialog-actions', null, [
          h('button', 'cq-btn', { type: 'button', text: 'Cancel', onclick: cancel }),
          h('button', 'cq-btn', { type: 'button', text: 'Clear queue', onclick: function () { go(true); } }),
          sendBtn
        ])
      ])
    ]);
    overlay.addEventListener('pointerdown', function (e) { if (e.target === overlay) cancel(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    setTimeout(function () { sendBtn.focus(); }, 0);
  }

  // ------------------------------------------------------------ keyboard

  document.addEventListener('keydown', function (e) {
    if (synthetic || e.key !== 'Enter' || e.isComposing || e.altKey) return;
    var ed = e.target && e.target.closest ? e.target.closest(COMPOSER_SEL) : null;
    if (!ed) return;
    var s = sessionFromElement(ed);
    if (!s) return;
    var st = attach(s);
    if (!isRunning(s)) return;

    var ctrlMode = useCtrlEnter(s);
    var mod = e.ctrlKey || e.metaKey;
    var isSend = ctrlMode ? mod : !e.shiftKey;
    var invert = ctrlMode ? (mod && e.shiftKey) : (mod && !e.shiftKey);
    if (!isSend && !invert) return;

    var action = st.editAnchor ? 'queue' : getMode(st);
    if (invert) action = invertOf(action);

    var atts = peek(s.composerAttachments) || [];
    var empty = !(ed.textContent || '').trim() && !atts.length;
    if (empty) {
      // Empty composer + steer: push the first queued message into the running turn.
      if (action === 'steer' && st.items.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        steerItem(st, st.items[0]);
      }
      return;
    }
    if (!invert) return;
    st.invertAt = Date.now();
    if (ctrlMode) {
      // Ctrl+Shift+Enter would insert a new line; hand the composer a plain Ctrl+Enter instead.
      e.preventDefault();
      e.stopImmediatePropagation();
      synthetic = true;
      try {
        ed.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true, cancelable: true, composed: true
        }));
      } finally { synthetic = false; }
    }
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openMenu) { e.preventDefault(); e.stopImmediatePropagation(); closeMenu(); }
  }, true);

  // Tooltip for the send button while Claude works: "Queue (Enter) / Steer (Ctrl+Enter)".
  document.addEventListener('mouseover', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('button[type="submit"]') : null;
    if (!btn) return;
    var s = sessionFromElement(btn);
    if (!s) return;
    var st = attach(s);
    var cont = containerFor(btn);
    var ed = cont && cont.querySelector(COMPOSER_SEL);
    var hasText = !!(ed && (ed.textContent || '').trim()) || (peek(s.composerAttachments) || []).length > 0;
    if (!isRunning(s) || !hasText) { if (btn.hasAttribute('data-cq-title')) { btn.removeAttribute('title'); btn.removeAttribute('data-cq-title'); } return; }
    var a = getMode(st);
    var keys = shortcuts(s);
    btn.setAttribute('title', actionLabel(a) + '  (' + keys.send + ')\n' + actionLabel(invertOf(a)) + '  (' + keys.invert + ')');
    btn.setAttribute('data-cq-title', '');
  }, true);

  // ------------------------------------------------------------ mounting

  function fiberOf(el) {
    for (var k in el) if (k.indexOf('__reactFiber$') === 0) return el[k];
    return null;
  }

  function sessionFromElement(el) {
    var f = fiberOf(el);
    for (var n = 0; f && n < 80; n++, f = f.return) {
      var p = f.memoizedProps;
      if (p && isSession(p.session)) return p.session;
    }
    return null;
  }

  function containerFor(el) {
    var outer = null;
    for (var n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (typeof n.className === 'string' && /(^|\s)inputContainer_/.test(n.className)) outer = n;
    }
    return outer;
  }

  function refreshPlaceholder(st) {
    var host = st.host;
    var ed = host && host.parentElement && host.parentElement.querySelector(COMPOSER_SEL);
    if (!ed) return;
    if (!ed.__cqPlaceholderObserver) {
      ed.__cqPlaceholderObserver = new MutationObserver(function () { refreshPlaceholder(st); });
      ed.__cqPlaceholderObserver.observe(ed, { attributes: true, attributeFilter: ['data-placeholder'] });
    }
    // Only the stock "busy" placeholder is replaced; idle placeholders are left to React.
    var cur = ed.getAttribute('data-placeholder');
    var ours = cur === PLACEHOLDERS.steer || cur === PLACEHOLDERS.interrupt || cur === STOCK_BUSY_PLACEHOLDER;
    if (!ours || !isRunning(st.session)) return;
    var want = PLACEHOLDERS[getMode(st)];
    if (cur !== want) ed.setAttribute('data-placeholder', want);
  }

  function scan() {
    scanQueued = false;
    var comps = document.querySelectorAll(COMPOSER_SEL);
    for (var i = 0; i < comps.length; i++) {
      var c = comps[i];
      var s = sessionFromElement(c);
      if (!s) continue;
      var st = attach(s);
      var cont = containerFor(c);
      if (!cont) continue;
      var host = null;
      for (var ch = cont.firstElementChild; ch; ch = ch.nextElementSibling) {
        if (ch.classList && ch.classList.contains('cq-host')) { host = ch; break; }
      }
      if (!host) {
        host = document.createElement('div');
        host.className = 'cq-host';
        cont.insertBefore(host, cont.firstChild);
      }
      if (host.__cqState !== st || st.host !== host) {
        if (host.__cqState && host.__cqState !== st && host.__cqState.host === host) host.__cqState.host = null;
        host.__cqState = st;
        st.host = host;
        ensureLoaded(st);
        render(st);
      }
      refreshPlaceholder(st);
    }
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  var STYLE = [
    '.cq-host{display:block;flex:none;min-width:0}',
    '.cq-host:not([data-active]){display:none}',
    '.cq-panel{margin:0 0 6px;background:var(--app-input-secondary-background,var(--vscode-input-background));border:1px solid var(--app-input-border,var(--vscode-input-border,transparent));border-radius:var(--corner-radius-large,8px);box-shadow:0 1px 2px #0000001a;overflow:hidden;font-size:12px;color:var(--app-primary-foreground,var(--vscode-foreground))}',
    '.cq-paused{display:flex;align-items:center;gap:8px;padding:4px 6px 4px 10px;border-bottom:1px solid var(--app-input-border,transparent);color:var(--app-secondary-foreground)}',
    '.cq-paused span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cq-list{max-height:30vh;overflow-y:auto;padding:3px}',
    '.cq-row{position:relative;display:flex;align-items:center;gap:6px;min-height:26px;padding:0 3px 0 6px;border-radius:var(--corner-radius-medium,6px);cursor:grab;user-select:none;-webkit-user-select:none}',
    '.cq-row:hover{background:var(--app-list-hover-background)}',
    '.cq-row.cq-dragging{opacity:.6;cursor:grabbing;background:var(--app-list-hover-background)}',
    '.cq-row.cq-new{animation:cq-in .18s ease-out}',
    '@keyframes cq-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion:reduce){.cq-row.cq-new{animation:none}}',
    '.cq-lead{flex:none;width:14px;height:14px;display:grid;place-items:center;color:var(--app-secondary-foreground)}',
    '.cq-lead .cq-grip{display:none}',
    '.cq-row:hover .cq-lead .cq-arrow{display:none}',
    '.cq-row:hover .cq-lead .cq-grip{display:block}',
    '.cq-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cq-text.cq-muted{color:var(--app-secondary-foreground);font-style:italic}',
    '.cq-badge{flex:none;display:inline-flex;align-items:center;gap:2px;color:var(--app-secondary-foreground);font-size:11px}',
    '.cq-warn{flex:none;display:grid;place-items:center;color:var(--app-warning-foreground,#cca700)}',
    '.cq-actions{flex:none;display:flex;align-items:center;gap:1px}',
    '.cq-btn{font:inherit;font-size:12px;line-height:18px;padding:1px 8px;border-radius:var(--corner-radius-small,4px);border:1px solid var(--app-input-border,transparent);background:transparent;color:var(--app-primary-foreground);cursor:pointer;white-space:nowrap}',
    '.cq-btn:hover{background:var(--app-ghost-button-hover-background)}',
    '.cq-btn:focus-visible,.cq-icon-btn:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}',
    '.cq-steer{margin-right:2px}',
    '.cq-primary{background:var(--app-button-background);color:var(--app-button-foreground);border-color:transparent}',
    '.cq-primary:hover{background:var(--app-button-background);filter:brightness(1.1)}',
    '.cq-icon-btn{width:22px;height:22px;display:grid;place-items:center;border:none;border-radius:var(--corner-radius-small,4px);background:transparent;color:var(--app-secondary-foreground);cursor:pointer;padding:0}',
    '.cq-icon-btn:hover{background:var(--app-ghost-button-hover-background);color:var(--app-primary-foreground)}',
    '.cq-menu{position:fixed;z-index:1000;min-width:180px;padding:4px;background:var(--app-menu-background,var(--vscode-menu-background));color:var(--app-menu-foreground,var(--vscode-menu-foreground));border:1px solid var(--app-menu-border,var(--vscode-menu-border,transparent));border-radius:var(--corner-radius-medium,6px);box-shadow:0 4px 14px #0000003a;font-size:12px}',
    '.cq-menu button{display:flex;width:100%;align-items:center;gap:8px;padding:4px 8px;border:none;background:none;color:inherit;font:inherit;text-align:left;border-radius:var(--corner-radius-small,4px);cursor:pointer}',
    '.cq-menu button:hover,.cq-menu button:focus-visible{background:var(--app-list-active-background,var(--app-list-hover-background));color:var(--app-list-active-foreground,inherit);outline:none}',
    '.cq-overlay{position:fixed;inset:0;z-index:2000;background:var(--app-modal-background,#000000bf);display:flex;align-items:center;justify-content:center}',
    '.cq-dialog{box-sizing:border-box;width:380px;max-width:calc(100vw - 32px);margin:16px;padding:16px;background-color:var(--app-primary-background,var(--vscode-editor-background));color:var(--app-primary-foreground);border:1px solid var(--app-primary-border-color,var(--app-input-border,transparent));border-radius:8px;outline:0}',
    '.cq-dialog-title{color:var(--app-primary-foreground);font-size:14px;font-weight:600;line-height:1.4;margin-bottom:8px}',
    '.cq-dialog-body{color:var(--app-secondary-foreground);font-size:12px;line-height:1.5;margin-bottom:16px}',
    '.cq-dialog-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}'
  ].join('\n');

  function boot() {
    var style = document.createElement('style');
    style.id = 'claude-queue-style';
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);
    new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
    setInterval(function () {
      queueScan();
      allStates.forEach(function (st) { if (st.items.length && !st.paused) drain(st); });
    }, 1500);
    queueScan();
  }

  window.__claudeQueue = {
    version: VERSION,
    states: allStates,
    _debug: { stateFor: stateFor, attach: attach, intercept: intercept, drain: drain, scan: scan, getMode: getMode, setMode: setMode }
  };

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
