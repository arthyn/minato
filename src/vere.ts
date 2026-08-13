import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { MINATO_DIR } from './config.ts';

/** Version pulled if no local vere is available. Bumped by hand. */
export const FALLBACK_VERE = 'v4.6';
const BOOTSTRAP = 'https://bootstrap.urbit.org/vere/live';

export interface VereTarget {
  platform: 'macos' | 'linux';
  arch: string;
}

/**
 * Bootstrap and the `.bin/live` directories both name ARM builds `aarch64` on
 * every platform, including macOS — `macos-arm64` is not published and 403s.
 * Node reports the same CPU as `arm64`, so the two names must not be conflated.
 */
export function vereTarget(): VereTarget {
  const os = platform();
  const cpu = arch() === 'arm64' || arch() === 'arm' ? 'aarch64' : 'x86_64';
  if (os === 'darwin') return { platform: 'macos', arch: cpu };
  if (os === 'linux') return { platform: 'linux', arch: cpu };
  throw new Error(`unsupported platform: ${os}`);
}

/** Compare `v4.10` style versions numerically, not lexically. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface VereBinary {
  path: string;
  version: string;
  source: 'local' | 'downloaded';
}

/**
 * Newest vere already on disk, taken from the `.bin/live` directory of an
 * existing pier. Booting a new moon with the same binary the other ships run
 * avoids pulling a second copy, and keeps a fresh moon on a known-good version.
 */
export function findLocalVere(pierPaths: string[]): VereBinary | null {
  const target = vereTarget();
  const suffix = `-${target.platform}-${target.arch}`;
  let best: VereBinary | null = null;

  for (const pier of pierPaths) {
    const liveDir = join(pier, '.bin', 'live');
    if (!existsSync(liveDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(liveDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(suffix)) continue;
      const version = entry.match(/vere-(v[\d.]+)/)?.[1];
      if (!version) continue;
      if (!best || compareVersions(version, best.version) > 0) {
        best = { path: join(liveDir, entry), version, source: 'local' };
      }
    }
  }
  return best;
}

/** Fetch a vere build into ~/.minato/vere, reusing a prior download. */
export async function downloadVere(version = FALLBACK_VERE): Promise<VereBinary> {
  const target = vereTarget();
  const name = `vere-${version}-${target.platform}-${target.arch}`;
  const dir = join(MINATO_DIR, 'vere');
  const dest = join(dir, name);

  if (existsSync(dest)) {
    chmodSync(dest, 0o755);
    return { path: dest, version, source: 'downloaded' };
  }

  mkdirSync(dir, { recursive: true });
  const url = `${BOOTSTRAP}/${version}/${name}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`could not download vere from ${url} (HTTP ${res.status})`);
  }

  // Written to a temp name first so an interrupted download cannot leave a
  // truncated binary that looks usable on the next run.
  const tmp = `${dest}.partial`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
  const { renameSync } = await import('node:fs');
  renameSync(tmp, dest);
  chmodSync(dest, 0o755);
  return { path: dest, version, source: 'downloaded' };
}

export async function resolveVere(pierPaths: string[]): Promise<VereBinary> {
  return findLocalVere(pierPaths) ?? (await downloadVere());
}
