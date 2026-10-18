#!/usr/bin/env node
/*
 * Claude Code Queue Mode — patcher.
 *
 *   node patch.js            apply (or re-apply) the patch to every installed Claude Code
 *   node patch.js --unpatch  restore the original files
 *   node patch.js --status   show what is installed and patched
 *   node patch.js --dir <extension folder> [--no-touch]   work on one folder only
 *   --lang en|ru             force the language of the messages
 *
 * Originals are kept next to the patched files as *.cq-orig; re-applying always
 * starts from them, so running the patch twice is safe.
 *
 * The patched extension carries a copy of this file and of queue-runtime.js in
 * <extension>/claude-queue/. When the editor installs a newer Claude Code next to
 * it, startAutoPatch() (called from the patched extension.js) patches the new
 * version too and offers to reload the window.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const PATCH_VERSION = '1.1.0';
const REPO_URL = 'https://github.com/n1ghtmare-dev/claude-code-queue-mode';
const RUNTIME_FILE = 'queue-runtime.js';
const PAYLOAD_DIR = 'claude-queue';
// Copied into <extension>/claude-queue/ so the patched extension can use them and re-patch updates.
const PAYLOAD_FILES = ['patch.js', RUNTIME_FILE, 'activity.js', 'taskbar.ps1'];
const MARKER_RE = /^\/\*claude-queue-patch ([^*]*)\*\//;
const BACKUP = '.cq-orig';
const EDITOR_DIRS = [
  '.cursor', '.vscode', '.vscode-insiders', '.windsurf', '.vscode-oss', '.trae', '.kiro',
  '.cursor-server', '.vscode-server', '.vscode-server-insiders', '.windsurf-server'
];
const FILES = ['extension.js', path.join('webview', 'index.js'), 'package.json'];

// -------------------------------------------------------------------- i18n

const MESSAGES = {
  en: {
    title: 'Claude Code Queue Mode {0} — Codex-style follow-up queue for Claude Code',
    notFound: 'Claude Code was not found (looked in {0}).',
    statusOk: 'patched ({0})',
    statusNo: 'not patched',
    restored: 'original files restored',
    nothingToRestore: 'was not patched',
    installed: 'patch installed',
    upToDate: 'patch is already installed',
    warning: 'warning: {0}',
    failed: 'failed: {0}',
    untouched: 'Files of this version were left untouched. Claude Code probably changed and the patch needs an update: ' + REPO_URL + '/issues',
    reload: 'Done. Reload the editor window to apply: Ctrl+Shift+P → "Developer: Reload Window" (or restart the editor).',
    alreadyPatched: '{0} is already patched but its backup is missing — reinstall Claude Code and run the patch again',
    missingNames: 'webview/index.js does not contain: {0}',
    noStateAnchor: 'could not find where extension.js passes settings to the webview',
    noManifestSection: 'package.json has no configuration section',
    syntax: 'syntax error after patching: {0}',
    warnReload: 'changing the mode in Settings will apply after "Reload Window"',
    warnMenu: 'the "Turn off/on queueing" menu item will not be able to save the setting',
    warnActivity: 'the working indicator and notifications are not available in this Claude Code version',
    warnTitle: 'the ⏳ mark in the chat tab title will be lost when Claude renames the chat',
    autoDone: 'Claude Code was updated to {0} — Queue Mode has been carried over. Reload the window to switch to the new version.',
    autoFailed: 'Claude Code was updated to {0}, but Queue Mode could not be carried over: {1}. Run the installer again; if that does not help, the patch needs an update.',
    reloadButton: 'Reload Window',
    error: 'Error: {0}'
  },
  ru: {
    title: 'Claude Code Queue Mode {0} — очередь сообщений для Claude Code, как в Codex',
    notFound: 'Расширение Claude Code не найдено (смотрел в {0}).',
    statusOk: 'пропатчено ({0})',
    statusNo: 'не пропатчено',
    restored: 'исходные файлы восстановлены',
    nothingToRestore: 'патча не было',
    installed: 'патч установлен',
    upToDate: 'патч уже установлен',
    warning: 'внимание: {0}',
    failed: 'не получилось: {0}',
    untouched: 'Файлы этой версии не тронуты. Похоже, Claude Code изменился и патч нужно обновить: ' + REPO_URL + '/issues',
    reload: 'Готово. Чтобы изменения заработали, перезагрузи окно редактора: Ctrl+Shift+P → «Developer: Reload Window» (или перезапусти редактор).',
    alreadyPatched: '{0} уже пропатчен, а резервной копии нет — переустанови Claude Code и запусти патч снова',
    missingNames: 'в webview/index.js не найдено: {0}',
    noStateAnchor: 'не найдено место, где extension.js передаёт настройки в webview',
    noManifestSection: 'в package.json нет раздела настроек',
    syntax: 'синтаксическая ошибка после патча: {0}',
    warnReload: 'смена режима в настройках подхватится только после Reload Window',
    warnMenu: 'пункт меню «Turn off/on queueing» не сможет сохранить настройку',
    warnActivity: 'индикатор работы и уведомления недоступны в этой версии Claude Code',
    warnTitle: 'значок ⏳ в названии вкладки будет пропадать, когда Claude переименует чат',
    autoDone: 'Claude Code обновился до {0} — режим очереди перенесён на новую версию. Перезагрузи окно, чтобы она включилась.',
    autoFailed: 'Claude Code обновился до {0}, но режим очереди перенести не удалось: {1}. Запусти установщик ещё раз; если не поможет — патч нужно обновить.',
    reloadButton: 'Reload Window',
    error: 'Ошибка: {0}'
  }
};

let lang = detectLanguage();

function detectLanguage(hint) {
  const forced = process.env.CLAUDE_QUEUE_LANG;
  const candidates = [forced, hint, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG];
  try { candidates.push(Intl.DateTimeFormat().resolvedOptions().locale); } catch (e) { /* ignore */ }
  for (const c of candidates) {
    if (!c || c === 'C' || c === 'POSIX') continue;
    return /^ru/i.test(c) ? 'ru' : 'en';
  }
  return 'en';
}

function t(key) {
  const args = [].slice.call(arguments, 1);
  const s = (MESSAGES[lang] && MESSAGES[lang][key]) || MESSAGES.en[key] || key;
  return s.replace(/\{(\d)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
}

// ------------------------------------------------------------------ helpers

function readRuntime(srcDir) {
  return fs.readFileSync(path.join(srcDir, RUNTIME_FILE), 'utf8');
}

// Version plus a hash of the patch sources: re-running a changed patch re-applies it.
function patchId(srcDir) {
  const h = crypto.createHash('sha1');
  for (const f of PAYLOAD_FILES) h.update(fs.readFileSync(path.join(srcDir, f)));
  return PATCH_VERSION + ' ' + h.digest('hex').slice(0, 8);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function extensionRoots() {
  const home = os.homedir();
  return EDITOR_DIRS.map((d) => path.join(home, d, 'extensions')).filter(isDir);
}

function claudeExtensions(root) {
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return []; }
  return names
    .filter((n) => /^anthropic\.claude-code-\d/.test(n))
    .map((n) => path.join(root, n))
    .filter((p) => FILES.every((f) => fs.existsSync(path.join(p, f))));
}

function readOriginal(file) {
  if (fs.existsSync(file + BACKUP)) return fs.readFileSync(file + BACKUP, 'utf8');
  return fs.readFileSync(file, 'utf8');
}

function versionOf(dir) {
  try { return JSON.parse(readOriginal(path.join(dir, 'package.json'))).version || '?'; } catch (e) { return '?'; }
}

function patchedIdOf(dir) {
  try {
    const fd = fs.openSync(path.join(dir, 'webview', 'index.js'), 'r');
    const buf = Buffer.alloc(200);
    const n = fs.readSync(fd, buf, 0, 200, 0);
    fs.closeSync(fd);
    const m = MARKER_RE.exec(buf.slice(0, n).toString('utf8'));
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

function isFullyPatched(dir, id) {
  return patchedIdOf(dir) === id &&
    FILES.every((f) => fs.existsSync(path.join(dir, f + BACKUP))) &&
    PAYLOAD_FILES.every((f) => fs.existsSync(path.join(dir, PAYLOAD_DIR, f)));
}

// ------------------------------------------------------------------ patches

function marker(id) {
  return '/*claude-queue-patch ' + id + '*/';
}

function patchWebview(src, runtime, id) {
  if (MARKER_RE.test(src)) throw new Error(t('alreadyPatched', 'webview/index.js'));
  const needed = ['turnRunningOrQueued', 'composerAttachments', 'initialPrompt', '"Message input"', 'inputContainer', 'heldPrompts', 'interrupt()'];
  const missing = needed.filter((n) => !src.includes(n));
  if (missing.length) throw new Error(t('missingNames', missing.join(', ')));
  return marker(id) + '\n' + runtime.replace(/__CQ_VERSION__/g, id) + '\n;\n' + src;
}

const HOST_HELPERS =
  'var __cqVscode=null;' +
  'function __cqMode(){try{__cqVscode=__cqVscode||require("vscode");var v=__cqVscode.workspace.getConfiguration("claudeCode").get("followUpQueueMode");return v==="steer"||v==="interrupt"?v:"queue"}catch(e){return"queue"}}' +
  'function __cqSetMode(m){try{if(m!=="queue"&&m!=="steer"&&m!=="interrupt")return;__cqVscode=__cqVscode||require("vscode");' +
  'Promise.resolve(__cqVscode.workspace.getConfiguration("claudeCode").update("followUpQueueMode",m,__cqVscode.ConfigurationTarget.Global))' +
  '.then(void 0,function(e){console.error("[claude-queue] could not save followUpQueueMode",e)})}catch(e){console.error("[claude-queue]",e)}}' +
  'setTimeout(function(){try{var f=require("path").join(__dirname,"' + PAYLOAD_DIR + '","patch.js");' +
  'if(require("fs").existsSync(f))require(f).startAutoPatch(__dirname,require("vscode"))}catch(e){console.error("[claude-queue] auto-patch",e)}},15000);' +
  // Working indicator and notifications (activity.js), fed by Claude Code's own chat state reports.
  'var __cqActInst=null;' +
  'function __cqAct(){if(!__cqActInst)__cqActInst=require(require("path").join(__dirname,"' + PAYLOAD_DIR + '","activity.js")).get(require("vscode"),__dirname);return __cqActInst}' +
  'function __cqActivity(q,o){try{__cqAct().update(q,o)}catch(e){console.error("[claude-queue] activity",e)}}' +
  'function __cqTabTitle(o,t){try{return __cqAct().tabTitle(o,t)}catch(e){return t}}';

function patchHost(src, id, warnings) {
  if (MARKER_RE.test(src)) throw new Error(t('alreadyPatched', 'extension.js'));
  let out = src;

  // 1. Pass the setting to the webview with the rest of the state (init + updates).
  const stateAnchor = 'useCtrlEnterToSend:this.settings.getUseCtrlEnterToSend(),';
  if (!out.includes(stateAnchor)) throw new Error(t('noStateAnchor'));
  out = out.split(stateAnchor).join('followUpQueueMode:__cqMode(),' + stateAnchor);

  // 2. Push a state update when the setting changes.
  const cfgRe = /([\w$]+)\.affectsConfiguration\("claudeCode\.useCtrlEnterToSend"\)/g;
  if (cfgRe.test(out)) out = out.replace(cfgRe, '$&||$1.affectsConfiguration("claudeCode.followUpQueueMode")');
  else warnings.push(t('warnReload'));

  // 3. Let the webview change the setting ("Turn off/on queueing" in the item menu).
  const caseRe = /case"interrupt_claude":this\.interruptClaude\(([\w$]+)\.channelId\);break;/;
  if (caseRe.test(out)) out = out.replace(caseRe, 'case"cq_set_mode":__cqSetMode($1.mode);break;$&');
  else warnings.push(t('warnMenu'));

  // 4. Forward each chat's state ("running" / "waiting_input" / "idle") to activity.js.
  const stateRe = /\.request\.type==="update_session_state"\)\{let ([\w$]+)=[\w$]+\([\w$]+\.request\);if\(\1\)\{/;
  if (stateRe.test(out)) out = out.replace(stateRe, '$&__cqActivity($1,this);');
  else warnings.push(t('warnActivity'));

  // 5. Keep the "⏳" prefix when Claude Code renames the chat tab.
  const titleRe = /this\.panelTab\.title=([\w$]+)\(([\w$]+)\.request\.title\)/;
  if (titleRe.test(out)) out = out.replace(titleRe, 'this.panelTab.title=__cqTabTitle(this,$1($2.request.title))');
  else warnings.push(t('warnTitle'));

  return marker(id) + HOST_HELPERS + '\n' + out;
}

const SETTING = {
  type: 'string',
  enum: ['queue', 'steer', 'interrupt'],
  enumDescriptions: [
    'Queue follow-up messages while Claude is working and send them one by one when it finishes.',
    'Send follow-up messages into the current run right away; Claude picks them up between steps.',
    'Stop the current run and send the follow-up message immediately.'
  ],
  default: 'queue',
  markdownDescription:
    'Control whether follow-up messages are queued or steer the current run. Press `Ctrl+Enter` ' +
    '(`Ctrl+Shift+Enter` when *Use Ctrl Enter To Send* is on) to do the opposite for a single in-progress follow-up. ' +
    '_Added by [Claude Code Queue Mode](' + REPO_URL + ')._'
};

const EXTRA_SETTINGS = {
  'claudeCode.workingIndicator': {
    type: 'boolean',
    default: true,
    markdownDescription:
      'Show when Claude is working: `⏳` before the chat tab title (so it also shows in the window title and on the taskbar), ' +
      '`✋` while it waits for your answer, and on Windows a progress bar on the taskbar button. ' +
      '_Added by [Claude Code Queue Mode](' + REPO_URL + ')._'
  },
  'claudeCode.notifyWhenDone': {
    type: 'string',
    enum: ['whenUnfocused', 'always', 'off'],
    enumDescriptions: [
      'Notify only when this editor window is not in focus.',
      'Always notify.',
      'Never notify.'
    ],
    default: 'whenUnfocused',
    markdownDescription:
      'Show a notification when Claude finishes or needs your answer. On Windows it is a system notification; ' +
      'clicking it brings this editor window back. _Added by [Claude Code Queue Mode](' + REPO_URL + ')._'
  }
};

function patchManifest(src) {
  const pkg = JSON.parse(src);
  const conf = pkg.contributes && pkg.contributes.configuration;
  const section = Array.isArray(conf) ? conf.find((c) => c && c.properties && c.properties['claudeCode.useCtrlEnterToSend']) || conf[0] : conf;
  if (!section || !section.properties) throw new Error(t('noManifestSection'));
  const ours = Object.assign({ 'claudeCode.followUpQueueMode': SETTING }, EXTRA_SETTINGS);
  const props = {};
  for (const [k, v] of Object.entries(section.properties)) {
    if (ours[k]) continue;
    props[k] = v;
    if (k === 'claudeCode.useCtrlEnterToSend') Object.assign(props, ours);
  }
  if (!props['claudeCode.followUpQueueMode']) Object.assign(props, ours);
  section.properties = props;
  return JSON.stringify(pkg, null, 2) + '\n';
}

// --------------------------------------------------------------- validation

function syntaxArgs(code, ext) {
  const tmp = path.join(os.tmpdir(), 'claude-queue-check-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + ext);
  fs.writeFileSync(tmp, code);
  return { tmp, args: ['--check', tmp], env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) };
}

function syntaxError(stderr) {
  return new Error(t('syntax', String(stderr || '').split('\n').slice(0, 4).join(' ')));
}

function checkSyntaxSync(code, ext) {
  const { tmp, args, env } = syntaxArgs(code, ext);
  try {
    const r = cp.spawnSync(process.execPath, args, { env, encoding: 'utf8', windowsHide: true });
    if (r.error) throw r.error;
    if (r.status !== 0) throw syntaxError(r.stderr);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

function checkSyntaxAsync(code, ext) {
  const { tmp, args, env } = syntaxArgs(code, ext);
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = cp.spawn(process.execPath, args, { env, windowsHide: true });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve() : reject(syntaxError(stderr))));
  }).finally(() => { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } });
}

// ------------------------------------------------------------------ apply

function prepare(dir, srcDir) {
  const id = patchId(srcDir);
  const warnings = [];
  const out = {
    'extension.js': patchHost(readOriginal(path.join(dir, 'extension.js')), id, warnings),
    [FILES[1]]: patchWebview(readOriginal(path.join(dir, FILES[1])), readRuntime(srcDir), id),
    'package.json': patchManifest(readOriginal(path.join(dir, 'package.json')))
  };
  return { id, out, warnings };
}

function commit(dir, srcDir, out) {
  for (const f of FILES) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file + BACKUP)) fs.copyFileSync(file, file + BACKUP);
    fs.writeFileSync(file, out[f]);
  }
  const payload = path.join(dir, PAYLOAD_DIR);
  fs.mkdirSync(payload, { recursive: true });
  for (const f of PAYLOAD_FILES) fs.copyFileSync(path.join(srcDir, f), path.join(payload, f));
}

function patchDirSync(dir, srcDir) {
  const id = patchId(srcDir);
  if (isFullyPatched(dir, id)) return { unchanged: true, warnings: [] };
  const { out, warnings } = prepare(dir, srcDir);
  checkSyntaxSync(out[FILES[1]], '.mjs');
  checkSyntaxSync(out['extension.js'], '.cjs');
  commit(dir, srcDir, out);
  return { unchanged: false, warnings };
}

async function patchDirAsync(dir, srcDir) {
  const id = patchId(srcDir);
  if (isFullyPatched(dir, id)) return { unchanged: true, warnings: [] };
  const { out, warnings } = prepare(dir, srcDir);
  await checkSyntaxAsync(out[FILES[1]], '.mjs');
  await checkSyntaxAsync(out['extension.js'], '.cjs');
  if (isFullyPatched(dir, id)) return { unchanged: true, warnings: [] }; // another window was faster
  commit(dir, srcDir, out);
  return { unchanged: false, warnings };
}

function unpatchDir(dir) {
  let restored = 0;
  for (const f of FILES) {
    const file = path.join(dir, f);
    if (fs.existsSync(file + BACKUP)) {
      fs.copyFileSync(file + BACKUP, file);
      fs.unlinkSync(file + BACKUP);
      restored++;
    }
  }
  try { fs.rmSync(path.join(dir, PAYLOAD_DIR), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  return restored;
}

// The editor caches extension manifests keyed by the mtime of extensions.json;
// bumping it makes the new setting show up after the next window reload.
function touchManifestCache(root) {
  const f = path.join(root, 'extensions.json');
  try { if (fs.existsSync(f)) fs.utimesSync(f, new Date(), new Date()); } catch (e) { /* ignore */ }
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ------------------------------------------------------------- auto-patch

let autoStarted = false;

// Runs inside the patched extension host: patches newer Claude Code versions that
// the editor installs next to this one, then offers to reload the window.
function startAutoPatch(selfDir, vscode) {
  if (autoStarted) return;
  autoStarted = true;
  try { if (vscode && vscode.env && vscode.env.language) lang = detectLanguage(vscode.env.language === 'en' ? undefined : vscode.env.language); } catch (e) { /* ignore */ }
  const srcDir = path.join(selfDir, PAYLOAD_DIR);
  const root = path.dirname(selfDir);
  const selfVersion = versionOf(selfDir);
  const tried = new Map(); // dir -> mtime of extension.js when it last failed
  let running = false;
  let timer = null;

  const notify = (msg, isError) => {
    try {
      if (!vscode) return;
      if (isError) { vscode.window.showWarningMessage(msg); return; }
      vscode.window.showInformationMessage(msg, t('reloadButton')).then((choice) => {
        if (choice) vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, () => {});
    } catch (e) { /* ignore */ }
  };

  async function check() {
    if (running) return;
    running = true;
    try {
      for (const dir of claudeExtensions(root)) {
        if (dir === selfDir || compareVersions(versionOf(dir), selfVersion) <= 0) continue;
        if (patchedIdOf(dir)) continue;
        let mtime = 0;
        try { mtime = fs.statSync(path.join(dir, 'extension.js')).mtimeMs; } catch (e) { continue; }
        if (tried.get(dir) === mtime) continue;
        const lock = path.join(dir, '.cq-lock');
        let fd;
        try { fd = fs.openSync(lock, 'wx'); } catch (e) {
          try { if (Date.now() - fs.statSync(lock).mtimeMs > 120000) fs.unlinkSync(lock); } catch (x) { /* ignore */ }
          continue;
        }
        try {
          const { unchanged } = await patchDirAsync(dir, srcDir);
          if (!unchanged) {
            touchManifestCache(root);
            notify(t('autoDone', versionOf(dir)));
          }
        } catch (e) {
          tried.set(dir, mtime);
          console.error('[claude-queue] auto-patch failed for', dir, e);
          notify(t('autoFailed', versionOf(dir), e.message), true);
        } finally {
          try { fs.closeSync(fd); fs.unlinkSync(lock); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) {
      console.error('[claude-queue] auto-patch check failed', e);
    } finally {
      running = false;
    }
  }

  const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(check, ms); };
  schedule(1000);
  try { fs.watch(root, () => schedule(3000)).on('error', () => {}); } catch (e) { /* polling below still works */ }
  const interval = setInterval(check, 30 * 60 * 1000);
  if (interval.unref) interval.unref();
}

// --------------------------------------------------------------------- CLI

function cli(argv) {
  const say = (s) => process.stdout.write((s || '') + '\n');
  const command = argv.includes('--unpatch') || argv.includes('--uninstall') ? 'unpatch' : argv.includes('--status') ? 'status' : 'patch';
  const opt = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : null);
  const dirArg = opt('--dir');
  if (opt('--lang')) lang = opt('--lang') === 'ru' ? 'ru' : 'en';
  const noTouch = argv.includes('--no-touch');
  const srcDir = __dirname;

  const targets = [];
  if (dirArg) targets.push({ root: path.dirname(path.resolve(dirArg)), dir: path.resolve(dirArg) });
  else for (const root of extensionRoots()) for (const dir of claudeExtensions(root)) targets.push({ root, dir });

  say(t('title', PATCH_VERSION));
  say();
  if (!targets.length) {
    say(t('notFound', EDITOR_DIRS.slice(0, 5).map((d) => '~/' + d + '/extensions').join(', ')));
    return 1;
  }

  let failed = 0;
  let changed = 0;
  const touched = new Set();
  for (const { root, dir } of targets) {
    const label = path.basename(path.dirname(root)) + ' · Claude Code ' + versionOf(dir);
    try {
      if (command === 'status') {
        const id = patchedIdOf(dir);
        say((id ? '[ok] ' : '[--] ') + label + ' — ' + (id ? t('statusOk', id) : t('statusNo')));
        continue;
      }
      if (command === 'unpatch') {
        const n = unpatchDir(dir);
        say((n ? '[ok] ' : '[--] ') + label + ' — ' + (n ? t('restored') : t('nothingToRestore')));
        if (n) { changed++; touched.add(root); }
        continue;
      }
      const { warnings, unchanged } = patchDirSync(dir, srcDir);
      say('[ok] ' + label + ' — ' + (unchanged ? t('upToDate') : t('installed')));
      for (const w of warnings) say('     ' + t('warning', w));
      if (!unchanged) { changed++; touched.add(root); }
    } catch (e) {
      failed++;
      say('[!!] ' + label + ' — ' + t('failed', e.message));
      say('     ' + t('untouched'));
    }
  }

  if (!noTouch) for (const root of touched) touchManifestCache(root);
  say();
  if (command !== 'status' && changed) say(t('reload'));
  return failed ? 2 : 0;
}

module.exports = { PATCH_VERSION, patchDirSync, patchDirAsync, unpatchDir, patchedIdOf, startAutoPatch, compareVersions };

if (require.main === module) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (e) {
    process.stdout.write(t('error', (e && e.stack) || e) + '\n');
    process.exitCode = 1;
  }
}
