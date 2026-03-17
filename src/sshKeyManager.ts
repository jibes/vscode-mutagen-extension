import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ConnectConfig } from 'ssh2';

const execFileAsync = promisify(execFile);

const SSH_DIR = path.join(os.homedir(), '.ssh');
const PRIVATE_KEY_PATH = path.join(SSH_DIR, 'id_ed25519');
const PUBLIC_KEY_PATH = path.join(SSH_DIR, 'id_ed25519.pub');

export interface SshConnectionParams {
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * Ensure an ed25519 SSH key pair exists at ~/.ssh/id_ed25519.
 * Generates one silently if absent.
 */
export async function ensureSshKey(): Promise<string> {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    // Ensure ~/.ssh directory exists with correct permissions
    if (!fs.existsSync(SSH_DIR)) {
      fs.mkdirSync(SSH_DIR, { mode: 0o700, recursive: true });
    }

    await execFileAsync('ssh-keygen', [
      '-t', 'ed25519',
      '-f', PRIVATE_KEY_PATH,
      '-N', '' // empty passphrase
    ]);
  }

  const pubKey = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8').trim();
  return pubKey;
}

/**
 * Copy the local public key to the remote server's authorized_keys,
 * using password authentication (one-time use, never stored).
 *
 * Uses the ssh2 library for safe, programmatic SSH — no shell involved.
 */
export async function copyPublicKeyToServer(params: SshConnectionParams): Promise<void> {
  // Dynamically require ssh2 to keep webpack happy with native modules
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('ssh2') as typeof import('ssh2');

  const pubKey = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8').trim();

  return new Promise<void>((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      // Ensure ~/.ssh exists, set permissions, append public key
      const remoteCommands = [
        'mkdir -p ~/.ssh',
        'chmod 700 ~/.ssh',
        `echo ${shellEscape(pubKey)} >> ~/.ssh/authorized_keys`,
        'chmod 600 ~/.ssh/authorized_keys',
        'sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys' // deduplicate
      ].join(' && ');

      conn.exec(remoteCommands, (err, stream) => {
        if (err) {
          conn.end();
          return reject(new Error(`Failed to execute remote command: ${err.message}`));
        }

        let stderr = '';
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          conn.end();
          if (code !== 0) {
            reject(new Error(`Remote command failed (exit ${code}): ${stderr}`));
          } else {
            resolve();
          }
        });
      });
    });

    conn.on('error', (err: Error) => {
      reject(new Error(`SSH connection error: ${err.message}`));
    });

    const connectConfig: ConnectConfig = {
      host: params.host,
      port: params.port,
      username: params.username,
      password: params.password,
      // Timeout after 15 seconds
      readyTimeout: 15000,
      // Do not use keepalive for the one-time key copy
      keepaliveInterval: 0
    };

    conn.connect(connectConfig);
  });
}

/**
 * Test whether keyless SSH authentication works, without throwing.
 *
 * Uses the system `ssh` binary with BatchMode=yes so that it respects
 * ssh-agent, ~/.ssh/config, and all key types (id_ed25519, id_rsa, etc.)
 * — not just the one key file we manage.
 */
export async function tryKeylessConnection(
  params: Omit<SshConnectionParams, 'password'>
): Promise<boolean> {
  try {
    await verifyKeylessConnection(params);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that keyless SSH authentication works using the system ssh binary.
 *
 * BatchMode=yes prevents ssh from asking for a passphrase/password, so the
 * call fails immediately if no working key is available.  This respects
 * ssh-agent, ~/.ssh/config, and all key types — not just id_ed25519.
 */
export async function verifyKeylessConnection(
  params: Omit<SshConnectionParams, 'password'>
): Promise<void> {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(params.port),
    `${params.username}@${params.host}`,
    'echo ok'
  ];

  try {
    const { stdout } = await execFileAsync('ssh', args, { timeout: 12000 });
    if (!stdout.trim().startsWith('ok')) {
      throw new Error('Unexpected output from ssh verification');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Keyless SSH verification failed: ${msg}`);
  }
}

/**
 * Scan the server's host key and append it to ~/.ssh/known_hosts so that
 * Mutagen (which uses strict host-key checking) can connect.
 *
 * Uses the system `ssh-keyscan` — available on macOS, Linux, and Windows 10+.
 * Failure is non-fatal: if the host is already in known_hosts, or if
 * ssh-keyscan is unavailable, Mutagen will succeed on its own or surface a
 * clear error.
 */
export async function addHostToKnownHosts(host: string, port: number): Promise<void> {
  const knownHostsPath = path.join(SSH_DIR, 'known_hosts');

  if (!fs.existsSync(SSH_DIR)) {
    fs.mkdirSync(SSH_DIR, { mode: 0o700, recursive: true });
  }

  // -H hashes the hostname so it isn't readable in plain text
  const args = port !== 22
    ? ['-p', String(port), '-H', host]
    : ['-H', host];

  try {
    const { stdout } = await execFileAsync('ssh-keyscan', args, { timeout: 15000 });
    if (stdout.trim()) {
      fs.appendFileSync(knownHostsPath, '\n' + stdout);
    }
  } catch {
    // Non-fatal — host may already be known, or ssh-keyscan may be unavailable.
  }
}

/**
 * Minimal shell escape: wraps the value in single quotes and escapes any
 * embedded single quotes. Only used to safely pass the public key string
 * in an SSH exec command (no local shell involved).
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
