import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ConflictEntry, MutagenManager } from './mutagenManager';
import { log, logDebug } from './logger';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Messages between webview ↔ extension
// ---------------------------------------------------------------------------

type WebviewToExtension =
  | { type: 'useLocal';    filePath: string; localAbsPath: string }
  | { type: 'useRemote';   filePath: string; localAbsPath: string; remoteTempPath: string }
  | { type: 'viewDiff';    filePath: string; localAbsPath: string; remoteTempPath: string }
  | { type: 'refresh' };

type ExtensionToWebview =
  | { type: 'resolveOk';       filePath: string }
  | { type: 'resolveError';    filePath: string; message: string }
  | { type: 'updateConflicts'; html: string };

// ---------------------------------------------------------------------------
// ConflictResolver
// ---------------------------------------------------------------------------

export class ConflictResolver implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly extensionUri: vscode.Uri;
  private manager: MutagenManager | null = null;
  private workspaceFolder: vscode.WorkspaceFolder | null = null;
  /** Temp files fetched from the remote for diff/resolution — cleaned up on panel close. */
  private tempFiles: string[] = [];

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  public async open(
    manager: MutagenManager,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<void> {
    this.manager = manager;
    this.workspaceFolder = workspaceFolder;
    const status = manager.getStatus();

    if (status.conflicts.length === 0) {
      await vscode.window.showInformationMessage('Mutagen Sync: No conflicts to resolve.');
      return;
    }

    log(`Opening conflict panel: ${status.conflicts.length} conflict(s)`);
    status.conflicts.forEach(c => log(`  conflict path: "${c.path}"`));

    // Clean up any temp files from a previous open before re-enriching
    this.cleanupTempFiles();

    const enriched = await this.enrichConflicts(status.conflicts, workspaceFolder);

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.sendMessage({ type: 'updateConflicts', html: this.buildConflictList(enriched) });
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'mutagenConflicts',
      'Sync Conflicts',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.webview.html = this.buildHtml(enriched);

    this.panel.webview.onDidReceiveMessage(async (msg: WebviewToExtension) => {
      await this.handleMessage(msg);
    });

    this.panel.onDidDispose(() => {
      this.panel = null;
      // Clean up all temp remote files when the panel is closed
      this.cleanupTempFiles();
    });
  }

  /**
   * Close the conflict panel if it is tied to the given manager instance.
   * Called by extension.ts when a session is torn down to prevent the panel
   * from holding a reference to a disposed manager.
   */
  public clearSession(manager: MutagenManager): void {
    if (this.manager === manager) {
      this.panel?.dispose(); // triggers onDidDispose → this.panel = null, temp cleanup
      this.manager = null;
      this.workspaceFolder = null;
    }
  }

  public dispose(): void {
    this.panel?.dispose();
    this.cleanupTempFiles();
  }

  // -------------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------------

  private async handleMessage(msg: WebviewToExtension): Promise<void> {
    if (!this.manager || !this.workspaceFolder) return;
    log(`Conflict panel message: ${msg.type}`);

    try {
      switch (msg.type) {
        case 'useLocal': {
          // Mutagen v0.18 has no CLI resolve command.
          // Resolution = make both sides identical, then flush so Mutagen
          // re-scans and clears the conflict.
          // "Use Local" → push local file to remote via scp.
          await this.resolveByPushingLocal(msg.filePath, msg.localAbsPath);
          await this.sendMessage({ type: 'resolveOk', filePath: msg.filePath });
          void vscode.window.showInformationMessage(
            `Kept local version of "${msg.filePath}" — pushing to server.`
          );
          break;
        }

        case 'useRemote': {
          // "Use Server" → overwrite local file with the remote temp copy.
          if (!msg.remoteTempPath || !fs.existsSync(msg.remoteTempPath)) {
            throw new Error('Remote file not available — try "View Diff" to fetch it first.');
          }
          log(`Overwriting local "${msg.localAbsPath}" with remote temp "${msg.remoteTempPath}"`);
          fs.copyFileSync(msg.remoteTempPath, msg.localAbsPath);
          // Clean up the temp file now that it has been consumed
          this.cleanupTempFile(msg.remoteTempPath);
          await this.manager.flush();
          await this.sendMessage({ type: 'resolveOk', filePath: msg.filePath });
          void vscode.window.showInformationMessage(
            `Kept server version of "${msg.filePath}" — local file updated.`
          );
          break;
        }

        case 'viewDiff': {
          // Open VS Code's built-in diff editor (red/green coloring)
          if (!msg.localAbsPath) {
            void vscode.window.showErrorMessage('Cannot open diff: local path unknown.');
            return;
          }
          const localUri = vscode.Uri.file(msg.localAbsPath);

          if (!msg.remoteTempPath || !fs.existsSync(msg.remoteTempPath)) {
            // No remote temp file — just open local
            await vscode.window.showTextDocument(localUri);
            void vscode.window.showInformationMessage(
              'Remote file could not be fetched. Showing local only.'
            );
            return;
          }

          const remoteUri = vscode.Uri.file(msg.remoteTempPath);
          const label = path.basename(msg.localAbsPath);
          // vscode.diff shows: left=remote (theirs), right=local (yours)
          await vscode.commands.executeCommand(
            'vscode.diff',
            remoteUri,
            localUri,
            `${label}: Server (red) ↔ Local (green)`
          );
          break;
        }

        case 'refresh': {
          if (!this.workspaceFolder) return;
          // Clean up stale temp files before re-fetching
          this.cleanupTempFiles();
          const status = this.manager.getStatus();
          const enriched = await this.enrichConflicts(status.conflicts, this.workspaceFolder);
          await this.sendMessage({ type: 'updateConflicts', html: this.buildConflictList(enriched) });
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Conflict action error: ${message}`);
      if (msg.type === 'useLocal' || msg.type === 'useRemote') {
        await this.sendMessage({ type: 'resolveError', filePath: msg.filePath, message });
        void vscode.window.showErrorMessage(`Failed to resolve conflict: ${message}`);
      } else {
        void vscode.window.showErrorMessage(`Conflict action failed: ${message}`);
      }
    }
  }

  private async sendMessage(msg: ExtensionToWebview): Promise<void> {
    await this.panel?.webview.postMessage(msg);
  }

  // -------------------------------------------------------------------------
  // Enrichment — fetch remote file for diff
  // -------------------------------------------------------------------------

  private async enrichConflicts(
    conflicts: ConflictEntry[],
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<EnrichedConflict[]> {
    const enriched: EnrichedConflict[] = [];

    for (const conflict of conflicts) {
      logDebug(`Enriching conflict: path="${conflict.path}"`);

      if (!conflict.path) {
        enriched.push({
          path: '(unknown — see output log)',
          localAbsPath: '',
          remoteTempPath: '',
          error: 'Enable mutagenSync.debug and check the "Mutagen Sync" output channel for the raw conflict JSON.'
        });
        continue;
      }

      const localAbsPath = path.join(workspaceFolder.uri.fsPath, conflict.path);
      const localExists = fs.existsSync(localAbsPath);
      let remoteTempPath = '';
      let error = '';

      if (!localExists) {
        error = `Local file not found: ${localAbsPath}`;
      }

      try {
        remoteTempPath = await this.fetchRemoteFile(conflict.path, workspaceFolder);
      } catch (e) {
        logDebug(`Remote fetch failed for "${conflict.path}":`, e);
        if (!error) error = 'Could not fetch remote file for diff (check SSH access)';
      }

      enriched.push({ path: conflict.path, localAbsPath, remoteTempPath, error });
    }

    return enriched;
  }

  /**
   * Resolve a conflict by pushing the local file to the remote server via scp,
   * making both sides identical so Mutagen clears the conflict on next flush.
   */
  private async resolveByPushingLocal(
    relativePath: string,
    localAbsPath: string
  ): Promise<void> {
    if (!this.workspaceFolder) throw new Error('No workspace folder');
    if (!this.manager) throw new Error('No manager');
    const { readConfig } = await import('./config');
    const config = readConfig(this.workspaceFolder);
    if (!config) throw new Error('Cannot read config');

    const remoteFilePath = path.posix.join(config.remotePath, relativePath);
    const scpArgs = [
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      '-P', String(config.port),
      localAbsPath,
      `${config.username}@${config.host}:${remoteFilePath}`
    ];

    log(`scp (push local→remote): ${scpArgs.join(' ')}`);
    await execFileAsync('scp', scpArgs, { timeout: 15000 });
    await this.manager.flush();
  }

  private async fetchRemoteFile(
    relativePath: string,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<string> {
    const { readConfig } = await import('./config');
    const config = readConfig(workspaceFolder);
    if (!config) return '';

    const remoteFilePath = path.posix.join(config.remotePath, relativePath);
    const tempFile = path.join(
      os.tmpdir(),
      `mutagen-remote-${Date.now()}-${path.basename(relativePath)}`
    );

    const scpArgs = [
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      '-P', String(config.port),
      `${config.username}@${config.host}:${remoteFilePath}`,
      tempFile
    ];

    logDebug(`scp ${scpArgs.join(' ')}`);
    await execFileAsync('scp', scpArgs, { timeout: 15000 });

    // Track so we can clean it up when the panel closes or on next refresh
    this.tempFiles.push(tempFile);
    return tempFile;
  }

  // -------------------------------------------------------------------------
  // Temp file cleanup
  // -------------------------------------------------------------------------

  private cleanupTempFiles(): void {
    for (const f of this.tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // Best effort
      }
    }
    this.tempFiles = [];
  }

  private cleanupTempFile(filePath: string): void {
    const idx = this.tempFiles.indexOf(filePath);
    if (idx >= 0) this.tempFiles.splice(idx, 1);
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Best effort
    }
  }

  // -------------------------------------------------------------------------
  // HTML
  // -------------------------------------------------------------------------

  private buildHtml(conflicts: EnrichedConflict[]): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sync Conflicts</title>
  <style>
    :root {
      --border:     var(--vscode-panel-border, #444);
      --bg:         var(--vscode-editor-background, #1e1e1e);
      --fg:         var(--vscode-editor-foreground, #d4d4d4);
      --header-bg:  var(--vscode-editorGroupHeader-tabsBackground, #252526);
      --btn-bg:     var(--vscode-button-background, #0e639c);
      --btn-fg:     var(--vscode-button-foreground, #fff);
      --btn-hover:  var(--vscode-button-hoverBackground, #1177bb);
      --btn2-bg:    var(--vscode-button-secondaryBackground, #3a3d41);
      --btn2-fg:    var(--vscode-button-secondaryForeground, #d4d4d4);
      --btn2-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --warning:    var(--vscode-editorWarning-foreground, #cca700);
      --error:      var(--vscode-editorError-foreground, #f14c4c);
      --font:       var(--vscode-font-family, 'Segoe UI', sans-serif);
      --mono:       var(--vscode-editor-font-family, monospace);
      --font-size:  var(--vscode-font-size, 13px);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--fg); font-family: var(--font); font-size: var(--font-size); padding: 20px; }
    h1 { font-size: 1.15em; font-weight: 600; margin-bottom: 4px; }
    .subtitle { color: var(--warning); font-size: 0.9em; margin-bottom: 20px; }
    .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
    .refresh-btn { background: none; border: 1px solid var(--border); border-radius: 3px;
                   color: var(--fg); cursor: pointer; font-size: 0.85em; padding: 3px 10px;
                   opacity: 0.7; }
    .refresh-btn:hover { opacity: 1; }

    .conflict-list { display: flex; flex-direction: column; gap: 8px; }

    .conflict-row {
      display: flex; align-items: center; gap: 12px;
      border: 1px solid var(--border); border-radius: 4px;
      padding: 10px 14px;
      transition: opacity 0.2s;
    }
    .conflict-row.resolving { opacity: 0.4; pointer-events: none; }
    .conflict-row.resolved  { display: none; }

    .conflict-path {
      flex: 1; font-family: var(--mono); font-size: 0.9em;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .conflict-error-inline {
      color: var(--error); font-size: 0.8em; margin-top: 2px;
    }

    .actions { display: flex; gap: 6px; flex-shrink: 0; }

    button {
      padding: 4px 12px; border: none; border-radius: 3px;
      cursor: pointer; font-size: 0.88em; font-family: var(--font);
      white-space: nowrap;
    }
    button:disabled { opacity: 0.35; cursor: default; }
    .btn-primary   { background: var(--btn-bg);  color: var(--btn-fg); }
    .btn-primary:hover:not(:disabled)   { background: var(--btn-hover); }
    .btn-secondary { background: var(--btn2-bg); color: var(--btn2-fg); }
    .btn-secondary:hover:not(:disabled) { background: var(--btn2-hover); }

    .resolve-err {
      font-size: 0.8em; color: var(--error); margin-top: 4px;
    }

    .no-conflicts { text-align: center; padding: 40px; opacity: 0.6; }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>⚠ Sync Conflicts</h1>
    <button class="refresh-btn" id="refresh-btn">↻ Refresh</button>
  </div>
  <p class="subtitle">Both sides modified these files. Choose which version to keep.</p>

  <div id="conflict-list" class="conflict-list">
    ${this.buildConflictList(conflicts)}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // --------------- event delegation — no inline onclick ---------------
    document.getElementById('conflict-list').addEventListener('click', e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;
      const row = btn.closest('.conflict-row');
      const filePath     = row.dataset.path;
      const localAbsPath = row.dataset.localAbs;
      const remoteTmp    = row.dataset.remoteTmp;
      const action       = btn.dataset.action;

      if (action === 'useLocal' || action === 'useRemote') {
        row.classList.add('resolving');
      }

      if (action === 'useLocal') {
        vscode.postMessage({ type: 'useLocal', filePath, localAbsPath });
      } else if (action === 'useRemote') {
        vscode.postMessage({ type: 'useRemote', filePath, localAbsPath, remoteTempPath: remoteTmp });
      } else if (action === 'viewDiff') {
        vscode.postMessage({ type: 'viewDiff', filePath, localAbsPath, remoteTempPath: remoteTmp });
      }
    });

    document.getElementById('refresh-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    // --------------- messages from extension ---------------
    window.addEventListener('message', event => {
      const msg = event.data;

      if (msg.type === 'resolveOk') {
        const row = getRow(msg.filePath);
        if (row) row.classList.replace('resolving', 'resolved');
        checkAllResolved();
      }

      if (msg.type === 'resolveError') {
        const row = getRow(msg.filePath);
        if (row) {
          row.classList.remove('resolving');
          let errEl = row.querySelector('.resolve-err');
          if (!errEl) {
            errEl = document.createElement('div');
            errEl.className = 'resolve-err';
            row.appendChild(errEl);
          }
          errEl.textContent = '⚠ ' + msg.message;
        }
      }

      if (msg.type === 'updateConflicts') {
        document.getElementById('conflict-list').innerHTML = msg.html;
      }
    });

    function getRow(filePath) {
      // Use attribute selector with single-quoted value — safe for any path
      return document.querySelector('.conflict-row[data-path=' + CSS.escape(filePath) + ']');
    }

    function checkAllResolved() {
      const remaining = document.querySelectorAll('.conflict-row:not(.resolved)');
      if (remaining.length === 0) {
        document.getElementById('conflict-list').innerHTML =
          '<div class="no-conflicts">✓ All conflicts resolved!</div>';
      }
    }
  </script>
</body>
</html>`;
  }

  private buildConflictList(conflicts: EnrichedConflict[]): string {
    if (conflicts.length === 0) {
      return '<div class="no-conflicts">No conflicts at this time.</div>';
    }
    return conflicts.map(c => this.buildConflictRow(c)).join('\n');
  }

  private buildConflictRow(conflict: EnrichedConflict): string {
    const hasPath    = !!conflict.path && conflict.path !== '(unknown — see output log)';
    const hasDiff    = hasPath && !!conflict.remoteTempPath;
    const disResolve = hasPath  ? '' : ' disabled';
    const disDiff    = hasDiff  ? '' : ' disabled';
    const errHtml    = conflict.error
      ? `<div class="conflict-error-inline">⚠ ${escapeHtml(conflict.error)}</div>`
      : '';

    // All paths go into data-* attributes (HTML-attribute-escaped)
    // so they can never break the HTML structure or button behaviour.
    return `<div class="conflict-row"
     data-path="${escapeAttr(conflict.path)}"
     data-local-abs="${escapeAttr(conflict.localAbsPath)}"
     data-remote-tmp="${escapeAttr(conflict.remoteTempPath)}">
  <div style="flex:1;min-width:0">
    <div class="conflict-path" title="${escapeAttr(conflict.path)}">${escapeHtml(conflict.path)}</div>
    ${errHtml}
  </div>
  <div class="actions">
    <button class="btn-primary"   data-action="useLocal"${disResolve}>Use Local</button>
    <button class="btn-primary"   data-action="useRemote"${disResolve}>Use Server</button>
    <button class="btn-secondary" data-action="viewDiff"${disDiff}>View Diff</button>
  </div>
</div>`;
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface EnrichedConflict extends ConflictEntry {
  localAbsPath: string;
  remoteTempPath: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}
