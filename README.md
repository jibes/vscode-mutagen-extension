# Mutagen Sync

A VS Code / Cursor extension that keeps your local workspace in continuous two-way sync with a remote server using [Mutagen](https://mutagen.io). Designed for editing on a powerful local machine while running and testing code on a remote server over SSH.

---

## Features

- **Zero-install** — downloads the Mutagen binary and agent bundle automatically on first use
- **Two-way-safe sync** — both sides are kept identical; conflicts are surfaced explicitly, never silently overwritten
- **Setup wizard** — one-time guided setup: SSH key auth (tests existing key first, only asks for password if needed), known-hosts registration, config write
- **Live status bar** — shows sync state (Watching, Syncing, Conflict, Disconnected, Paused) at a glance
- **Conflict resolution panel** — side-by-side VS Code native diff with *Use Local* / *Use Server* / *View Diff* actions
- **Configurable ignores** — all ignore patterns are written to `.vscode/remote-sync.json`; delete any you don't want
- **Session pause on close** — workspace close pauses the session; reopening resumes it instantly
- **Auto-resume** — reopening a workspace that has a config automatically reconnects without any extra steps
- **Debug output channel** — opt-in verbose logging of every CLI call and status transition

---

## Requirements

Mutagen is **automatically downloaded** from GitHub Releases on first use — no manual installation needed. If automatic download fails (air-gapped machine, etc.) you can install Mutagen manually and point the extension to it via the `mutagenSync.mutagenPath` setting.

- VS Code ≥ 1.85 or Cursor
- SSH access to the remote server
- macOS or Linux (Windows builds are included but untested)

---

## Quick Start

1. Open a workspace folder
2. Click the **$(plug) Mutagen: Not connected** item in the status bar, or run **Remote Sync: Connect to Server** from the command palette
3. Follow the 4-step wizard:
   - Enter host, port, username, remote path *(pre-filled automatically from `.vscode/sftp.json` if present, otherwise from the workspace's SSH git remote)*
   - The extension tests your existing SSH key; if it doesn't work it will ask for your password and install the key for you
4. Sync starts automatically — the status bar turns to **$(check) Watching** when all files are in sync

> **Tip:** On subsequent workspace opens, the extension auto-connects using the saved `.vscode/remote-sync.json` — no wizard needed.

---

## Configuration

All per-project settings live in `.vscode/remote-sync.json`:

```json
{
  "host": "192.168.2.4",
  "port": 22,
  "username": "ubuntu",
  "remotePath": "/var/www/myproject/",
  "ignore": [
    ".git",
    ".env",
    "*.env",
    ".env.*",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini"
  ]
}
```

The wizard pre-fills `ignore` with the defaults above. Add any extra patterns you need (e.g. `"node_modules"`, `"dist"`, `"*.log"`). There are no hidden hardcoded ignores — the config is the single source of truth.

> **After editing ignore patterns, click the status bar → Reconnect** (or Disconnect + Connect). Ignore patterns are passed as flags when the Mutagen session is created and are not reloaded while the session is running.

#### Ignore pattern syntax

Mutagen uses **gitignore-style** patterns:

| Pattern | What it matches |
|---|---|
| `node_modules` | Any file or directory named `node_modules` anywhere in the tree |
| `.excluded_file` | Any file named `.excluded_file` anywhere in the tree |
| `*.log` | Any file ending in `.log` |
| `logs/` | Any directory named `logs` (trailing `/` = directories only) |
| `src/*.test.ts` | Files matching `*.test.ts` directly inside any `src/` directory |
| `**/temp` | Any file or directory named `temp` at any depth (explicit — same as without `**`) |

Patterns **without a `/`** (other than a trailing one) match against the **filename only**, anywhere in the tree. Patterns **with a `/`** are matched against the full relative path from the sync root.

### VS Code Settings

| Setting | Default | Description |
|---|---|---|
| `mutagenSync.mutagenPath` | `"mutagen"` | Path to mutagen binary. Leave default to use the auto-downloaded binary or system PATH. |
| `mutagenSync.pollIntervalMs` | `2000` | How often to poll session status (ms) |
| `mutagenSync.debug` | `false` | Enable verbose debug logging in the output channel |

---

## Commands

| Command | Description |
|---|---|
| **Remote Sync: Connect to Server** | Run the setup wizard for the current workspace |
| **Remote Sync: Pause Sync** | Pause the active session |
| **Remote Sync: Resume Sync** | Resume a paused session |
| **Remote Sync: Reconnect** | Restart the sync session without changing config |
| **Remote Sync: Resolve Conflicts** | Open the conflict resolution panel |
| **Remote Sync: Open Configuration** | Open `.vscode/remote-sync.json` |
| **Remote Sync: Disconnect** | Terminate the session (offers keep or remove config) |
| **Remote Sync: Show Output Log** | Open the "Mutagen Sync" output channel |

---

## Conflict Resolution

When the same file is modified on both sides simultaneously, Mutagen enters conflict state and stops syncing that file. The extension surfaces this with a `$(warning)` status bar icon and a notification.

Opening the conflict panel shows each conflicting file with its local and remote versions side by side (VS Code native diff). For each file you can:

- **Use Local** — overwrite the remote file with your local version
- **Use Server** — overwrite your local file with the remote version
- **View Diff** — open VS Code's diff editor for manual merging

After resolving, Mutagen re-scans immediately and clears the conflict.

---

## Debug Logging

Enable `"mutagenSync.debug": true` in your VS Code settings, then open **View → Output** and select **Mutagen Sync** from the dropdown (or run **Remote Sync: Show Output Log**).

You'll see every `mutagen` CLI invocation, raw JSON responses, and all state transitions — useful for diagnosing connection issues or unexpected behaviour.

---

## How It Works

The extension wraps [Mutagen](https://mutagen.io) — a purpose-built file synchronisation tool that uses the rsync algorithm over SSH with an agent installed on the remote side. Mutagen handles reconnection, delta transfers, and conflict detection natively.

The extension's role is:
1. **Installer** — downloads the correct Mutagen binary + agent bundle for your platform into VS Code's `globalStorage` on first use
2. **Session manager** — creates/resumes/pauses Mutagen sync sessions keyed by workspace folder; stale sessions from previous crashed runs are cleaned up automatically
3. **Status poller** — polls `mutagen sync list` every 2 seconds and maps the JSON output to status bar states; daemon/client version mismatches are detected and recovered automatically
4. **Conflict UI** — fetches remote file content via `scp` and presents a resolution interface

---

## License

[MIT](LICENSE)
