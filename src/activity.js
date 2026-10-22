/*
 * Claude Code Queue Mode — working indicator and notifications.
 *
 * Loaded by the patched extension.js. Claude Code's webview already reports every
 * chat's state to the extension host ("running" / "waiting_input" / "idle"); the patch
 * forwards those reports here.
 *
 *   - while Claude works: "⏳ " in the window title (the ${claudeActivity} title variable)
 *     and in front of the chat tab title, and on Windows a running green bar on the
 *     window's taskbar button;
 *   - when Claude waits for an answer: "✋ ", a yellow bar and a notification;
 *   - when Claude is done: "✓ " in the window title and an orange taskbar button until you
 *     come back to the window, and a Windows notification; clicking it brings the window back.
 *
 * Settings: claudeCode.workingIndicator (boolean), claudeCode.notifyWhenDone
 * ("whenUnfocused" | "always" | "off").
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// Set CLAUDE_QUEUE_DEBUG=1 before starting the editor to log to %TEMP%/claude-queue-activity.log.
const DEBUG = !!process.env.CLAUDE_QUEUE_DEBUG;
function debug() {
  if (!DEBUG) return;
  const parts = [].map.call(arguments, (x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  try { fs.appendFileSync(path.join(os.tmpdir(), 'claude-queue-activity.log'), new Date().toISOString() + ' ' + parts.join(' ') + '\n'); } catch (e) { /* ignore */ }
}

const PREFIX = { running: '⏳ ', waiting_input: '✋ ' };
const PREFIX_RE = /^(⏳ |✋ )+/;
const DONE_MARK = '✓ ';
const TITLE_VARIABLE = 'claudeActivity';
const TITLE_CONTEXT_KEY = 'claudeQueue.activity';
const DONE_DELAY_MS = 2500;        // a queued follow-up usually starts within this time
const HELPER_IDLE_MS = 10 * 60 * 1000;
const MAX_HELPER_RESTARTS = 3;
const STATE_FILE = process.env.CLAUDE_QUEUE_STATE_FILE || path.join(os.homedir(), '.claude-queue', 'state.json');

const TEXT = {
  en: { done: 'Claude finished', waiting: 'Claude needs your answer', untitled: 'Claude Code' },
  ru: { done: 'Claude закончил', waiting: 'Claude ждёт ответа', untitled: 'Claude Code' }
};

// The editor's UI language; when it is English, the system's regional format decides
// (many people run an English editor on a localized system). CLAUDE_QUEUE_LANG overrides.
function detectLanguage(vscode) {
  const forced = process.env.CLAUDE_QUEUE_LANG;
  if (forced) return /^ru/i.test(forced) ? 'ru' : 'en';
  const ui = (vscode.env && vscode.env.language) || '';
  if (/^ru/i.test(ui)) return 'ru';
  if (ui && !/^en/i.test(ui)) return 'en';
  let locale = '';
  if (process.platform === 'win32') {
    try {
      const out = cp.execFileSync('reg', ['query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const m = /LocaleName\s+REG_SZ\s+(\S+)/.exec(out);
      if (m) locale = m[1];
    } catch (e) { /* ignore */ }
  }
  if (!locale) locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  return /^ru/i.test(locale) ? 'ru' : 'en';
}

// Non-ASCII as \uXXXX so the PowerShell side never deals with code pages.
function asciiJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeState(patch) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(Object.assign(readState(), patch), null, 2));
  } catch (e) { /* ignore */ }
}

class Activity {
  constructor(vscode, extDir) {
    this.vscode = vscode;
    this.payloadDir = path.join(extDir, 'claude-queue');
    this.text = TEXT[detectLanguage(vscode)];
    this.sessions = new Map();   // sessionId -> { state, shown, title, owner }
    this.owners = new Set();
    this.doneTimers = new Map();
    this.doneUnseen = false;
    this.helper = null;
    this.helperRestarts = 0;
    this.helperIdleTimer = null;
    this.hwnd = 0;
    this.findSent = false;
    this.lastProgress = 'none';
    this.lastMark = '';
    this.titleChecked = false;
    this.buffer = '';

    // ${claudeActivity} in window.title shows the value of this context key (the same
    // mechanism the editor offers to its built-in extensions).
    this.titleReady = Promise.resolve()
      .then(() => vscode.commands && vscode.commands.executeCommand('registerWindowTitleVariable', TITLE_VARIABLE, TITLE_CONTEXT_KEY))
      .catch((e) => debug('title variable', String(e)));

    this.disposables = [
      vscode.window.onDidChangeWindowState((s) => {
        debug('window focused', s.focused);
        if (!s.focused) return;
        if (this.doneUnseen) { this.doneUnseen = false; this.refresh(); }
        // Right now the foreground window is ours, whatever its title looks like.
        if (this.helper) this.send({ cmd: 'capture', name: this.workspaceName, any: true });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeCode.workingIndicator')) this.refresh();
      })
    ];
  }

  // ------------------------------------------------------------- settings

  get indicatorOn() {
    return this.vscode.workspace.getConfiguration('claudeCode').get('workingIndicator', true) !== false;
  }

  get notifyMode() {
    const v = this.vscode.workspace.getConfiguration('claudeCode').get('notifyWhenDone', 'whenUnfocused');
    return v === 'always' || v === 'off' ? v : 'whenUnfocused';
  }

  get focused() {
    try { return !!this.vscode.window.state.focused; } catch (e) { return true; }
  }

  // Window titles carry the workspace name ("<file> - name - Cursor", "name - Cursor", …);
  // this is how the helper tells our window from the other editor windows.
  get workspaceName() {
    return this.vscode.workspace.name || '';
  }

  // --------------------------------------------------------------- events

  // q: { sessionId, state, title?, isFarewell?, panelNoLongerHosts? } as Claude Code reports it.
  update(q, owner) {
    if (!q || !q.sessionId) return;
    debug('state', { id: q.sessionId, state: q.state, title: q.title, farewell: q.isFarewell, gone: q.panelNoLongerHosts });
    this.ensureTitleTemplate();
    const id = q.sessionId;
    if (owner) this.owners.add(owner);
    const prev = this.sessions.get(id);

    // The tab switched to another chat or closed: forget this one quietly.
    if (q.isFarewell || q.panelNoLongerHosts) {
      this.sessions.delete(id);
      this.cancelDone(id);
      this.refresh();
      return;
    }

    const s = prev || { state: 'idle', shown: 'idle', title: '', owner };
    s.owner = owner || s.owner;
    if (q.title) s.title = q.title;
    s.state = q.state;
    this.sessions.set(id, s);

    if (q.state === 'running' || q.state === 'waiting_input') {
      this.cancelDone(id);
      this.doneUnseen = false;
      const before = s.shown;
      s.shown = q.state;
      if (q.state === 'waiting_input' && before !== 'waiting_input') this.attention('waiting', s);
    } else if (s.shown !== 'idle') {
      // Wait a moment: a queued follow-up may start right away.
      this.scheduleDone(id);
    }
    this.refresh();
  }

  scheduleDone(id) {
    this.cancelDone(id);
    this.doneTimers.set(id, setTimeout(() => {
      this.doneTimers.delete(id);
      const s = this.sessions.get(id);
      if (!s || s.state !== 'idle') return;
      const was = s.shown;
      s.shown = 'idle';
      if (was === 'running' && !this.focused) this.doneUnseen = true;
      this.refresh();
      if (was === 'running') this.attention('done', s);
    }, DONE_DELAY_MS));
  }

  cancelDone(id) {
    const t = this.doneTimers.get(id);
    if (t) { clearTimeout(t); this.doneTimers.delete(id); }
  }

  // -------------------------------------------------------------- display

  windowState() {
    let state = 'none';
    for (const s of this.sessions.values()) {
      if (s.shown === 'waiting_input') return 'waiting';
      if (s.shown === 'running') state = 'running';
    }
    return state;
  }

  ownerState(owner) {
    let state = 'idle';
    for (const s of this.sessions.values()) {
      if (s.owner !== owner) continue;
      if (s.shown === 'waiting_input') return 'waiting_input';
      if (s.shown === 'running') state = 'running';
    }
    return state;
  }

  refresh() {
    for (const owner of this.owners) this.applyTitle(owner);
    const state = this.indicatorOn ? this.windowState() : 'none';
    this.setProgress(state);
    let mark = '';
    if (this.indicatorOn) {
      mark = state === 'waiting' ? PREFIX.waiting_input : state === 'running' ? PREFIX.running : this.doneUnseen ? DONE_MARK : '';
    }
    this.setWindowMark(mark);
  }

  setWindowMark(mark) {
    if (mark === this.lastMark) return;
    this.lastMark = mark;
    const vscode = this.vscode;
    this.titleReady
      .then(() => vscode.commands && vscode.commands.executeCommand('setContext', TITLE_CONTEXT_KEY, mark))
      .catch((e) => debug('setContext', String(e)));
  }

  // Once per machine: if the window title doesn't show the active editor (so the tab mark
  // can't reach it), put ${claudeActivity} in front of it. Removing it later is respected.
  ensureTitleTemplate() {
    if (this.titleChecked) return;
    this.titleChecked = true;
    if (!this.indicatorOn || readState().titleTemplate) return;
    try {
      const cfg = this.vscode.workspace.getConfiguration('window');
      const info = cfg.inspect('title') || {};
      if (info.workspaceValue !== undefined || info.workspaceFolderValue !== undefined) return;
      const current = info.globalValue !== undefined ? info.globalValue : info.defaultValue;
      if (typeof current !== 'string' || current.indexOf('${' + TITLE_VARIABLE + '}') >= 0) return;
      if (/\$\{activeEditor(Short|Medium|Long)\}/.test(current)) return;
      Promise.resolve(cfg.update('title', '${' + TITLE_VARIABLE + '}' + current, this.vscode.ConfigurationTarget.Global))
        .then(() => writeState({ titleTemplate: true }), (e) => debug('title template', String(e)));
    } catch (e) { debug('title template', String(e)); }
  }

  // Called by the patched rename handler: remember the real title, return it with our prefix.
  tabTitle(owner, title) {
    if (owner) {
      this.owners.add(owner);
      owner.__cqBaseTitle = String(title || '').replace(PREFIX_RE, '');
      return this.prefixFor(owner) + owner.__cqBaseTitle;
    }
    return title;
  }

  prefixFor(owner) {
    return this.indicatorOn ? PREFIX[this.ownerState(owner)] || '' : '';
  }

  applyTitle(owner) {
    const tab = owner && owner.panelTab;
    if (!tab) return;
    try {
      const base = owner.__cqBaseTitle !== undefined ? owner.__cqBaseTitle : String(tab.title || '').replace(PREFIX_RE, '');
      const want = this.prefixFor(owner) + base;
      if (tab.title !== want) tab.title = want;
    } catch (e) { /* the tab may be disposed */ }
  }

  setProgress(state) {
    if (state === this.lastProgress) return;
    this.lastProgress = state;
    if (state === 'none') {
      if (this.helper && this.hwnd) this.send({ cmd: 'progress', hwnd: this.hwnd, state: 'none' });
      this.scheduleHelperExit();
      return;
    }
    this.cancelHelperExit();
    if (!this.ensureHelper()) return;
    if (this.hwnd) this.send({ cmd: 'progress', hwnd: this.hwnd, state });
  }

  attention(kind, s) {
    debug('attention', kind, { focused: this.focused, mode: this.notifyMode, hwnd: this.hwnd });
    if (this.indicatorOn && !this.focused && this.ensureHelper() && this.hwnd) this.send({ cmd: 'flash', hwnd: this.hwnd });
    const mode = this.notifyMode;
    if (mode === 'off' || (mode === 'whenUnfocused' && this.focused)) return;
    const title = kind === 'done' ? this.text.done : this.text.waiting;
    const chat = String(s.title || '').replace(PREFIX_RE, '') || this.text.untitled;
    const where = this.workspaceName;
    this.toast(title, where ? chat + ' · ' + where : chat);
  }

  toast(title, body) {
    if (process.platform !== 'win32') {
      // Elsewhere fall back to the editor's own notification.
      this.vscode.window.showInformationMessage(title + ': ' + body);
      return;
    }
    if (!this.ensureHelper()) return;
    this.send({ cmd: 'toast', title, body, launch: this.launchUrl() });
  }

  // cursor://file/C:/path focuses the window that has this folder open.
  launchUrl() {
    try {
      const ws = this.vscode.workspace;
      const uri = ws.workspaceFile && ws.workspaceFile.scheme === 'file' ? ws.workspaceFile
        : ws.workspaceFolders && ws.workspaceFolders.length === 1 && ws.workspaceFolders[0].uri.scheme === 'file' ? ws.workspaceFolders[0].uri : null;
      if (!uri) return '';
      const p = uri.fsPath.replace(/\\/g, '/');
      return this.vscode.env.uriScheme + '://file/' + encodeURI(p.startsWith('/') ? p.slice(1) : p);
    } catch (e) { return ''; }
  }

  // --------------------------------------------------------------- helper

  ensureHelper() {
    if (process.platform !== 'win32') return false;
    if (this.helper) return true;
    if (this.helperRestarts >= MAX_HELPER_RESTARTS) return false;
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = path.join(this.payloadDir, 'taskbar.ps1');
    let child;
    try {
      child = cp.spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-AppName', this.vscode.env.appName || 'Cursor', '-ExeName', path.basename(process.execPath)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.helperRestarts++;
      console.error('[claude-queue] could not start the taskbar helper', e);
      return false;
    }
    this.helper = child;
    this.findSent = false;
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => this.onHelperOutput(d));
    child.stderr.on('data', (d) => { debug('helper stderr', String(d).trim()); console.error('[claude-queue]', String(d).trim()); });
    child.on('exit', (code) => {
      debug('helper exit', code);
      if (this.helper !== child) return;
      this.helper = null;
      if (code) this.helperRestarts++;
    });
    child.on('error', (e) => { debug('helper error', String(e)); if (this.helper === child) { this.helper = null; this.helperRestarts++; } });
    debug('helper started', { script, appName: this.vscode.env.appName, exe: path.basename(process.execPath), name: this.workspaceName });

    // Find our own window: the foreground one if its title carries our workspace name
    // (or any title, when this window is focused and has no name), then by name alone.
    if (!this.hwnd) this.send({ cmd: 'capture', name: this.workspaceName, any: !this.workspaceName && this.focused });
    return true;
  }

  onHelperOutput(data) {
    this.buffer += String(data);
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      debug('helper says', line);
      try {
        const m = JSON.parse(line);
        if (m.hwnd && m.hwnd !== this.hwnd) {
          this.hwnd = m.hwnd;
          if (this.lastProgress !== 'none') this.send({ cmd: 'progress', hwnd: this.hwnd, state: this.lastProgress });
        } else if (m.hwnd === 0 && !this.hwnd && this.workspaceName && !this.findSent) {
          this.findSent = true;
          this.send({ cmd: 'find', name: this.workspaceName });
        }
      } catch (e) { /* not ours */ }
    }
  }

  send(obj) {
    if (!this.helper) return;
    debug('send', obj);
    try { this.helper.stdin.write(asciiJson(obj) + '\n'); } catch (e) { /* helper is gone */ }
  }

  scheduleHelperExit() {
    this.cancelHelperExit();
    this.helperIdleTimer = setTimeout(() => {
      this.helperIdleTimer = null;
      if (this.helper && this.windowState() === 'none') {
        try { this.helper.stdin.end(); } catch (e) { /* ignore */ }
      }
    }, HELPER_IDLE_MS);
    if (this.helperIdleTimer.unref) this.helperIdleTimer.unref();
  }

  cancelHelperExit() {
    if (this.helperIdleTimer) { clearTimeout(this.helperIdleTimer); this.helperIdleTimer = null; }
  }

  dispose() {
    for (const d of this.disposables) { try { d.dispose(); } catch (e) { /* ignore */ } }
    if (this.helper) { try { this.helper.stdin.end(); } catch (e) { /* ignore */ } }
  }
}

let instance = null;

module.exports = {
  get(vscode, extDir) {
    if (!instance) instance = new Activity(vscode, extDir);
    return instance;
  },
  STATE_FILE
};
