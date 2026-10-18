# Changelog

## 1.1.0 — 2026-10-18

Know when Claude is done without watching the chat.

- `⏳` before the chat title while Claude works and `✋` while it waits for your answer; it shows on the tab, in the window title and on the taskbar button.
- Windows: a running green bar on the editor window's taskbar button while Claude works, yellow while it waits for you, and the button turns orange when it's done.
- Windows notification when Claude finishes or needs your answer, sent as the editor itself; clicking it brings back the right window. One notification for a whole queue.
- New settings: `claudeCode.workingIndicator`, `claudeCode.notifyWhenDone` (`whenUnfocused` by default, `always`, `off`).
- Notification texts follow the editor language, or the Windows regional format when the editor is in English.
- `CLAUDE_QUEUE_DEBUG=1` logs the indicator to `%TEMP%\claude-queue-activity.log`.
- Unit tests: `npm test`.

## 1.0.0 — 2026-10-16

First release.

- Follow-up queue for the Claude Code extension: messages sent while Claude works wait above the composer and are sent one by one.
- `claudeCode.followUpQueueMode` setting: `queue` (default), `steer`, `interrupt`.
- <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> with *Use Ctrl+Enter to send*) does the opposite of the mode for one message.
- Queue actions: Steer, delete, edit (returns to the same place), drag to reorder, turn queueing off/on.
- Stop / Esc pauses the queue; Resume continues it; sending while paused asks to clear the queue or send.
- The queue is stored per chat with attachments and editor selections and is restored (paused) after a window reload.
- Installers for Windows (`install.ps1`, `install.bat`), macOS / Linux (`install.sh`) and `npx`; work without Node.js by using the editor's runtime.
- The patched extension re-applies the patch to newer Claude Code versions installed by the editor and offers to reload.
- Tested with Claude Code 2.1.301 in Cursor on Windows.
