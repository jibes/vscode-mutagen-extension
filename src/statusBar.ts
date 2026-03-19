import * as vscode from 'vscode';
import type { SyncStatus, SyncState } from './mutagenManager';

interface StatusBarConfig {
  icon: string;
  text: string;
  tooltip: string;
  color?: vscode.ThemeColor;
}

function getStatusBarConfig(status: SyncStatus, remoteName?: string): StatusBarConfig {
  const prefix = remoteName ? `${remoteName} — ` : '';

  switch (status.state) {
    case 'syncing':
      return {
        icon: '$(sync~spin)',
        text: `$(sync~spin) Mutagen: ${prefix}Syncing...`,
        tooltip: status.description || 'Syncing files to remote...'
      };

    case 'watching':
      return {
        icon: '$(check)',
        text: `$(check) Mutagen: ${prefix}Watching`,
        tooltip: `Mutagen: ${status.description || 'All files in sync. Watching for changes.'}`
      };

    case 'conflict':
      return {
        icon: '$(warning)',
        text: `$(warning) Mutagen: ${prefix}Conflict (${status.conflicts.length})`,
        tooltip:
          `${status.conflicts.length} file(s) have conflicts. Click to resolve.\n` +
          status.conflicts.map(c => `  • ${c.path}`).join('\n'),
        color: new vscode.ThemeColor('statusBarItem.warningBackground')
      };

    case 'disconnected':
      return {
        icon: '$(error)',
        text: `$(error) Mutagen: ${prefix}Disconnected`,
        tooltip: 'Mutagen: SSH connection lost. Check your network and server.',
        color: new vscode.ThemeColor('statusBarItem.errorBackground')
      };

    case 'paused':
      return {
        icon: '$(circle-slash)',
        text: `$(circle-slash) Mutagen: ${prefix}Paused`,
        tooltip: 'Mutagen: Sync is paused. Click to open panel.'
      };

    case 'unknown':
    default:
      return {
        icon: '$(question)',
        text: `$(question) Mutagen: ${prefix}Unknown`,
        tooltip: 'Mutagen: Status unknown. Click to open panel.'
      };
  }
}

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private currentStatus: SyncStatus | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'mutagen-sync.openPanel';
    this.item.show();
    this.setInitialState();
  }

  private setInitialState(): void {
    this.item.text = '$(sync) Mutagen: Initializing...';
    this.item.tooltip = 'Mutagen Sync: Initializing...';
  }

  /**
   * Update the status bar to reflect the current sync status.
   * @param status  Current sync status
   * @param remoteName  Optional label for the remote (shown when multiple remotes configured)
   */
  public update(status: SyncStatus, remoteName?: string): void {
    this.currentStatus = status;
    const config = getStatusBarConfig(status, remoteName);

    this.item.text = config.text;
    this.item.tooltip = config.tooltip;

    if (config.color) {
      this.item.backgroundColor = config.color;
    } else {
      this.item.backgroundColor = undefined;
    }
  }

  /**
   * Show a "no config found" state — prompts the user to run the setup wizard.
   */
  public setNoConfig(): void {
    this.item.text = '$(plug) Mutagen: Not connected';
    this.item.tooltip = 'Mutagen Sync: No remote-sync.json found. Click to connect.';
    this.item.command = 'mutagen-sync.connect';
    this.item.backgroundColor = undefined;
  }

  /**
   * Restore the default command (open panel) after returning from no-config state.
   */
  public restoreCommand(): void {
    this.item.command = 'mutagen-sync.openPanel';
  }

  public getCurrentStatus(): SyncStatus | null {
    return this.currentStatus;
  }

  public dispose(): void {
    this.item.dispose();
  }
}
