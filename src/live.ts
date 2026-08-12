import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Ports } from './types.ts';

export interface Proc {
  pid: number;
  ppid: number;
  command: string;
}

/** Raised when the process table cannot be read, so liveness is unknowable. */
export class ProcessTableUnavailable extends Error {}

/**
 * A successful `ps -ax` on macOS always lists a great many processes. Anything
 * near-empty means the call was blocked or truncated rather than that the
 * machine is idle.
 */
const MIN_PLAUSIBLE_PROCS = 10;

/**
 * One `ps` call for the whole run. Every liveness question is answered from this
 * snapshot, so a pier cannot look alive in one check and dead in the next — a
 * real hazard here, since a ship restarting mid-scan otherwise reads as two
 * different states.
 *
 * Throws rather than returning an empty list when `ps` is unavailable. Agent
 * sandboxes (Codex's read-only mode, for one) deny `ps` outright, and an empty
 * table would otherwise read as "nothing is running" — the precise condition
 * under which `start` would boot a second instance of a live ship.
 */
export function processTable(): Proc[] {
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      maxBuffer: 8 << 20,
      // Sandboxes print their own denial to stderr; minato reports the
      // condition itself, so the raw noise would only confuse a reader.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    throw new ProcessTableUnavailable(
      `could not run 'ps': ${(err as Error).message.split('\n')[0]}`,
    );
  }
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  if (procs.length < MIN_PLAUSIBLE_PROCS) {
    throw new ProcessTableUnavailable(
      `'ps' returned only ${procs.length} processes — output is being blocked or truncated`,
    );
  }
  return procs;
}

/** Read the process table, or null if it cannot be read. Never silently empty. */
export function tryProcessTable(): Proc[] | null {
  try {
    return processTable();
  } catch (err) {
    if (err instanceof ProcessTableUnavailable) return null;
    throw err;
  }
}

/**
 * Does this command line belong to the given pier?
 *
 * Vere is invoked as `<pier>/.run …`, and the leading path is relative whenever
 * the ship was started from the parent directory, so match the pier's basename
 * followed by `/.run` rather than the absolute path. Requiring the `.run` suffix
 * keeps an editor or a `grep` that merely names the pier from matching.
 */
export function commandTargetsPier(command: string, pierPath: string): boolean {
  const name = basename(pierPath);
  return (
    command.includes(`${pierPath}/.run`) ||
    command.includes(`--snap-dir ${pierPath}`) ||
    new RegExp(`(^|[\\s/])${escapeRegExp(name)}/\\.run(\\s|$)`).test(command)
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface PierProcs {
  /** Supervising vere processes — one per booted instance of the pier. */
  kings: Proc[];
  /** Worker processes (`.run work --snap-dir …`), children of a king. */
  serfs: Proc[];
}

/**
 * Split the processes touching a pier into kings and serfs.
 *
 * This is the load-bearing distinction for duplicate-boot detection: a healthy
 * ship is exactly one king with one serf child, so two kings means the pier was
 * booted twice — the case the safety rules exist to prevent.
 */
export function classifyPierProcs(procs: Proc[], pierPath: string): PierProcs {
  const mine = procs.filter((p) => commandTargetsPier(p.command, pierPath));
  return {
    kings: mine.filter((p) => !/\.run\s+work\s/.test(p.command)),
    serfs: mine.filter((p) => /\.run\s+work\s/.test(p.command)),
  };
}

/** The `--http-port` a king was launched with, which may predate a rebind. */
export function portFromCommand(command: string): number | null {
  const m = command.match(/--http-port\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * PIDs recorded in `.vere.lock`.
 *
 * Note this file holds the *serf* pid (plus leftover lines from earlier boots),
 * not the king — so it is corroborating evidence only. The process table is the
 * source of truth for whether a ship is up.
 */
export function readLockPids(pierPath: string): number[] {
  const lock = join(pierPath, '.vere.lock');
  if (!existsSync(lock)) return [];
  return readFileSync(lock, 'utf8')
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Ports vere is serving on. Written at boot and removed on clean exit, so its
 * presence corroborates liveness — it is never the sole source.
 */
export function readHttpPorts(pierPath: string): Ports {
  const file = join(pierPath, '.http.ports');
  if (!existsSync(file)) return {};
  const ports: Ports = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^(\d+)\s+\w+\s+(loopback|public)/);
    if (m) ports[m[2] as 'loopback' | 'public'] = Number(m[1]);
  }
  return ports;
}

/**
 * Vere version, identified by inode: `.run` is a hard link to the active binary
 * under `.bin/live/`, so the filenames never have to be parsed for ordering.
 */
export function detectVere(pierPath: string): string | null {
  const run = join(pierPath, '.run');
  const liveDir = join(pierPath, '.bin', 'live');
  if (!existsSync(run) || !existsSync(liveDir)) return null;
  let runIno: number;
  try {
    runIno = statSync(run).ino;
  } catch {
    return null;
  }
  for (const entry of readdirSync(liveDir)) {
    try {
      if (statSync(join(liveDir, entry)).ino === runIno) {
        return entry.match(/vere-(v[\d.]+)/)?.[1] ?? entry;
      }
    } catch {
      // unreadable candidate; keep looking
    }
  }
  return null;
}

/** Newest mtime across the checkpoint and event log — when the ship last ran. */
export function lastActivity(pierPath: string): Date | null {
  const candidates = [
    join(pierPath, '.urb', 'chk', 'image.bin'),
    join(pierPath, '.urb', 'log'),
    join(pierPath, '.urb'),
  ];
  let newest: Date | null = null;
  for (const c of candidates) {
    try {
      const m = statSync(c).mtime;
      if (!newest || m > newest) newest = m;
    } catch {
      // missing component; try the next
    }
  }
  return newest;
}

export type PortStatus = 'free' | 'in-use' | 'unknown';

/**
 * Probe a TCP port by trying to bind it.
 *
 * Preferred over `lsof`, which silently reports nothing for privileged ports
 * when run without root — a ship serving port 80 reads as "port free" under
 * `lsof` while actually serving. Binding below 1024 as a normal user yields
 * EACCES, which is reported as `unknown` rather than guessed at either way.
 */
export function checkPort(port: number): Promise<PortStatus> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') resolve('in-use');
      else if (err.code === 'EACCES') resolve('unknown');
      else resolve('unknown');
    });
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      server.close(() => resolve('free'));
    });
  });
}

/**
 * Does this pid exist?
 *
 * `EPERM` counts as alive: the kernel checks existence *before* permission, so
 * it means "this process exists but you may not signal it" — which is what an
 * agent sandbox returns for a live process it is denied access to. A pid that
 * genuinely does not exist yields `ESRCH` even inside the sandbox, so the two
 * outcomes stay distinguishable where `ps` does not.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface InferredLiveness {
  running: boolean;
  pids: number[];
}

/**
 * Liveness without the process table, for use inside sandboxes that deny `ps`.
 *
 * `.vere.lock` names the serf of every boot, and a running ship always has a
 * live serf listed there. Checking those pids with signal 0 therefore confirms
 * a ship is up. It cannot do the reverse: no live pid means only that liveness
 * is undetermined, never that the ship is stopped.
 *
 * Deliberately one-directional. The dangerous error is concluding "stopped"
 * about a live ship, because that invites a duplicate boot; concluding
 * "running" merely makes minato refuse to act, which is safe. Duplicate boots
 * themselves are undetectable this way, so `start` and `stop` still require a
 * real process table.
 */
export function inferLiveness(pierPath: string): InferredLiveness {
  const pids = readLockPids(pierPath).filter(isAlive);
  return { running: pids.length > 0, pids };
}
