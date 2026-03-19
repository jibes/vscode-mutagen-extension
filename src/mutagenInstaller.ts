/**
 * mutagenInstaller.ts
 *
 * Downloads and manages the Mutagen binary and agent bundle inside the
 * extension's globalStorage directory.  This makes the extension self-contained:
 * no system-level Mutagen installation is required.
 *
 * Layout inside globalStoragePath:
 *   bin/mutagen          ← CLI binary (executable)
 *   libexec/mutagen-agents.tar.gz  ← agent bundle (Mutagen looks here automatically)
 *
 * Mutagen finds the agent bundle by looking relative to its own binary path:
 *   <binaryDir>/mutagen-agents.tar.gz
 *   <binaryDir>/../libexec/mutagen-agents.tar.gz
 * So keeping the binary in bin/ and the bundle in libexec/ is the canonical layout.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_LATEST_API =
  'https://api.github.com/repos/mutagen-io/mutagen/releases/latest';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MutagenPaths {
  binary: string;
  agentBundle: string;
}

/** Return the expected paths for the managed binary and agent bundle. */
export function getMutagenStoragePaths(globalStoragePath: string): MutagenPaths {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return {
    binary: path.join(globalStoragePath, 'bin', `mutagen${ext}`),
    agentBundle: path.join(globalStoragePath, 'libexec', 'mutagen-agents.tar.gz')
  };
}

/**
 * Ensure the Mutagen binary and agent bundle are present in globalStorage.
 * Downloads from GitHub Releases if either is missing.
 *
 * Since Mutagen v0.18 the agent bundle ships *inside* the platform binary
 * archive (no separate download).  Both files are always extracted from the
 * same tarball, so we re-download whenever either is absent.
 *
 * @param globalStoragePath  Extension's context.globalStorageUri.fsPath
 * @param onProgress         Optional callback for human-readable progress messages
 * @returns                  Absolute path to the managed mutagen binary
 * @throws                   If download or extraction fails
 */
export async function ensureMutagen(
  globalStoragePath: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const { binary, agentBundle } = getMutagenStoragePaths(globalStoragePath);

  if (fs.existsSync(binary) && fs.existsSync(agentBundle)) {
    return binary; // already fully installed
  }

  // Ensure directories exist
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.mkdirSync(path.dirname(agentBundle), { recursive: true });

  onProgress?.('Fetching Mutagen release information from GitHub...');
  const release = await fetchLatestRelease();
  onProgress?.(`Downloading Mutagen ${release.tag_name} for ${getPlatformId()}...`);

  // Both the binary and the agent bundle live in the same platform archive.
  await downloadAndExtractAll(release, binary, agentBundle);

  onProgress?.('Mutagen installed successfully.');
  return binary;
}

// ---------------------------------------------------------------------------
// GitHub release helpers
// ---------------------------------------------------------------------------

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const raw = await fetchJson(GITHUB_LATEST_API);
  return raw as GitHubRelease;
}

function getPlatformId(): string {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin_arm64' : 'darwin_amd64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux_arm64' : 'linux_amd64';
  if (platform === 'win32') return arch === 'arm64' ? 'windows_arm64' : 'windows_amd64';
  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

function findAsset(release: GitHubRelease, pattern: RegExp): GitHubAsset {
  const asset = release.assets.find(a => pattern.test(a.name));
  if (!asset) {
    throw new Error(
      `No Mutagen release asset matches ${pattern} in release ${release.tag_name}. ` +
      `Available: ${release.assets.map(a => a.name).join(', ')}`
    );
  }
  return asset;
}

// ---------------------------------------------------------------------------
// Download + extraction
// ---------------------------------------------------------------------------

/**
 * Download the platform binary archive and extract both the CLI binary and the
 * agent bundle from it.
 *
 * Archive layout (v0.18+):
 *   mutagen                  → goes to bin/mutagen  (executable)
 *   mutagen-agents.tar.gz    → goes to libexec/mutagen-agents.tar.gz  (kept as-is)
 */
async function downloadAndExtractAll(
  release: GitHubRelease,
  destBinaryPath: string,
  destAgentBundlePath: string
): Promise<void> {
  const platformId = getPlatformId();
  // e.g. mutagen_darwin_arm64_v0.18.1.tar.gz
  const asset = findAsset(release, new RegExp(`^mutagen_${platformId}_`));

  const tmpArchive = path.join(os.tmpdir(), `mutagen-dl-${Date.now()}.tar.gz`);
  try {
    await downloadFile(asset.browser_download_url, tmpArchive);

    const binDir = path.dirname(destBinaryPath);
    const libexecDir = path.dirname(destAgentBundlePath);
    const binaryName = path.basename(destBinaryPath); // 'mutagen' or 'mutagen.exe'

    // Extract the CLI binary
    await execFileAsync('tar', ['-xzf', tmpArchive, '-C', binDir, binaryName]);

    // Extract the agent bundle (present in the archive since v0.18)
    await execFileAsync('tar', [
      '-xzf', tmpArchive,
      '-C', libexecDir,
      'mutagen-agents.tar.gz'
    ]);

    // Make binary executable (no-op on Windows)
    if (process.platform !== 'win32') {
      fs.chmodSync(destBinaryPath, 0o755);
    }
  } finally {
    tryUnlink(tmpArchive);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Fetch JSON from a URL, following redirects. */
async function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const doGet = (target: string, redirectsLeft = 5) => {
      const parsed = new URL(target);
      https
        .get(
          {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: {
              'User-Agent': 'vscode-mutagen-sync',
              Accept: 'application/vnd.github+json'
            }
          },
          res => {
            // Follow redirects
            if (
              res.statusCode === 301 ||
              res.statusCode === 302 ||
              res.statusCode === 307
            ) {
              const location = res.headers.location;
              if (!location) return reject(new Error('Redirect with no Location header'));
              if (redirectsLeft <= 0) return reject(new Error(`Too many redirects fetching ${url}`));
              res.resume();
              return doGet(location, redirectsLeft - 1);
            }
            if (res.statusCode !== 200) {
              res.resume();
              return reject(new Error(`GitHub API returned HTTP ${res.statusCode} for ${target}`));
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => (body += chunk));
            res.on('end', () => {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(new Error(`Failed to parse GitHub API response: ${String(e)}`));
              }
            });
            res.on('error', reject);
          }
        )
        .on('error', reject);
    };
    doGet(url);
  });
}

/** Download a URL to a local file, following redirects. */
async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doGet = (target: string, redirectsLeft = 5) => {
      const parsed = new URL(target);
      https
        .get(
          {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: { 'User-Agent': 'vscode-mutagen-sync' }
          },
          res => {
            // Follow redirects
            if (
              res.statusCode === 301 ||
              res.statusCode === 302 ||
              res.statusCode === 307
            ) {
              const location = res.headers.location;
              if (!location) return reject(new Error('Redirect with no Location header'));
              if (redirectsLeft <= 0) return reject(new Error(`Too many redirects downloading ${url}`));
              res.resume();
              return doGet(location, redirectsLeft - 1);
            }
            if (res.statusCode !== 200) {
              res.resume();
              return reject(
                new Error(`Download failed: HTTP ${res.statusCode} from ${target}`)
              );
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => file.close(err => (err ? reject(err) : resolve())));
            file.on('error', err => {
              tryUnlink(destPath);
              reject(err);
            });
            res.on('error', err => {
              tryUnlink(destPath);
              reject(err);
            });
          }
        )
        .on('error', err => {
          tryUnlink(destPath);
          reject(err);
        });
    };
    doGet(url);
  });
}

function tryUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best effort
  }
}
