import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import type { Config, Issue, Pier, State } from './types.ts';
import { getMeta } from './config.ts';
import {
  classifyPierProcs,
  detectVere,
  inferLiveness,
  isAlive,
  lastActivity,
  portFromCommand,
  tryProcessTable,
  readHttpPorts,
  readLockPids,
  type Proc,
} from './live.ts';

const SKIP_DIRS = new Set([
  'Library',
  '.Trash',
  'node_modules',
  '.git',
  'Applications',
  '.cache',
  '.npm',
  'go',
  '.rustup',
  '.cargo',
]);

/** A directory is a pier if it carries an event log, not merely a `.urb`. */
function isPier(dir: string): boolean {
  return existsSync(join(dir, '.urb', 'log'));
}

export function findPierPaths(config: Config): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (depth > config.scanDepth || seen.has(dir)) return;
    seen.add(dir);
    if (isPier(dir)) {
      found.push(dir);
      return; // piers are never nested inside piers
    }
    if (depth === config.scanDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const child = join(dir, entry);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(child, depth + 1);
    }
  };

  for (const root of config.roots) walk(root, 0);
  return found.sort();
}

function dirSizeBytes(path: string): number | null {
  try {
    const out = execFileSync('du', ['-sk', path], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number(out.split(/\s+/)[0]) * 1024;
  } catch {
    return null;
  }
}

export interface ReadOptions {
  /** `du` over ~90 GB of piers is slow; only pay for it when sizes are shown. */
  withSize?: boolean;
}

export function readPier(
  path: string,
  config: Config,
  state: State,
  /** null when the process table could not be read — liveness is unknowable. */
  procs: Proc[] | null,
  opts: ReadOptions = {},
): Pier {
  const ship = basename(path);
  const meta = getMeta(state, path);
  const issues: Issue[] = [];

  if (procs === null) {
    // No process table. Fall back to lock-file pids, which can confirm a ship
    // is up but can never show one is down — see inferLiveness.
    const inferred = inferLiveness(path);
    if (inferred.running) {
      issues.push({
        level: 'warn',
        code: 'liveness-inferred',
        message:
          `confirmed running from .vere.lock (pid ${inferred.pids.join(', ')}), ` +
          'without the process table — a duplicate boot could not be detected',
      });
    } else {
      // Emphatically not "stopped": a live ship whose lock we cannot read
      // would look identical.
      issues.push({
        level: 'error',
        code: 'liveness-unknown',
        message:
          'no live pid in .vere.lock and no process table — cannot tell whether this ship is running',
        fix: 'run minato outside the sandbox, or grant it permission to run `ps`',
      });
    }
    return {
      ship,
      shortname: meta.shortname ?? ship.split('-')[0],
      path,
      state: meta.archived ? 'archived' : inferred.running ? 'running' : 'unknown',
      livenessSource: inferred.running ? 'inferred' : 'none',
      archived: Boolean(meta.archived),
      ports: readHttpPorts(path),
      pids: inferred.pids,
      kingPid: null,
      deadLockPids: [],
      vere: detectVere(path),
      lastActivity: lastActivity(path),
      sizeBytes: opts.withSize ? dirSizeBytes(path) : null,
      staleConnSock: false,
      staleLockFile: false,
      issues,
    };
  }

  const { kings, serfs } = classifyPierProcs(procs, path);
  const lockPids = readLockPids(path);
  const deadLockPids = lockPids.filter((pid) => !isAlive(pid));
  const running = kings.length === 1;

  const ports = readHttpPorts(path);
  const connSockPresent = existsSync(join(path, '.urb', 'conn.sock'));
  const staleConnSock = connSockPresent && kings.length === 0 && serfs.length === 0;
  const staleLockFile = deadLockPids.length > 0;

  let stateValue: Pier['state'];
  if (meta.archived) {
    stateValue = 'archived';
  } else if (kings.length > 1) {
    // The exact case §11 exists to prevent. Never act on it automatically.
    stateValue = 'ambiguous';
    issues.push({
      level: 'error',
      code: 'duplicate-boot',
      message: `booted ${kings.length} times — pids ${kings
        .map((k) => `${k.pid} (port ${portFromCommand(k.command) ?? '?'})`)
        .join(', ')}`,
      fix: 'inspect both, then stop the unwanted one by hand — minato will not choose for you',
    });
  } else if (kings.length === 0 && serfs.length > 0) {
    stateValue = 'ambiguous';
    issues.push({
      level: 'error',
      code: 'orphaned-serf',
      message: `worker pid ${serfs.map((s) => s.pid).join(', ')} is running with no supervising process`,
      fix: `inspect with: ps -p ${serfs[0].pid} -o command=`,
    });
  } else if (running) {
    stateValue = 'running';
  } else {
    stateValue = 'stopped';
  }

  if (running) {
    const king = kings[0];
    const launchPort = portFromCommand(king.command);
    // Disagreement here means the ship is mid-restart, or rebound after boot.
    if (launchPort && ports.public && launchPort !== ports.public) {
      issues.push({
        level: 'warn',
        code: 'port-mismatch',
        message: `launched with --http-port ${launchPort} but .http.ports reports ${ports.public}`,
        fix: 'likely mid-restart — re-run minato doctor in a moment',
      });
    }
    if (!ports.public && launchPort) ports.public = launchPort;

    // Ships started in a terminal tab die with it, which is a common way for a
    // moon an agent depends on to vanish without explanation.
    const parent = procs.find((p) => p.pid === king.ppid);
    if (parent && /(^|\/)-?(zsh|bash|sh|fish)$/.test(parent.command.split(/\s+/)[0])) {
      issues.push({
        level: 'warn',
        code: 'terminal-bound',
        message: `supervised by a shell (pid ${parent.pid}) — closing that terminal kills the ship`,
        fix: `minato restart ${meta.shortname ?? ship.split('-')[0]} detaches it properly`,
      });
    }
  }

  const activity = lastActivity(path);
  const ageDays = activity ? (Date.now() - activity.getTime()) / 86_400_000 : null;
  if (stateValue === 'stopped' && ageDays !== null && ageDays > config.staleAfterDays) {
    stateValue = 'stale';
  }

  if (staleLockFile) {
    issues.push({
      level: 'warn',
      code: 'stale-lock',
      message: running
        ? `.vere.lock carries dead pid ${deadLockPids.join(', ')} from an earlier boot`
        : `.vere.lock names dead pid ${deadLockPids.join(', ')} — leftover from an unclean exit`,
      fix: running ? undefined : `rm ${join(path, '.vere.lock')}`,
    });
  }
  if (staleConnSock) {
    issues.push({
      level: 'warn',
      code: 'stale-conn-sock',
      message: 'conn.sock left behind by an unclean shutdown (not evidence the ship is up)',
      fix: `rm ${join(path, '.urb', 'conn.sock')}`,
    });
  }
  if (running && !ports.public) {
    issues.push({
      level: 'warn',
      code: 'no-public-port',
      message: 'running but .http.ports lists no public port — agents cannot reach it',
    });
  }

  return {
    ship,
    shortname: meta.shortname ?? ship.split('-')[0],
    path,
    state: stateValue,
    livenessSource: 'process-table',
    archived: Boolean(meta.archived),
    ports,
    pids: [...kings.map((k) => k.pid), ...serfs.map((s) => s.pid)],
    kingPid: running ? kings[0].pid : null,
    deadLockPids,
    vere: detectVere(path),
    lastActivity: activity,
    sizeBytes: opts.withSize ? dirSizeBytes(path) : null,
    staleConnSock,
    staleLockFile,
    issues,
  };
}

export function readAllPiers(config: Config, state: State, opts: ReadOptions = {}): Pier[] {
  const procs = tryProcessTable();
  return findPierPaths(config).map((p) => readPier(p, config, state, procs, opts));
}

/** True when the process table was unavailable, whatever could be inferred. */
export function livenessDegraded(piers: Pier[]): boolean {
  return piers.some((p) => p.livenessSource !== 'process-table');
}

/** True when at least one pier's state could not be established at all. */
export function livenessUnknown(piers: Pier[]): boolean {
  return piers.some((p) => p.state === 'unknown');
}

/** Resolve a user-supplied shortname, ship name, or path to exactly one pier. */
export function resolvePier(piers: Pier[], query: string): Pier {
  const q = query.replace(/^~/, '').toLowerCase();
  const exact = piers.filter((p) => p.ship.toLowerCase() === q || p.shortname.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(
      `"${query}" is ambiguous: ${exact.map((p) => `${p.ship} (${p.path})`).join(', ')}`,
    );
  }
  const partial = piers.filter((p) => p.ship.toLowerCase().startsWith(q) || p.path === query);
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${query}" matches ${partial.map((p) => p.ship).join(', ')} — be specific`);
  }
  throw new Error(`no pier matches "${query}" (try: minato list)`);
}
