import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RemoteSyncConfig, deriveSessionName } from './config';
import { log, logDebug, logCmd } from './logger';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types matching Mutagen's JSON output
// ---------------------------------------------------------------------------

export type SyncState =
  | 'syncing'
  | 'watching'
  | 'conflict'
  | 'disconnected'
  | 'paused'
  | 'unknown';

export interface ConflictEntry {
  /** Relative path of the conflicting file */
  path: string;
  /** Local version content (may be empty if not retrievable) */
  localContent?: string;
  /** Remote version content (may be empty if not retrievable) */
  remoteContent?: string;
}

export interface SyncStatus {
  state: SyncState;
  sessionName: string;
  conflicts: ConflictEntry[];
  /** Human-readable description of current status */
  description: string;
}

// ---------------------------------------------------------------------------
// Mutagen v0.18 JSON shape from `mutagen sync list --template '{{json .}}'`
//
// Returns a flat JSON array.  Each element represents one session.
// Fields are at the top level — there is NO wrapper object, and no
// nested `session` key.
//
// Example element:
// {
//   "identifier": "sync_Cq5JUFEfso5mg...",
//   "name": "my-project",
//   "paused": false,
//   "status": "watching",               // lowercase string
//   "alpha": { "protocol": "local", "path": "/local/path", "connected": true,
//              "scanned": true, "files": 10, "directories": 3, ... },
//   "beta":  { "protocol": "ssh",   "host": "1.2.3.4", "user": "ubuntu",
//              "path": "/remote/path", "connected": true, ... },
//   "mode": "two-way-safe",
//   "successfulCycles": 2,
//   "conflicts": [{ "path": "foo.txt", "alphaChange": {...}, "betaChange": {...} }],
//   "stagingStatus": { "receivedFiles": 5, "totalFiles": 100 }  // during staging
// }
// ---------------------------------------------------------------------------

interface MutagenEndpoint {
  protocol?: string;
  path?: string;
  host?: string;
  user?: string;
  connected?: boolean;
  scanned?: boolean;
  files?: number;
  directories?: number;
  totalFileSize?: number;
}

interface MutagenConflict {
  /** Mutagen v0.18 uses "root" for the conflict path in JSON output */
  root?: string;
  /** Fallback: older or alternative field name */
  path?: string;
  alphaChanges?: unknown[];
  betaChanges?: unknown[];
  /** Older singular forms — kept for compat */
  alphaChange?: unknown;
  betaChange?: unknown;
}

interface MutagenStagingStatus {
  receivedFiles?: number;
  totalFiles?: number;
}

interface MutagenSession {
  identifier?: string;
  name?: string;
  paused?: boolean;
  /** Lowercase status string, e.g. "watching", "syncing", "scanning", "staging" */
  status?: string;
  alpha?: MutagenEndpoint;
  beta?: MutagenEndpoint;
  mode?: string;
  successfulCycles?: number;
  conflicts?: MutagenConflict[];
  stagingStatus?: MutagenStagingStatus;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Module-level helper: list all sessions without a manager instance.
// Used by extension.ts once during session setup for name-collision detection.
// ---------------------------------------------------------------------------

export async function listAllMutagenSessions(
  mutagenPath: string
): Promise<Array<{ name?: string; alpha?: { path?: string } }>> {
  try {
    const { stdout } = await execFileAsync(
      mutagenPath,
      ['sync', 'list', '--template', '{{json .}}'],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return [];
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed as Array<{ name?: string; alpha?: { path?: string } }>;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// MutagenManager
// ---------------------------------------------------------------------------

export class MutagenManager {
  private readonly workspaceFolder: vscode.WorkspaceFolder;
  private readonly config: RemoteSyncConfig;
  private readonly sessionName: string;
  /** Path to the mutagen binary (managed or user-configured). */
  private readonly managedBinaryPath: string | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private currentStatus: SyncStatus;

  /** Fired whenever the sync status changes */
  public readonly onStatusChanged: vscode.EventEmitter<SyncStatus> =
    new vscode.EventEmitter<SyncStatus>();

  /**
   * @param workspaceFolder  The workspace folder this session manages.
   * @param config           Remote sync config (host, port, etc.).
   * @param managedBinaryPath  Absolute path to a pre-installed mutagen binary
   *                           (e.g. from globalStorage). When provided and the
   *                           user hasn't overridden mutagenSync.mutagenPath in
   *                           settings, this path is used in preference to
   *                           searching PATH.
   * @param sessionName      Explicit session name. If omitted, derived from the
   *                         workspace folder name. Callers should pass a
   *                         persisted name (from workspaceState) to avoid
   *                         collisions between folders with similar names.
   */
  constructor(
    workspaceFolder: vscode.WorkspaceFolder,
    config: RemoteSyncConfig,
    managedBinaryPath?: string,
    sessionName?: string
  ) {
    this.workspaceFolder = workspaceFolder;
    this.config = config;
    this.managedBinaryPath = managedBinaryPath;
    this.sessionName = sessionName ?? deriveSessionName(workspaceFolder);
    this.currentStatus = {
      state: 'unknown',
      sessionName: this.sessionName,
      conflicts: [],
      description: 'Not started'
    };
    log(`MutagenManager created — session: ${this.sessionName}, binary: ${managedBinaryPath ?? 'system PATH'}`);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  public getStatus(): SyncStatus {
    return this.currentStatus;
  }

  public getSessionName(): string {
    return this.sessionName;
  }

  /**
   * Start or resume a sync session for this workspace.
   * - If a session with this name already exists (paused or running), resumes it.
   * - Otherwise creates a new session.
   */
  public async start(): Promise<void> {
    await this.checkMutagenInstalled();

    // Terminate any stale duplicate sessions that share our name but have
    // a different identifier — they accumulate from previous crashed sessions.
    await this.cleanupStaleSessions();

    const existing = await this.findExistingSession();
    log(`Existing session found: ${existing ? JSON.stringify({ name: existing.name, paused: existing.paused, status: existing.status }) : 'none'}`);

    if (existing) {
      if (existing.paused) {
        log('Resuming paused session...');
        await this.resumeSession();
      } else {
        log('Session already running — attaching poller.');
      }
    } else {
      log('Creating new session...');
      await this.createSession();
    }

    this.startPolling();
  }

  /**
   * Pause the sync session (preserves state for instant resume).
   */
  public async pause(): Promise<void> {
    log(`Pausing session ${this.sessionName}`);
    await this.runMutagen(['sync', 'pause', this.sessionName]);
    this.stopPolling();
    this.updateStatus({
      state: 'paused',
      conflicts: [],
      description: 'Paused'
    });
  }

  /**
   * Resume a paused sync session.
   */
  public async resume(): Promise<void> {
    log(`Resuming session ${this.sessionName}`);
    await this.runMutagen(['sync', 'resume', this.sessionName]);
    this.startPolling();
  }

  /**
   * Terminate and remove the sync session entirely.
   */
  public async terminate(): Promise<void> {
    log(`Terminating session ${this.sessionName}`);
    this.stopPolling();
    try {
      await this.runMutagen(['sync', 'terminate', this.sessionName]);
    } catch {
      // Session may not exist — that is acceptable
    }
  }

  /**
   * Force a sync cycle so Mutagen re-evaluates file state immediately.
   * Called after manual conflict resolution (file copy) so the conflict
   * clears without waiting for the next poll interval.
   */
  public async flush(): Promise<void> {
    log(`Flushing session ${this.sessionName}`);
    await this.runMutagen(['sync', 'flush', '--skip-wait', this.sessionName]);
  }

  public dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.onStatusChanged.dispose();
  }

  // -------------------------------------------------------------------------
  // Session lifecycle helpers
  // -------------------------------------------------------------------------

  private async createSession(): Promise<void> {
    const localPath = this.workspaceFolder.uri.fsPath;
    const { host, port, username, remotePath, ignore } = this.config;

    const ignoreArgs = ignore.flatMap(ig => [`--ignore=${ig}`]);

    // Mutagen uses scp-style URLs for default port, ssh:// for custom ports
    const remoteEndpoint =
      port !== 22
        ? `ssh://${username}@${host}:${port}${remotePath}`
        : `${username}@${host}:${remotePath}`;

    const args = [
      'sync', 'create',
      `--name=${this.sessionName}`,
      '--sync-mode=two-way-safe',
      '--default-file-mode=644',
      '--default-directory-mode=755',
      ...ignoreArgs,
      localPath,
      remoteEndpoint
    ];

    log(`Creating session: ${localPath} ↔ ${remoteEndpoint}`);
    await this.runMutagen(args);
    log('Session created successfully.');
  }

  private async resumeSession(): Promise<void> {
    try {
      await this.runMutagen(['sync', 'resume', this.sessionName]);
      log('Session resumed.');
    } catch (err) {
      // Session might be active already — check and proceed
      logDebug('Resume attempt error (may be harmless):', err);
    }
  }

  /**
   * Terminate any sessions that share the same name but are stale (e.g. from
   * a previous crashed run). Keeps the most-recently-used one (or lets
   * findExistingSession pick the live one afterwards).
   */
  private async cleanupStaleSessions(): Promise<void> {
    try {
      const matching = await this.listSessionsByName(this.sessionName);
      logDebug(`Sessions with name "${this.sessionName}": ${matching.length}`);

      if (matching.length <= 1) return;

      // Keep the first non-paused session; terminate the rest.
      const active = matching.find(s => !s.paused) ?? matching[0];
      for (const s of matching) {
        if (s.identifier && s.identifier !== active.identifier) {
          log(`Terminating stale duplicate session: ${s.identifier}`);
          try {
            await this.runMutagen(['sync', 'terminate', s.identifier]);
          } catch (e) {
            logDebug('Could not terminate stale session:', e);
          }
        }
      }
    } catch (e) {
      logDebug('cleanupStaleSessions error (non-fatal):', e);
    }
  }

  /**
   * Returns the session state if a Mutagen session exists for this workspace,
   * matched by session name.
   */
  public async findExistingSession(): Promise<MutagenSession | null> {
    try {
      const sessions = await this.listSessionsByName(this.sessionName);
      if (sessions.length === 0) return null;
      // Prefer live session over paused
      return sessions.find(s => !s.paused) ?? sessions[0];
    } catch (e) {
      logDebug('findExistingSession error:', e);
      return null;
    }
  }

  /**
   * Fetch and parse Mutagen sync sessions matching a given name.
   * Passing a name filter is more efficient than listing all sessions
   * when the user has many unrelated Mutagen sessions.
   */
  private async listSessionsByName(name: string): Promise<MutagenSession[]> {
    const { stdout } = await this.runMutagen(
      ['sync', 'list', '--template', '{{json .}}', name],
      true /* silent on error */
    );
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') {
      return [];
    }
    logDebug('listSessionsByName raw:', trimmed.length > 2000 ? trimmed.slice(0, 2000) + '…' : trimmed);
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      log('WARNING: Expected JSON array from mutagen list, got:', typeof parsed);
      return [];
    }
    return parsed as MutagenSession[];
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private get pollIntervalMs(): number {
    return vscode.workspace.getConfiguration('mutagenSync').get<number>('pollIntervalMs') ?? 2000;
  }

  private startPolling(): void {
    this.stopPolling();
    const poll = async () => {
      await this.pollStatus();
      // Guard: don't reschedule if dispose() was called while pollStatus() was running
      if (!this.disposed) {
        this.pollTimer = setTimeout(poll, this.pollIntervalMs);
      }
    };
    // Start immediately
    void poll();
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollStatus(): Promise<void> {
    try {
      // Poll only this session by name for efficiency
      const { stdout } = await this.runMutagen(
        ['sync', 'list', '--template', '{{json .}}', this.sessionName],
        true
      );
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === 'null') {
        logDebug('pollStatus: empty response');
        this.updateStatus({ state: 'unknown', conflicts: [], description: 'Session not found' });
        return;
      }

      logDebug('pollStatus raw:', trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed);

      const parsed = JSON.parse(trimmed);
      const sessions: MutagenSession[] = Array.isArray(parsed) ? parsed : [];
      const st = sessions.find(s => s.name === this.sessionName);

      if (!st) {
        logDebug('Session not found in poll response');
        this.updateStatus({ state: 'unknown', conflicts: [], description: 'Session not found' });
        return;
      }

      const result = this.parseSessionStatus(st);
      logDebug(`pollStatus parsed → state=${result.state}, desc="${result.description}"`);
      this.updateStatus(result);
    } catch (err) {
      logDebug('pollStatus error:', err);
      this.updateStatus({
        state: 'disconnected',
        conflicts: [],
        description: `Error: ${String(err)}`
      });
    }
  }

  private parseSessionStatus(
    st: MutagenSession
  ): Pick<SyncStatus, 'state' | 'conflicts' | 'description'> {
    // Paused flag is at the top level
    if (st.paused) {
      return { state: 'paused', conflicts: [], description: 'Paused' };
    }

    // Extract conflicts.
    // Mutagen v0.18 JSON uses "root" for the conflict path; older/alternative
    // serialisations may use "path".  Log unknown shape for debugging.
    const conflicts: ConflictEntry[] = (st.conflicts ?? []).map(c => {
      const conflictPath = c.root ?? c.path;
      if (!conflictPath) {
        logDebug('Conflict entry has no root/path field — raw:', JSON.stringify(c));
      }
      return { path: conflictPath ?? '' };
    });

    if (conflicts.length > 0) {
      return {
        state: 'conflict',
        conflicts,
        description: `Conflict (${conflicts.length})`
      };
    }

    // Connection status — use alpha/beta connected booleans.
    // Only report disconnected when we have an explicit false;
    // undefined means the field isn't present (local alpha is always connected).
    if (st.alpha?.connected === false || st.beta?.connected === false) {
      const side = st.alpha?.connected === false ? 'local' : 'remote';
      return {
        state: 'disconnected',
        conflicts: [],
        description: `Disconnected (${side})`
      };
    }

    // Status string — lowercase (e.g. "watching", "scanning", "staging", etc.)
    const statusStr = (st.status ?? '').toLowerCase();

    if (
      statusStr.includes('connect') ||
      statusStr.includes('sync') ||
      statusStr.includes('staging') ||
      statusStr.includes('reconcil') ||
      statusStr.includes('applying') ||
      statusStr.includes('scanning') ||
      statusStr.includes('saving') ||
      statusStr.includes('waiting')
    ) {
      const progress = st.stagingStatus;
      let desc = 'Syncing...';
      if (progress?.totalFiles) {
        desc = `Syncing... (${progress.receivedFiles ?? 0}/${progress.totalFiles} files)`;
      }
      return { state: 'syncing', conflicts: [], description: desc };
    }

    if (statusStr.includes('watch') || statusStr.includes('idle')) {
      return { state: 'watching', conflicts: [], description: 'Watching' };
    }

    // Halted states
    if (statusStr.includes('halt')) {
      const reason = st.lastError ?? statusStr;
      return { state: 'disconnected', conflicts: [], description: `Halted: ${reason}` };
    }

    // Unknown — show raw status for debugging
    return { state: 'syncing', conflicts: [], description: statusStr || 'Working...' };
  }

  // -------------------------------------------------------------------------
  // Status update
  // -------------------------------------------------------------------------

  private updateStatus(partial: Pick<SyncStatus, 'state' | 'conflicts' | 'description'>): void {
    const newStatus: SyncStatus = {
      sessionName: this.sessionName,
      ...partial
    };

    const changed =
      newStatus.state !== this.currentStatus.state ||
      newStatus.description !== this.currentStatus.description ||
      !sameConflictPaths(newStatus.conflicts, this.currentStatus.conflicts);

    this.currentStatus = newStatus;
    if (changed) {
      log(`Status changed → ${newStatus.state}: ${newStatus.description}`);
      this.onStatusChanged.fire(newStatus);
    }
  }

  // -------------------------------------------------------------------------
  // Mutagen process execution
  // -------------------------------------------------------------------------

  private getMutagenPath(): string {
    // 1. Explicit user override in settings takes highest priority.
    const configured = vscode.workspace
      .getConfiguration('mutagenSync')
      .get<string>('mutagenPath');
    if (configured && configured !== 'mutagen') {
      return configured;
    }
    // 2. Managed binary downloaded by the installer.
    if (this.managedBinaryPath) {
      return this.managedBinaryPath;
    }
    // 3. Fall back to whatever is in PATH.
    return 'mutagen';
  }

  private async runMutagen(
    args: string[],
    silent = false
  ): Promise<{ stdout: string; stderr: string }> {
    const mutagenPath = this.getMutagenPath();
    logCmd(mutagenPath, args);

    try {
      const result = await execFileAsync(mutagenPath, args, { maxBuffer: 10 * 1024 * 1024 });
      if (result.stderr?.trim()) {
        logDebug('stderr:', result.stderr.trim());
      }
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebug('runMutagen error:', msg);

      // The daemon version doesn't match the client binary (e.g. after an
      // automatic update). Stop the stale daemon and retry once.
      if (msg.includes('version mismatch') || msg.includes('daemon restart recommended')) {
        log('Daemon version mismatch detected — restarting daemon...');
        try {
          await execFileAsync(mutagenPath, ['daemon', 'stop'], { maxBuffer: 1024 * 1024 });
          log('Daemon stopped. Retrying command...');
        } catch {
          // Daemon may already be stopped; that is fine.
        }
        // Retry the original command with a fresh daemon.
        try {
          const result = await execFileAsync(mutagenPath, args, { maxBuffer: 10 * 1024 * 1024 });
          log('Retry succeeded.');
          return result;
        } catch (retryErr: unknown) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(`Mutagen command failed (${args.slice(0, 2).join(' ')}): ${retryMsg}`);
        }
      }

      if (!silent) {
        throw new Error(`Mutagen command failed (${args.slice(0, 2).join(' ')}): ${msg}`);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Mutagen installation check
  // -------------------------------------------------------------------------

  private async checkMutagenInstalled(): Promise<void> {
    try {
      const { stdout } = await this.runMutagen(['version'], true);
      log(`Mutagen version: ${stdout.trim()}`);
    } catch {
      const mutagenPath = this.getMutagenPath();
      const msg =
        `Mutagen binary not found at "${mutagenPath}". ` +
        'The extension should have downloaded it automatically — try reloading the window. ' +
        'You can also install Mutagen manually from https://mutagen.io/documentation/introduction/installation';
      const action = await vscode.window.showErrorMessage(msg, 'Open Install Docs', 'Reload Window');
      if (action === 'Open Install Docs') {
        void vscode.env.openExternal(
          vscode.Uri.parse('https://mutagen.io/documentation/introduction/installation')
        );
      } else if (action === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      throw new Error('Mutagen not found');
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true when two conflict arrays contain exactly the same set of paths
 * (order-independent). Used to avoid firing spurious status-change events when
 * the conflict list is stable but internally reordered.
 */
function sameConflictPaths(a: ConflictEntry[], b: ConflictEntry[]): boolean {
  if (a.length !== b.length) return false;
  const aPaths = a.map(c => c.path).sort();
  const bPaths = b.map(c => c.path).sort();
  return aPaths.every((p, i) => p === bPaths[i]);
}
