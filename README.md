<div align="center">

# Claude Code Queue Mode

**Codex-style follow-up queue for the Claude Code extension in Cursor and VS Code.**
Keep typing while Claude works — your messages wait in a queue and run one by one,
or steer / interrupt the current run when you want to.

[![Latest release](https://img.shields.io/github/v/release/n1ghtmare-dev/claude-code-queue-mode?label=release&color=d97757)](https://github.com/n1ghtmare-dev/claude-code-queue-mode/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Cursor | VS Code | Windsurf](https://img.shields.io/badge/editors-Cursor%20%7C%20VS%20Code%20%7C%20Windsurf-555)
![Windows | macOS | Linux](https://img.shields.io/badge/os-Windows%20%7C%20macOS%20%7C%20Linux-555)

[Install](#install) · [How it works](#how-it-works) · [Shortcuts](#keyboard-shortcuts) · [FAQ](#faq) · [Русский](README.ru.md)

<img src="docs/demo.gif" alt="Messages typed while Claude is running tests wait in a queue above the composer and are sent one by one" width="760">

</div>

## Why

In the Claude Code extension, anything you send while Claude is working is pushed into the run that is already going. Sometimes that's what you want. Often it isn't: you just want to line up the next task without derailing the current one.

The Codex extension solves this with a **follow-up queue**. This project adds the same queue to Claude Code:

- 📝 **Queue** — messages sent while Claude works wait above the composer and go out one at a time, each as its own turn.
- 🧭 **Steer** — send a message into the current run right away (the stock Claude Code behaviour).
- ⛔ **Interrupt** — stop the current run and handle the new message immediately.
- ⌨️ **Ctrl+Enter** does the opposite of your default for a single message.
- ✏️ Edit, reorder (drag & drop), delete or "steer now" any queued message.
- ⏸️ Pressing Stop / Esc pauses the queue; **Resume** continues it.
- 💾 The queue is kept per chat, with images and editor selections, and survives a window reload.
- 🔄 Survives Claude Code updates: the patch re-applies itself to new versions automatically.

## Install

The installer finds Claude Code in **Cursor, VS Code, VS Code Insiders and Windsurf** (including their remote servers) on **Windows, macOS and Linux**.
Node.js is optional: without it the installer uses the editor's own runtime.

**Windows** — in PowerShell:

```powershell
irm https://raw.githubusercontent.com/n1ghtmare-dev/claude-code-queue-mode/main/install.ps1 | iex
```

or [download the zip](https://github.com/n1ghtmare-dev/claude-code-queue-mode/releases/latest/download/claude-code-queue-mode.zip), extract it and double-click **`install.bat`**.

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/n1ghtmare-dev/claude-code-queue-mode/main/install.sh | bash
```

**Any OS with Node.js:**

```bash
npx -y github:n1ghtmare-dev/claude-code-queue-mode
```

Then reload the editor window: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → **Developer: Reload Window**.

> [!TIP]
> You only do this once. When your editor updates Claude Code, the patched extension carries the queue over to the new version and shows a **Reload Window** button. If that ever fails, just run the installer again.

### Uninstall

| | |
|---|---|
| Windows | `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/n1ghtmare-dev/claude-code-queue-mode/main/install.ps1))) -Uninstall` or `uninstall.bat` |
| macOS / Linux | `curl -fsSL https://raw.githubusercontent.com/n1ghtmare-dev/claude-code-queue-mode/main/install.sh \| bash -s -- --unpatch` |
| Node.js | `npx -y github:n1ghtmare-dev/claude-code-queue-mode --unpatch` |

The original files are restored from backups, then reload the window.

## How it works

Pick the default behaviour in **Settings → Claude Code › Follow Up Queue Mode** (`claudeCode.followUpQueueMode`):

| Mode | A message sent while Claude is working… |
|---|---|
| `queue` *(default)* | waits in the list above the composer and is sent as a new turn when Claude is done, one at a time |
| `steer` | goes into the current run right away; Claude picks it up between steps (stock Claude Code behaviour) |
| `interrupt` | stops the current run (like pressing Stop) and runs immediately |

You can also switch between queue and steer from the `⋯` menu of any queued message (**Turn off / on queueing**).

<img src="docs/queue.png" alt="The queue above the composer with the item menu open" width="620">

### The queue

| Action | What it does |
|---|---|
| **Steer** | send this message now — into the current run if Claude is working, as a new turn otherwise |
| 🗑 | delete the message |
| `⋯` → **Edit message** | move it back into the composer; send it again and it returns to the same place in the queue |
| drag a row | change the order |
| **Stop / Esc** | pauses the queue ("Queue paused because you interrupted") — press **Resume** to continue |
| send while paused | asks whether to **Clear queue** or just **Send message** |

<img src="docs/paused.png" alt="The queue paused after pressing Stop, with a Resume button" width="620">

### Keyboard shortcuts

| Shortcut | While Claude is working |
|---|---|
| <kbd>Enter</kbd> | your default mode (queue / steer / interrupt) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> | the opposite for this one message: queue ↔ steer |
| <kbd>Enter</kbd> in an empty composer | in steer mode, sends the first queued message right now |

If **Use Ctrl+Enter to send** is on, sending is <kbd>Ctrl</kbd>+<kbd>Enter</kbd> and the opposite action is <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd>. Hover the send button while Claude works to see both.

## FAQ

**Is this an extension?**
No. It's a small patch for the Claude Code extension you already have. The installer edits three files inside its folder (`~/.cursor/extensions/anthropic.claude-code-*` or the VS Code equivalent) and keeps the originals next to them as `*.cq-orig`.

**Is it safe?**
The patch only touches local files, makes no network requests and collects nothing. Every change is checked for syntax errors before it is written, and if Claude Code's code doesn't look the way the patch expects, it refuses to install and leaves the files alone. `--unpatch` restores the originals.

**Which Claude Code versions are supported?**
Developed and tested with Claude Code **2.1.301** in Cursor on Windows. The queue logic doesn't depend on minified names, so it should survive most updates; if an update breaks it, the installer will say so — please [open an issue](https://github.com/n1ghtmare-dev/claude-code-queue-mode/issues/new/choose).

**The queue doesn't show up.**
Reload the window first. Then check the status:

```bash
npx -y github:n1ghtmare-dev/claude-code-queue-mode --status
```

(or `install.bat --status`, `bash install.sh --status`).

**Slash commands?**
`/compact`, `/model` and other slash commands are never queued — they behave exactly as before.

**Differences from Codex**
- In Codex the `interrupt` value behaves like `steer`; here it really stops the current run.
- If you steer a message and then press Stop, Claude Code still runs that message after stopping (stock behaviour). Codex would put it back into the queue.
- After a window reload a restored queue starts paused, so nothing is sent behind your back.

## Under the hood

- `src/queue-runtime.js` is injected into Claude Code's webview. It finds the chat session through React's own data, wraps its `send` / `interrupt` methods and renders the queue above the composer. No minified identifiers are hard-coded.
- `src/patch.js` registers the `claudeCode.followUpQueueMode` setting, passes it to the webview, lets the webview save it, and copies itself into the extension so newer Claude Code versions installed next to it get patched automatically.

## Contributing

Issues and pull requests are welcome. When reporting a problem, include your editor, OS, Claude Code version and the output of `--status`.

Useful commands: `npm run check` (syntax), `npm run status`, `node scripts/build.js --dist` (release archives).

## Disclaimer

This is an unofficial community project. It is not affiliated with, endorsed or supported by Anthropic or OpenAI. "Claude" and "Claude Code" are trademarks of Anthropic; "Codex" is a trademark of OpenAI. Use at your own risk.

## License

[MIT](LICENSE)
