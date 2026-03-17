import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RemoteSyncConfig, DEFAULT_IGNORES, writeConfig } from './config';
import {
  ensureSshKey,
  copyPublicKeyToServer,
  verifyKeylessConnection,
  tryKeylessConnection,
  addHostToKnownHosts
} from './sshKeyManager';
import { log, logDebug } from './logger';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface WizardResult {
  config: RemoteSyncConfig;
}

// ---------------------------------------------------------------------------
// Wizard entry point
// ---------------------------------------------------------------------------

/**
 * Run the multi-step setup wizard.
 *
 * Step 1 — Collect host / port / username / remote path (no password).
 * Step 2 — Try existing SSH key silently. If it works, skip password entirely.
 *           If it fails (or no key exists), ask for password and install the key.
 * Step 3 — Edit the ignore list (pre-filled with defaults, fully editable).
 * Step 4 — Confirm and write config.
 *
 * Returns the completed config, or null if the user cancelled.
 */
export async function runSetupWizard(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<WizardResult | null> {
  // Build pre-fill defaults: sftp.json wins over git remote (it's more direct).
  const sftpDefaults = readSftpJsonDefaults(workspaceFolder.uri.fsPath);
  const gitDefaults  = sftpDefaults ? null : await detectGitRemoteDefaults(workspaceFolder.uri.fsPath);
  const defaults     = sftpDefaults ?? gitDefaults ?? undefined;

  if (sftpDefaults) {
    log(`sftp.json detected: ${sftpDefaults.username}@${sftpDefaults.host}:${sftpDefaults.port} path=${sftpDefaults.remotePath ?? '(none)'}`);
  } else if (gitDefaults) {
    log(`Git remote detected: ${gitDefaults.username}@${gitDefaults.host}:${gitDefaults.port} path=${gitDefaults.remotePath ?? '(none)'}`);
  }

  // Step 1: Connection details (no password yet)
  const connectionDetails = await collectConnectionDetails(defaults);
  if (!connectionDetails) {
    return null;
  }

  const { host, port, username, remotePath } = connectionDetails;

  // Step 2: SSH key — try existing key first, ask for password only if needed
  const keyOk = await ensureSshAccess({ host, port, username });
  if (!keyOk) {
    return null;
  }

  // Add the server's host key to ~/.ssh/known_hosts so Mutagen's strict
  // host-key checking doesn't block the connection.
  await addHostToKnownHosts(host, port);

  // Step 3: Ignores — pre-filled with defaults, user can freely edit/delete
  const ignores = await collectIgnores();
  if (ignores === null) {
    return null;
  }

  // Step 4: Confirm and write config
  const config: RemoteSyncConfig = {
    host,
    port,
    username,
    remotePath,
    ignores
  };

  const confirmed = await confirmAndWriteConfig(workspaceFolder, config);
  if (!confirmed) {
    return null;
  }

  return { config };
}

// ---------------------------------------------------------------------------
// Step 1 — Connection details (no password)
// ---------------------------------------------------------------------------

interface ConnectionDetails {
  host: string;
  port: number;
  username: string;
  remotePath: string;
}

interface GitRemoteDefaults {
  host: string;
  port: number;
  username: string;
  /** May be null if we can't derive a meaningful sync path from the source */
  remotePath: string | null;
  /** Human-readable label shown in the wizard prompt */
  source: 'sftp.json' | 'git remote';
}

async function collectConnectionDetails(
  defaults?: GitRemoteDefaults
): Promise<ConnectionDetails | null> {
  const gitHint = defaults
    ? ` (pre-filled from ${defaults.source}: ${defaults.username}@${defaults.host})`
    : '';

  // Host
  const host = await vscode.window.showInputBox({
    title: 'Remote Sync Setup (1/4) — Server',
    prompt: `Enter the server hostname or IP address${gitHint}`,
    placeHolder: 'your.server.com or 192.168.1.100',
    value: defaults?.host ?? '',
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? null : 'Host is required')
  });
  if (host === undefined) return null;

  // Port
  const portStr = await vscode.window.showInputBox({
    title: 'Remote Sync Setup (1/4) — Port',
    prompt: 'SSH port',
    value: String(defaults?.port ?? 22),
    ignoreFocusOut: true,
    validateInput: v => {
      const n = parseInt(v, 10);
      return isNaN(n) || n < 1 || n > 65535 ? 'Enter a valid port number (1–65535)' : null;
    }
  });
  if (portStr === undefined) return null;
  const port = parseInt(portStr, 10);

  // Username
  const username = await vscode.window.showInputBox({
    title: 'Remote Sync Setup (1/4) — Username',
    prompt: 'SSH username',
    placeHolder: 'ubuntu',
    value: defaults?.username ?? '',
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? null : 'Username is required')
  });
  if (username === undefined) return null;

  // Remote path — pre-fill from git remote if we have a usable path,
  // otherwise leave empty so the user types it themselves.
  const remotePath = await vscode.window.showInputBox({
    title: 'Remote Sync Setup (1/4) — Remote Path',
    prompt: 'Absolute path on the remote server to sync to',
    placeHolder: '/var/www/projectname',
    value: defaults?.remotePath ?? '',
    ignoreFocusOut: true,
    validateInput: v => {
      if (!v.trim()) return 'Remote path is required';
      if (!v.startsWith('/')) return 'Remote path must be absolute (start with /)';
      return null;
    }
  });
  if (remotePath === undefined) return null;

  return {
    host: host.trim(),
    port,
    username: username.trim(),
    remotePath: remotePath.trim()
  };
}

// ---------------------------------------------------------------------------
// Step 2 — SSH access: try key first, fall back to password if needed
// ---------------------------------------------------------------------------

/**
 * Ensure the local machine can connect to the server with key-based auth.
 *
 * 1. Try the existing key (if any) → if it works, we are done (no password asked).
 * 2. If that fails, ask for the password once, generate a key if absent,
 *    copy the public key to the server, and verify keyless auth works.
 *
 * Returns true on success, false if the user cancelled or setup failed.
 */
async function ensureSshAccess(params: {
  host: string;
  port: number;
  username: string;
}): Promise<boolean> {
  // --- Try existing key silently ---
  const keyAlreadyWorks = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Remote Sync Setup (2/4) — SSH Key',
      cancellable: false
    },
    async progress => {
      const privateKeyPath = path.join(os.homedir(), '.ssh', 'id_ed25519');
      const keyExists = fs.existsSync(privateKeyPath);

      if (keyExists) {
        progress.report({ message: `Testing existing key for ${params.username}@${params.host}...` });
        const ok = await tryKeylessConnection(params);
        if (ok) {
          progress.report({ message: 'SSH key already authorized — no password needed.' });
          await sleep(800);
          return true;
        }
        progress.report({ message: 'Existing key not accepted — password required.' });
        await sleep(600);
      }
      return false;
    }
  );

  if (keyAlreadyWorks) {
    return true;
  }

  // --- Key not working: ask for password and install ---
  const password = await vscode.window.showInputBox({
    title: 'Remote Sync Setup (2/4) — SSH Password',
    prompt:
      `SSH password for ${params.username}@${params.host} ` +
      '(used once to install your public key, then discarded — never stored)',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v ? null : 'Password is required to install the SSH key')
  });
  if (password === undefined) {
    return false; // user cancelled
  }

  return await installSshKey({ ...params, password });
}

/**
 * Generate key (if absent), copy public key to server, verify keyless auth.
 * Password is used only inside this function and never persisted.
 */
async function installSshKey(params: {
  host: string;
  port: number;
  username: string;
  password: string;
}): Promise<boolean> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Remote Sync Setup (2/4) — Installing SSH Key',
      cancellable: false
    },
    async progress => {
      try {
        const privateKeyPath = path.join(os.homedir(), '.ssh', 'id_ed25519');
        const keyExists = fs.existsSync(privateKeyPath);

        progress.report({
          message: keyExists
            ? 'Using existing key at ~/.ssh/id_ed25519'
            : 'Generating ed25519 key pair...',
          increment: 20
        });

        await ensureSshKey();

        progress.report({
          message: `Copying public key to ${params.host}...`,
          increment: 30
        });

        await copyPublicKeyToServer(params);

        progress.report({ message: 'Verifying keyless connection...', increment: 30 });

        await verifyKeylessConnection({
          host: params.host,
          port: params.port,
          username: params.username
        });

        progress.report({ message: 'SSH key installed successfully.', increment: 20 });
        await sleep(800);

        // password goes out of scope here — never stored or returned
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await vscode.window.showErrorMessage(
          `SSH key setup failed: ${msg}. Please check your credentials and try again.`
        );
        return false;
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Ignore list (pre-filled with defaults, fully editable)
// ---------------------------------------------------------------------------

/**
 * Shows an editable input pre-filled with the default ignores.
 * The user can remove, add, or keep any entry.
 * Returns the final list (possibly empty), or null if cancelled.
 */
async function collectIgnores(): Promise<string[] | null> {
  const defaultValue = DEFAULT_IGNORES.join(', ');

  const input = await vscode.window.showInputBox({
    title: 'Remote Sync Setup (3/4) — Ignored paths',
    prompt:
      'Comma-separated list of paths to exclude from sync. ' +
      'Edit or delete any entry — nothing is applied implicitly.',
    value: defaultValue,
    ignoreFocusOut: true
  });

  if (input === undefined) {
    return null; // cancelled
  }

  if (!input.trim()) {
    return [];
  }

  return input
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Step 4 — Confirm and write config
// ---------------------------------------------------------------------------

async function confirmAndWriteConfig(
  workspaceFolder: vscode.WorkspaceFolder,
  config: RemoteSyncConfig
): Promise<boolean> {
  const ignoresSummary =
    config.ignores.length > 0 ? config.ignores.join(', ') : '(none)';

  const summary = [
    `Host:        ${config.host}:${config.port}`,
    `User:        ${config.username}`,
    `Remote path: ${config.remotePath}`,
    `Ignores:     ${ignoresSummary}`,
    '',
    'Mutagen session will be created and .vscode/remote-sync.json will be written.'
  ].join('\n');

  const answer = await vscode.window.showInformationMessage(
    `Remote Sync Setup (4/4)\n\n${summary}`,
    { modal: true },
    'Start Sync',
    'Cancel'
  );

  if (answer !== 'Start Sync') {
    return false;
  }

  writeConfig(workspaceFolder, config);
  return true;
}

// ---------------------------------------------------------------------------
// sftp.json detection (SFTP extension by Natizyskunk / liximomo)
// ---------------------------------------------------------------------------

/**
 * Reads `.vscode/sftp.json` from the workspace root and extracts the SSH
 * connection fields that Mutagen needs.
 *
 * Supports both single-profile and multi-profile layouts:
 *
 *   Single:  { "host": "...", "port": 22, "username": "...", "remotePath": "..." }
 *
 *   Multi:   { "profiles": { "prod": { ... } }, "defaultProfile": "prod" }
 *            Falls back to the first profile if defaultProfile is absent.
 *
 * Returns null if the file does not exist, is not valid JSON, or has no SSH
 * fields we can use.
 */
function readSftpJsonDefaults(workspacePath: string): GitRemoteDefaults | null {
  const sftpJsonPath = path.join(workspacePath, '.vscode', 'sftp.json');
  try {
    if (!fs.existsSync(sftpJsonPath)) return null;

    const raw = fs.readFileSync(sftpJsonPath, 'utf8');
    // sftp.json allows JS-style comments — strip them before parsing
    const stripped = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const json = JSON.parse(stripped) as Record<string, unknown>;

    // Resolve the active profile
    let profile: Record<string, unknown>;
    if (json['profiles'] && typeof json['profiles'] === 'object') {
      const profiles = json['profiles'] as Record<string, Record<string, unknown>>;
      const defaultKey = typeof json['defaultProfile'] === 'string'
        ? json['defaultProfile']
        : Object.keys(profiles)[0];
      profile = profiles[defaultKey] ?? {};
    } else {
      profile = json;
    }

    const host     = typeof profile['host']       === 'string' ? profile['host']       : null;
    const username = typeof profile['username']   === 'string' ? profile['username']   : null;
    const port     = typeof profile['port']       === 'number' ? profile['port']       : 22;
    const remotePath = typeof profile['remotePath'] === 'string' ? profile['remotePath'] : null;

    if (!host || !username) {
      logDebug('sftp.json found but missing host or username — skipping');
      return null;
    }

    return {
      host,
      port,
      username,
      remotePath: remotePath && remotePath.startsWith('/') ? remotePath : null,
      source: 'sftp.json'
    };
  } catch (err) {
    logDebug('readSftpJsonDefaults error (non-fatal):', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git remote detection
// ---------------------------------------------------------------------------

/**
 * Tries to detect SSH connection details from the workspace's git remote.
 *
 * Handles the two SSH URL formats that git uses:
 *
 *   SCP-style:  git@github.com:user/repo.git
 *               ubuntu@192.168.2.4:myproject.git
 *
 *   ssh:// URL: ssh://ubuntu@192.168.2.4:2222/var/www/project.git
 *               ssh://git@github.com/user/repo.git
 *
 * HTTPS remotes are ignored (not SSH, can't be used for Mutagen).
 *
 * Returns null if no SSH remote is found or git is not available.
 */
async function detectGitRemoteDefaults(
  workspacePath: string
): Promise<GitRemoteDefaults | null> {
  try {
    // Get the URL of 'origin' first; fall back to first available remote.
    let remoteUrl: string | null = null;
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: workspacePath
      });
      remoteUrl = stdout.trim();
    } catch {
      // No 'origin' — try listing all remotes and pick the first one
      try {
        const { stdout } = await execFileAsync('git', ['remote', '-v'], {
          cwd: workspacePath
        });
        const firstLine = stdout.trim().split('\n')[0];
        // Format: "origin\tgit@host:path (fetch)"
        const match = firstLine?.match(/^\S+\s+(\S+)/);
        remoteUrl = match?.[1] ?? null;
      } catch {
        return null;
      }
    }

    if (!remoteUrl) return null;
    logDebug('Git remote URL:', remoteUrl);

    return parseGitRemoteUrl(remoteUrl);
  } catch (err) {
    logDebug('detectGitRemoteDefaults error (non-fatal):', err);
    return null;
  }
}

/**
 * Parse a git remote URL into SSH connection components.
 * Returns null for HTTPS/git:// URLs (not usable for SSH sync).
 */
function parseGitRemoteUrl(remoteUrl: string): GitRemoteDefaults | null {
  // ── ssh:// URL ─────────────────────────────────────────────────────────────
  // Examples:
  //   ssh://ubuntu@192.168.2.4:2222/var/www/project.git
  //   ssh://git@github.com/user/repo.git
  const sshProtoMatch = remoteUrl.match(
    /^ssh:\/\/(?:([^@]+)@)?([^/:]+)(?::(\d+))?(\/[^?#]*)?/
  );
  if (sshProtoMatch) {
    const [, user, host, portStr, urlPath] = sshProtoMatch;
    // ssh:// URLs always produce an absolute path (starts with /), or no path.
    // No path → bare repo host, nothing useful to pre-fill.
    if (!urlPath || !urlPath.startsWith('/')) {
      logDebug('Git remote ssh:// URL has no absolute path — bare repo host, skipping');
      return null;
    }
    return {
      host,
      port: portStr ? parseInt(portStr, 10) : 22,
      username: user ?? os.userInfo().username,
      remotePath: deriveRemotePath(urlPath),
      source: 'git remote'
    };
  }

  // ── SCP-style: [user@]host:path ────────────────────────────────────────────
  // Must NOT start with a scheme and must contain a colon after the host part.
  // Exclude Windows paths like C:\foo and URLs like https://...
  if (!remoteUrl.includes('://') && !remoteUrl.startsWith('/')) {
    const scpMatch = remoteUrl.match(/^(?:([^@]+)@)?([^:]+):(.+)$/);
    if (scpMatch) {
      const [, user, host, urlPath] = scpMatch;
      // A relative path (e.g. "user/repo.git", "myproject.git") means this is
      // a bare-repo git host — GitHub, GitLab, Gitea, any hosted service.
      // These are never valid Mutagen sync targets, so skip the whole remote.
      // An absolute path (e.g. "/var/www/project") means a real working
      // directory on an own server — that's exactly what we want to sync.
      if (!urlPath.startsWith('/')) {
        logDebug('Git remote SCP path is relative — bare repo host, skipping:', urlPath);
        return null;
      }
      return {
        host,
        port: 22,
        username: user ?? os.userInfo().username,
        remotePath: deriveRemotePath(urlPath),
        source: 'git remote'
      };
    }
  }

  // HTTPS, git://, file:// — not SSH
  logDebug('Git remote is not an SSH URL, skipping:', remoteUrl);
  return null;
}

/**
 * Convert a git repo path to a probable sync root path.
 *
 * - Strips trailing `.git` suffix
 * - Only returns an absolute path (/var/www/project → kept as-is)
 * - Relative paths (user/repo.git on GitHub) are dropped → returns null
 *   so the wizard leaves the field empty for the user to fill in
 */
function deriveRemotePath(rawPath: string | null): string | null {
  if (!rawPath) return null;
  const stripped = rawPath.replace(/\.git\/?$/, '').replace(/\/$/, '');
  // Only keep absolute paths
  return stripped.startsWith('/') ? stripped || null : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
