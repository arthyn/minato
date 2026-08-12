/** Lifecycle state, derived from live truth first (spec §6, §7). */
export type PierState =
  | 'running'
  | 'stopped'
  | 'stale' // on disk, but untouched past the staleness threshold
  | 'ambiguous' // live evidence disagrees with itself — never auto-act on these
  | 'unknown' // the process table could not be read; liveness is undetermined
  | 'archived';

export interface Ports {
  loopback?: number;
  public?: number;
}

/** A drift or safety condition found while reading a pier. */
export interface Issue {
  level: 'warn' | 'error';
  code: string;
  message: string;
  /** Shell command or CLI invocation that would resolve it, when one exists. */
  fix?: string;
}

export interface Pier {
  /** Ship name without the leading sig, e.g. `doznec-doznec-sampel-palnet`. */
  ship: string;
  /** Operator-facing alias; defaults to the first phoneme of the ship. */
  shortname: string;
  path: string;
  state: PierState;
  /**
   * How `state` was established. `inferred` means the process table was
   * unavailable and liveness came from `.vere.lock` alone — good enough to
   * report, not good enough to act on.
   */
  livenessSource: 'process-table' | 'inferred' | 'none';
  archived: boolean;
  ports: Ports;
  /** Every live process serving this pier — kings first, then serfs. */
  pids: number[];
  /** The supervising process to signal on stop; null unless exactly one is up. */
  kingPid: number | null;
  /** PIDs left in .vere.lock by boots that are no longer running. */
  deadLockPids: number[];
  vere: string | null;
  /** Newest of the event log / checkpoint mtimes — when the ship last did work. */
  lastActivity: Date | null;
  sizeBytes: number | null;
  /** conn.sock present while nothing is running — a leftover, not liveness. */
  staleConnSock: boolean;
  staleLockFile: boolean;
  issues: Issue[];
}

export interface MoonMeta {
  shortname?: string;
  /** Port to reuse on `minato start` when none is given. */
  desiredPort?: number;
  archived?: boolean;
  notes?: string;
  /** Desk -> repo:branch mappings (spec §9). Recorded in v0, not yet acted on. */
  workspaces?: Array<{
    desk: string;
    repo: string;
    branch: string;
    active: boolean;
  }>;
}

export interface State {
  version: 1;
  moons: Record<string, MoonMeta>;
}

export interface Config {
  version: 1;
  /** Directories scanned for piers. */
  roots: string[];
  scanDepth: number;
  /** Days without activity before a pier is reported stale (spec §12). */
  staleAfterDays: number;
  /** Agent configs whose MCP server entries minato owns and keeps in sync. */
  agentConfigs: string[];
}
