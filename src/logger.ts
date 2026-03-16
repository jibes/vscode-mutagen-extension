/**
 * logger.ts
 *
 * Provides a shared VS Code OutputChannel for debug logging throughout the
 * Mutagen Sync extension.  When debug mode is enabled (mutagenSync.debug),
 * all CLI invocations, parsed responses, and state transitions are written
 * to the "Mutagen Sync" output panel.
 *
 * Usage:
 *   import { log, logDebug } from './logger';
 *
 *   log('Session started');          // always visible
 *   logDebug('Raw JSON:', jsonStr);  // only when mutagenSync.debug = true
 */

import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('Mutagen Sync');
  }
  return _channel;
}

function isDebug(): boolean {
  return vscode.workspace.getConfiguration('mutagenSync').get<boolean>('debug') ?? false;
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Always-on log — writes to the output channel regardless of debug mode.
 */
export function log(...args: unknown[]): void {
  channel().appendLine(`[${timestamp()}] ${args.map(String).join(' ')}`);
}

/**
 * Debug log — writes only when mutagenSync.debug is true.
 */
export function logDebug(...args: unknown[]): void {
  if (isDebug()) {
    channel().appendLine(`[${timestamp()}] [DBG] ${args.map(String).join(' ')}`);
  }
}

/**
 * Log a CLI invocation (always visible, concise).
 */
export function logCmd(binary: string, args: string[]): void {
  // Redact password if somehow it appears (it should never be in mutagen args)
  const safeArgs = args.map(a => (a.length > 200 ? a.slice(0, 200) + '…' : a));
  log(`> ${binary} ${safeArgs.join(' ')}`);
}

/**
 * Show the output channel in the UI.
 */
export function showOutput(): void {
  channel().show(true /* preserveFocus */);
}

/**
 * Dispose the channel on extension deactivation.
 */
export function disposeLogger(): void {
  _channel?.dispose();
  _channel = undefined;
}
