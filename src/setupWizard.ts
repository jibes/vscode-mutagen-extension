import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RemoteSyncConfig, DEFAULT_IGNORES, writeConfig } from './config';
import {
  ensureSshKey,
  copyPublicKeyToServer,
  verifyKeylessConnection,
  tryKeylessConnection,
  addHostToKnownHosts
} from './sshKeyManager';

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
  // Step 1: Connection details (no password yet)
  const connectionDetails = await collectConnectionDetails();
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

async function collectConnectionDetails(): Promise<ConnectionDetails | null> {
  // Host
  const host = await vscode.window.showInputBox({
    title: 'Remote Sync Setup (1/4) — Server',
    prompt: 'Enter the server hostname or IP address',
    placeHolder: 'your.server.com or 192.168.1.100',
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? null : 'Host is required')
  });
  if (host === undefined) return null;

  // Port
  const portStr = await vscode.window.showInputBox({
    title: 'Remote Sync Setup (1/4) — Port',
    prompt: 'SSH port',
    value: '22',
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
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? null : 'Username is required')
  });
  if (username === undefined) return null;

  // Remote path
  const remotePath = await vscode.window.showInputBox({
    title: 'Remote Sync Setup (1/4) — Remote Path',
    prompt: 'Absolute path on the remote server',
    placeHolder: '/var/www/projectname',
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
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
