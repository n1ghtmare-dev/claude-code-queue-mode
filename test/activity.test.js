// Unit tests for src/activity.js with a fake vscode API and a fake taskbar helper.
// Run: node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

function load() {
  delete require.cache[require.resolve('../src/activity.js')];
  return require('../src/activity.js');
}

function fakeVscode(opts = {}) {
  const settings = Object.assign({ workingIndicator: true, notifyWhenDone: 'whenUnfocused' }, opts.settings);
  const shown = [];
  return {
    shown,
    env: { language: 'en', appName: 'Cursor', uriScheme: 'cursor' },
    window: {
      state: { focused: !!opts.focused },
      onDidChangeWindowState: () => ({ dispose() {} }),
      showInformationMessage: (m) => shown.push(m)
    },
    workspace: {
      name: 'demo',
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: 'C:\\work\\demo' } }],
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
      onDidChangeConfiguration: () => ({ dispose() {} })
    }
  };
}

// Replaces the PowerShell helper with a recorder that "finds" window 42.
function withFakeHelper(activity) {
  const sent = [];
  activity.ensureHelper = function () {
    if (!this.helper) {
      this.helper = { stdin: { write: (line) => sent.push(JSON.parse(line)), end() {} } };
      this.hwnd = 42;
    }
    return true;
  };
  return sent;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const owner = () => ({ panelTab: { title: 'Fix the parser' } });

test('running shows the hourglass and a progress bar, idle removes them and notifies', async () => {
  process.env.CLAUDE_QUEUE_LANG = 'en';
  const vscode = fakeVscode();
  const a = load().get(vscode, 'C:/ext');
  const sent = withFakeHelper(a);
  const o = owner();

  a.update({ sessionId: 's1', state: 'running', title: 'Fix the parser' }, o);
  assert.strictEqual(o.panelTab.title, '⏳ Fix the parser');
  assert.deepStrictEqual(sent.filter((m) => m.cmd === 'progress').pop(), { cmd: 'progress', hwnd: 42, state: 'running' });

  a.update({ sessionId: 's1', state: 'idle', title: 'Fix the parser' }, o);
  assert.strictEqual(o.panelTab.title, '⏳ Fix the parser', 'stays until the done delay passes');
  await wait(2700);
  assert.strictEqual(o.panelTab.title, 'Fix the parser');
  assert.deepStrictEqual(sent.filter((m) => m.cmd === 'progress').pop(), { cmd: 'progress', hwnd: 42, state: 'none' });
  assert.ok(sent.some((m) => m.cmd === 'flash'), 'flashes the taskbar button');
  const toast = sent.find((m) => m.cmd === 'toast');
  assert.ok(toast, 'notifies');
  assert.strictEqual(toast.title, 'Claude finished');
  assert.strictEqual(toast.body, 'Fix the parser · demo');
  assert.strictEqual(toast.launch, 'cursor://file/C:/work/demo');
});

test('a queued follow-up that starts right away does not count as done', async () => {
  const a = load().get(fakeVscode(), 'C:/ext');
  const sent = withFakeHelper(a);
  const o = owner();
  a.update({ sessionId: 's1', state: 'running', title: 'T' }, o);
  a.update({ sessionId: 's1', state: 'idle', title: 'T' }, o);
  await wait(600);
  a.update({ sessionId: 's1', state: 'running', title: 'T' }, o);
  await wait(2700);
  assert.ok(!sent.some((m) => m.cmd === 'toast'));
  assert.strictEqual(o.panelTab.title, '⏳ Fix the parser');
});

test('waiting for an answer shows a hand, a yellow bar and notifies once', () => {
  const a = load().get(fakeVscode(), 'C:/ext');
  const sent = withFakeHelper(a);
  const o = owner();
  a.update({ sessionId: 's1', state: 'running', title: 'T' }, o);
  a.update({ sessionId: 's1', state: 'waiting_input', title: 'T' }, o);
  a.update({ sessionId: 's1', state: 'waiting_input', title: 'T' }, o);
  assert.strictEqual(o.panelTab.title, '✋ Fix the parser');
  assert.deepStrictEqual(sent.filter((m) => m.cmd === 'progress').pop(), { cmd: 'progress', hwnd: 42, state: 'waiting' });
  assert.strictEqual(sent.filter((m) => m.cmd === 'toast').length, 1);
  assert.strictEqual(sent.find((m) => m.cmd === 'toast').title, 'Claude needs your answer');
});

test('no notification while the window is focused (default), but always mode notifies', async () => {
  let a = load().get(fakeVscode({ focused: true }), 'C:/ext');
  let sent = withFakeHelper(a);
  a.update({ sessionId: 's1', state: 'running', title: 'T' }, owner());
  a.update({ sessionId: 's1', state: 'idle', title: 'T' }, owner());
  await wait(2700);
  assert.ok(!sent.some((m) => m.cmd === 'toast' || m.cmd === 'flash'));

  a = load().get(fakeVscode({ focused: true, settings: { notifyWhenDone: 'always' } }), 'C:/ext');
  sent = withFakeHelper(a);
  a.update({ sessionId: 's1', state: 'running', title: 'T' }, owner());
  a.update({ sessionId: 's1', state: 'idle', title: 'T' }, owner());
  await wait(2700);
  assert.ok(sent.some((m) => m.cmd === 'toast'));
  assert.ok(!sent.some((m) => m.cmd === 'flash'), 'no flash for the window you are looking at');
});

test('switching the tab to another chat forgets the old one quietly', async () => {
  const a = load().get(fakeVscode(), 'C:/ext');
  const sent = withFakeHelper(a);
  const o = owner();
  a.update({ sessionId: 's1', state: 'running', title: 'T' }, o);
  a.update({ sessionId: 's1', state: 'idle', isFarewell: true }, o);
  await wait(2700);
  assert.ok(!sent.some((m) => m.cmd === 'toast'));
  assert.strictEqual(o.panelTab.title, 'Fix the parser');
});

test('renames keep the prefix, and the indicator can be turned off', () => {
  const a = load().get(fakeVscode({ settings: { workingIndicator: false } }), 'C:/ext');
  withFakeHelper(a);
  const o = owner();
  a.update({ sessionId: 's1', state: 'running', title: 'T' }, o);
  assert.strictEqual(o.panelTab.title, 'Fix the parser');
  assert.strictEqual(a.tabTitle(o, 'New name'), 'New name');

  const b = load().get(fakeVscode(), 'C:/ext');
  withFakeHelper(b);
  const p = owner();
  b.update({ sessionId: 's2', state: 'running', title: 'T' }, p);
  assert.strictEqual(b.tabTitle(p, 'Renamed chat'), '⏳ Renamed chat');
  assert.strictEqual(b.tabTitle(p, '⏳ Renamed chat'), '⏳ Renamed chat', 'never doubles the prefix');
});

test('the helper script exists next to activity.js', () => {
  require('fs').accessSync(path.join(__dirname, '..', 'src', 'taskbar.ps1'));
});
