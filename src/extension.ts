import * as vscode from 'vscode';
import { MutagenManager, SyncStatus, listAllMutagenSessions } from './mutagenManager';
import { StatusBarManager } from './statusBar';
import { ConflictResolver } from './conflictResolver';
import { runSetupWizard } from './setupWizard';
import { readConfig, configExists, removeConfig, getConfigPath, deriveSessionName } from './config';
import { ensureMutagen } from './mutagenInstaller';
import { log, showOutput, disposeLogger } from './logger';

// ---------------------------------------------------------------------------
// Per-workspace session state
// ---------------------------------------------------------------------------

interface WorkspaceSession {
  manager: MutagenManager;
  disposable: vscode.Disposable;
}

// ---------------------------------------------------------------------------
// Extension globals
// ---------------------------------------------------------------------------

let statusBar: StatusBarManager;
let conflictResolver: ConflictResolver;

/**
 * Absolute path to the managed mutagen binary in globalStorage.
 * Populated during activation; undefined if install failed (fallback to PATH).
 */
let managedMutagenPath: string | undefined;

/** Map from workspace folder URI (string) → active session */
const sessions = new Map<string, WorkspaceSession>();

/** Captured extension context — used for workspaceState and subscriptions. */
let ctx: vscode.ExtensionContext;

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ctx = context;

  statusBar = new StatusBarManager();
  conflictResolver = new ConflictResolver(context.extensionUri);

  context.subscriptions.push(statusBar, conflictResolver);

  log('Mutagen Sync extension activating...');

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('mutagen-sync.connect', () => cmdConnect(context)),
    vscode.commands.registerCommand('mutagen-sync.pause', cmdPause),
    vscode.commands.registerCommand('mutagen-sync.resume', cmdResume),
    vscode.commands.registerCommand('mutagen-sync.reconnect', cmdReconnect),
    vscode.commands.registerCommand('mutagen-sync.resolveConflicts', cmdResolveConflicts),
    vscode.commands.registerCommand('mutagen-sync.openConfig', cmdOpenConfig),
    vscode.commands.registerCommand('mutagen-sync.disconnect', cmdDisconnect),
    vscode.commands.registerCommand('mutagen-sync.showOutput', () => showOutput()),
    // Internal command wired to status bar click
    vscode.commands.registerCommand('mutagen-sync.openPanel', cmdOpenPanel)
  );

  // Ensure Mutagen binary + agent bundle are present in globalStorage.
  // This runs silently if already installed; shows progress if a download is needed.
  log(`Global storage path: ${context.globalStorageUri.fsPath}`);
  await installMutagen(context.globalStorageUri.fsPath);

  // React to workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
      for (const added of event.added) {
        void tryAutoConnect(added);
      }
      for (const removed of event.removed) {
        void teardownSession(removed.uri.toString());
      }
    })
  );

  // Auto-connect for all current workspace folders
  const folders = vscode.workspace.workspaceFolders ?? [];
  log(`Workspace folders: ${folders.map(f => f.name).join(', ') || '(none)'}`);
  for (const folder of folders) {
    void tryAutoConnect(folder);
  }

  log('Mutagen Sync extension activated.');
}

// ---------------------------------------------------------------------------
// Mutagen installer
// ---------------------------------------------------------------------------

async function installMutagen(globalStoragePath: string): Promise<void> {
  try {
    // If already installed at the pinned version this is nearly instant.
    managedMutagenPath = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Mutagen Sync'
      },
      async progress => {
        return ensureMutagen(globalStoragePath, msg => {
          progress.report({ message: msg });
        });
      }
    );
  } catch (err) {
    // Non-fatal — fall back to system mutagen in PATH and let the user know.
    managedMutagenPath = undefined;
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `Mutagen Sync: Could not download Mutagen automatically (${msg}). ` +
      'Falling back to system-installed mutagen. ' +
      'If sync fails, install Mutagen from https://mutagen.io/documentation/introduction/installation'
    );
  }
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

export async function deactivate(): Promise<void> {
  log('Mutagen Sync extension deactivating — pausing sessions...');
  // Pause (not terminate) all active sessions so resume is instant next time
  for (const [, session] of sessions) {
    try {
      await session.manager.pause();
    } catch {
      // Best effort
    }
    session.disposable.dispose();
  }
  sessions.clear();
  disposeLogger();
}

// ---------------------------------------------------------------------------
// Session name resolution (unique per workspace path, persisted in workspaceState)
// ---------------------------------------------------------------------------

/**
 * Resolve a stable, unique Mutagen session name for a workspace folder.
 *
 * The name is derived from the folder name (slugified), then checked for
 * collisions with existing Mutagen sessions that point to different paths.
 * A numeric suffix (-2, -3, …) is appended until the name is unique.
 *
 * The resolved name is stored in workspaceState so subsequent opens use the
 * same name without re-querying Mutagen.
 */
async function resolveSessionName(folder: vscode.WorkspaceFolder): Promise<string> {
  const stateKey = `sessionName:${folder.uri.toString()}`;
  const stored = ctx.workspaceState.get<string>(stateKey);
  if (stored) {
    log(`Session name (from workspaceState): "${stored}"`);
    return stored;
  }

  const base = deriveSessionName(folder);
  const mutagenBin = resolveMutagenBinary();
  const allSessions = await listAllMutagenSessions(mutagenBin);

  let name = base;
  let suffix = 2;
  // Increment suffix until name isn't taken by a session for a different path
  while (allSessions.some(s => s.name === name && s.alpha?.path !== folder.uri.fsPath)) {
    name = `${base}-${suffix++}`;
  }

  log(`Session name (derived): "${name}"${name !== base ? ` (base "${base}" was taken)` : ''}`);
  await ctx.workspaceState.update(stateKey, name);
  return name;
}

/** Resolve which mutagen binary to use, respecting settings and managed binary. */
function resolveMutagenBinary(): string {
  const configured = vscode.workspace.getConfiguration('mutagenSync').get<string>('mutagenPath');
  if (configured && configured !== 'mutagen') return configured;
  return managedMutagenPath ?? 'mutagen';
}

// ---------------------------------------------------------------------------
// Auto-connect logic
// ---------------------------------------------------------------------------

async function tryAutoConnect(folder: vscode.WorkspaceFolder): Promise<void> {
  log(`tryAutoConnect: ${folder.name}`);
  if (!configExists(folder)) {
    log(`No config found for ${folder.name}`);
    // Only show "not connected" if no other folder has a running session.
    // This prevents a config-less folder from clobbering another folder's
    // active status in multi-root workspaces.
    if (sessions.size === 0) {
      statusBar.setNoConfig();
    }
    return;
  }

  const config = readConfig(folder);
  if (!config) {
    log(`Config unreadable for ${folder.name}`);
    if (sessions.size === 0) {
      statusBar.setNoConfig();
    }
    return;
  }

  log(`Config found for ${folder.name}: ${config.username}@${config.host}:${config.port}${config.remotePath}`);
  statusBar.restoreCommand();
  await startSession(folder);
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function startSession(folder: vscode.WorkspaceFolder): Promise<void> {
  const key = folder.uri.toString();

  // Tear down any existing session for this folder
  if (sessions.has(key)) {
    await teardownSession(key);
  }

  const config = readConfig(folder);
  if (!config) return;

  const sessionName = await resolveSessionName(folder);
  const manager = new MutagenManager(folder, config, managedMutagenPath, sessionName);

  // Subscribe to status updates
  const disposable = manager.onStatusChanged.event((status: SyncStatus) => {
    statusBar.update(status);

    // Auto-surface conflict notification
    if (status.state === 'conflict' && status.conflicts.length > 0) {
      void showConflictNotification(manager, folder, status);
    }
  });

  sessions.set(key, { manager, disposable });

  // Watch the config file for external edits while the session is running.
  // Prompt to reconnect so new ignore patterns / host changes take effect.
  attachConfigWatcher(folder, key);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Mutagen Sync: Starting...',
        cancellable: false
      },
      async progress => {
        progress.report({ message: 'Connecting to remote...' });
        await manager.start();
        progress.report({ message: 'Sync session active.' });
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('Mutagen not found')) {
      await vscode.window.showErrorMessage(`Mutagen Sync: Failed to start sync — ${msg}`);
    }
    await teardownSession(key);
  }
}

async function teardownSession(key: string): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  // Close the conflict panel if it belongs to this session's manager
  conflictResolver.clearSession(session.manager);
  try {
    await session.manager.pause();
  } catch {
    // Best effort
  }
  session.disposable.dispose();
  session.manager.dispose();
}

/** Return the session for the active workspace folder, or undefined. */
function getActiveSession(): WorkspaceSession | undefined {
  const folder = getActiveWorkspaceFolder();
  if (!folder) return undefined;
  return sessions.get(folder.uri.toString());
}

function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return undefined;

  // If there is only one, return it
  if (folders.length === 1) return folders[0];

  // Otherwise try to pick the one containing the active editor
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    return vscode.workspace.getWorkspaceFolder(activeUri) ?? folders[0];
  }

  return folders[0];
}

// ---------------------------------------------------------------------------
// Config file watcher
// ---------------------------------------------------------------------------

/**
 * Watch .vscode/remote-sync.json for external edits while a session is running.
 * Prompts the user to reconnect so changes (ignore patterns, host, etc.) take
 * effect.  Debounced to avoid reacting to partial writes from editors that
 * save in multiple chunks.
 */
function attachConfigWatcher(folder: vscode.WorkspaceFolder, sessionKey: string): void {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '.vscode/remote-sync.json')
  );

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const onChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      // Only prompt if the session is still running
      if (!sessions.has(sessionKey)) return;
      const action = await vscode.window.showInformationMessage(
        `Mutagen Sync: Configuration changed in "${folder.name}" — reconnect to apply?`,
        'Reconnect',
        'Later'
      );
      if (action === 'Reconnect') {
        await startSession(folder);
      }
    }, 1000); // 1 s debounce
  };

  ctx.subscriptions.push(watcher, watcher.onDidChange(onChange));
}

// ---------------------------------------------------------------------------
// Conflict notification
// ---------------------------------------------------------------------------

async function showConflictNotification(
  manager: MutagenManager,
  folder: vscode.WorkspaceFolder,
  status: SyncStatus
): Promise<void> {
  const count = status.conflicts.length;
  const label = count === 1 ? '1 conflict' : `${count} conflicts`;
  const action = await vscode.window.showWarningMessage(
    `Mutagen Sync: ${label} detected in ${folder.name}`,
    'Resolve Now',
    'Later'
  );
  if (action === 'Resolve Now') {
    await conflictResolver.open(manager, folder);
  }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdConnect(context: vscode.ExtensionContext): Promise<void> {
  const folder = getActiveWorkspaceFolder();
  if (!folder) {
    await vscode.window.showErrorMessage('Mutagen Sync: No workspace folder open.');
    return;
  }

  const result = await runSetupWizard(folder);
  if (!result) {
    return; // cancelled
  }

  // Switch status bar command immediately so clicking it shows the
  // panel/disconnect options without requiring a reload.
  statusBar.restoreCommand();

  await startSession(folder);

  const openConfig = await vscode.window.showInformationMessage(
    'Mutagen Sync: Session started! Would you like to open the config file?',
    'Open Config',
    'No Thanks'
  );
  if (openConfig === 'Open Config') {
    await cmdOpenConfig();
  }
}

async function cmdPause(): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    await vscode.window.showWarningMessage('Mutagen Sync: No active session to pause.');
    return;
  }
  try {
    await session.manager.pause();
    await vscode.window.showInformationMessage('Mutagen Sync: Session paused.');
  } catch (err) {
    await vscode.window.showErrorMessage(
      `Mutagen Sync: Failed to pause — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function cmdResume(): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    await vscode.window.showWarningMessage('Mutagen Sync: No active session to resume.');
    return;
  }
  try {
    await session.manager.resume();
    await vscode.window.showInformationMessage('Mutagen Sync: Session resumed.');
  } catch (err) {
    await vscode.window.showErrorMessage(
      `Mutagen Sync: Failed to resume — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function cmdResolveConflicts(): Promise<void> {
  const folder = getActiveWorkspaceFolder();
  const session = getActiveSession();
  if (!session || !folder) {
    await vscode.window.showWarningMessage('Mutagen Sync: No active session.');
    return;
  }
  await conflictResolver.open(session.manager, folder);
}

async function cmdOpenConfig(): Promise<void> {
  const folder = getActiveWorkspaceFolder();
  if (!folder) {
    await vscode.window.showErrorMessage('Mutagen Sync: No workspace folder open.');
    return;
  }
  const configPath = getConfigPath(folder);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
    await vscode.window.showTextDocument(doc);
  } catch {
    await vscode.window.showErrorMessage(
      `Mutagen Sync: Could not open config file at ${configPath}`
    );
  }
}

async function cmdReconnect(): Promise<void> {
  const folder = getActiveWorkspaceFolder();
  if (!folder) {
    await vscode.window.showErrorMessage('Mutagen Sync: No workspace folder open.');
    return;
  }
  if (!configExists(folder)) {
    await vscode.window.showWarningMessage('Mutagen Sync: No configuration found — run Connect first.');
    return;
  }

  // Terminate (not just pause) the existing daemon session so the new one is
  // created from scratch with the current config (including any ignore changes).
  const key = folder.uri.toString();
  const session = sessions.get(key);
  if (session) {
    sessions.delete(key);
    conflictResolver.clearSession(session.manager);
    try { await session.manager.terminate(); } catch { /* best effort */ }
    session.disposable.dispose();
    session.manager.dispose();
  }

  await startSession(folder);
}

async function cmdDisconnect(): Promise<void> {
  const folder = getActiveWorkspaceFolder();
  if (!folder) {
    await vscode.window.showErrorMessage('Mutagen Sync: No workspace folder open.');
    return;
  }

  // Modal X / Escape acts as cancel — no explicit Cancel button needed
  const confirm = await vscode.window.showWarningMessage(
    `Mutagen Sync: Terminate sync session for "${folder.name}"?`,
    { modal: true },
    'Terminate & Remove Config',
    'Terminate (Keep Config)'
  );

  if (!confirm) return;

  const key = folder.uri.toString();
  const session = sessions.get(key);
  if (session) {
    conflictResolver.clearSession(session.manager);
    await session.manager.terminate();
    session.disposable.dispose();
    session.manager.dispose();
    sessions.delete(key);
  }

  if (confirm === 'Terminate & Remove Config') {
    removeConfig(folder);
    statusBar.setNoConfig();
    await vscode.window.showInformationMessage(
      `Mutagen Sync: Session terminated and config removed for "${folder.name}".`
    );
  } else {
    await vscode.window.showInformationMessage(
      `Mutagen Sync: Session terminated for "${folder.name}". Config kept — click the status bar to reconnect.`
    );
  }
}

async function cmdOpenPanel(): Promise<void> {
  // Status bar click — open conflict panel if there are conflicts, otherwise
  // show a quick status summary via the palette.
  const session = getActiveSession();
  const folder = getActiveWorkspaceFolder();

  if (!session || !folder) {
    if (folder && configExists(folder)) {
      // Config exists but session isn't running (e.g. failed to start, or
      // workspace was just reopened and auto-connect is still in progress).
      // Offer a quick reconnect — do NOT re-run the setup wizard.
      const action = await vscode.window.showInformationMessage(
        `Mutagen Sync: Session not running for "${folder.name}".`,
        'Reconnect',
        'Open Config',
        'Disconnect'
      );
      if (action === 'Reconnect') {
        await startSession(folder);
      } else if (action === 'Open Config') {
        await cmdOpenConfig();
      } else if (action === 'Disconnect') {
        await cmdDisconnect();
      }
    } else {
      // No config at all — run the setup wizard.
      const action = await vscode.window.showInformationMessage(
        'Mutagen Sync: No configuration found.',
        'Connect to Server',
        'Dismiss'
      );
      if (action === 'Connect to Server') {
        await vscode.commands.executeCommand('mutagen-sync.connect');
      }
    }
    return;
  }

  const status = session.manager.getStatus();
  if (status.state === 'conflict') {
    await conflictResolver.open(session.manager, folder);
    return;
  }

  // Show status summary
  const stateLabel: Record<string, string> = {
    syncing: 'Syncing...',
    watching: 'Watching — all files in sync',
    disconnected: 'Disconnected — check SSH connection',
    paused: 'Paused',
    unknown: 'Unknown'
  };

  const actions: string[] = [];
  if (status.state === 'paused') actions.push('Resume');
  if (status.state === 'watching' || status.state === 'syncing') actions.push('Pause');
  actions.push('Reconnect', 'Open Config', 'Disconnect');

  const choice = await vscode.window.showInformationMessage(
    `Mutagen Sync [${folder.name}]: ${stateLabel[status.state] ?? status.description}`,
    ...actions
  );

  switch (choice) {
    case 'Resume':
      await cmdResume();
      break;
    case 'Pause':
      await cmdPause();
      break;
    case 'Reconnect':
      await cmdReconnect();
      break;
    case 'Open Config':
      await cmdOpenConfig();
      break;
    case 'Disconnect':
      await cmdDisconnect();
      break;
  }
}
