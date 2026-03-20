import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface RemoteSyncConfig {
  host: string;
  port: number;
  username: string;
  remotePath: string;
  /** All ignored paths — written into the config so they can be removed. No implicit ignores. */
  ignore: string[];
}

const CONFIG_FILENAME = 'remote-sync.json';
const VSCODE_DIR = '.vscode';

export function getConfigPath(workspaceFolder: vscode.WorkspaceFolder): string {
  return path.join(workspaceFolder.uri.fsPath, VSCODE_DIR, CONFIG_FILENAME);
}

export function configExists(workspaceFolder: vscode.WorkspaceFolder): boolean {
  return fs.existsSync(getConfigPath(workspaceFolder));
}

export function readConfig(workspaceFolder: vscode.WorkspaceFolder): RemoteSyncConfig | null {
  const configPath = getConfigPath(workspaceFolder);
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RemoteSyncConfig> & { ignores?: string[]; additionalIgnores?: string[] };

    // Guard against non-object JSON (null, string, number, array, etc.)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      vscode.window.showErrorMessage(
        `Mutagen Sync: Invalid config in ${configPath}. Expected a JSON object.`
      );
      return null;
    }

    // Validate required fields
    if (!parsed.host || !parsed.username || !parsed.remotePath) {
      vscode.window.showErrorMessage(
        `Mutagen Sync: Invalid config in ${configPath}. Missing required fields: host, username, or remotePath.`
      );
      return null;
    }

    // Support old configs that used "ignores" or "additionalIgnores" — migrate transparently
    const ignore =
      parsed.ignore ??
      parsed.ignores ??
      (parsed.additionalIgnores ? [...DEFAULT_IGNORES, ...parsed.additionalIgnores] : [...DEFAULT_IGNORES]);

    return {
      host: parsed.host,
      port: (typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65535) ? parsed.port : 22,
      username: parsed.username,
      remotePath: parsed.remotePath,
      ignore
    };
  } catch (err) {
    vscode.window.showErrorMessage(
      `Mutagen Sync: Failed to parse ${configPath}: ${String(err)}`
    );
    return null;
  }
}

export function writeConfig(
  workspaceFolder: vscode.WorkspaceFolder,
  config: RemoteSyncConfig
): void {
  const vscodeDirPath = path.join(workspaceFolder.uri.fsPath, VSCODE_DIR);
  if (!fs.existsSync(vscodeDirPath)) {
    fs.mkdirSync(vscodeDirPath, { recursive: true });
  }

  const configPath = getConfigPath(workspaceFolder);
  const content = JSON.stringify(config, null, 2);
  fs.writeFileSync(configPath, content, 'utf8');
}

export function removeConfig(workspaceFolder: vscode.WorkspaceFolder): void {
  const configPath = getConfigPath(workspaceFolder);
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

/**
 * Derive a session name from the workspace folder name.
 * Slugified: lowercase, alphanumeric and hyphens only.
 */
export function deriveSessionName(workspaceFolder: vscode.WorkspaceFolder): string {
  return workspaceFolder.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 64) || 'workspace';
}

/**
 * Default ignore patterns written into the config on first setup.
 * Users can freely remove or add entries in .vscode/remote-sync.json.
 * No patterns are applied implicitly — the config is the single source of truth.
 */
export const DEFAULT_IGNORES: readonly string[] = [
  '.git',
  '.env',
  '*.env',
  '.env.*',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini'
];
