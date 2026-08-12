import type { Config, Pier } from './types.ts';
import { buildAgent, type PortChange, type ServerRef } from './agents.ts';

export type EntryStatus =
  | 'ok'
  | 'port-drift' // names a known moon, but points at the wrong port
  | 'endpoint-down' // names a known moon that isn't running
  | 'misnamed' // port belongs to a running pier with a different name
  | 'orphan' // local port nothing is serving, and no pier by that name
  | 'unknown'; // liveness could not be determined, so nothing can be concluded

export interface McpEntry {
  ref: ServerRef;
  status: EntryStatus;
  /** The pier this entry is understood to be about, when one was identified. */
  pier: Pier | null;
  expectedPort: number | null;
  detail: string;
}

/** Codex names tables `wordpress_mcp` where Claude would use `wordpress-mcp`. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/_/g, '-');
}

/**
 * Cross-reference every locally-pointed MCP entry, across every agent config,
 * against live pier state. Remote endpoints are ignored entirely — minato only
 * claims local moons.
 */
export function auditMcp(config: Config, piers: Pier[]): McpEntry[] {
  const byName = new Map<string, Pier>();
  for (const p of piers) {
    byName.set(normalizeName(p.shortname), p);
    byName.set(normalizeName(p.ship), p);
  }

  const entries: McpEntry[] = [];
  for (const path of config.agentConfigs) {
    const agent = buildAgent(path);
    if (!agent.exists()) continue;

    for (const ref of agent.read()) {
      const named = byName.get(normalizeName(ref.name)) ?? null;
      const serving = piers.find((p) => p.state === 'running' && p.ports.public === ref.port);

      let status: EntryStatus;
      let detail: string;
      let pier = named;
      let expectedPort: number | null = null;

      if (named && named.state === 'unknown') {
        // Without liveness there is no basis for calling this healthy or broken.
        status = 'unknown';
        detail = `cannot determine whether ~${named.ship} is serving port ${ref.port}`;
        entries.push({ ref, status, pier: named, expectedPort: null, detail });
        continue;
      }

      if (named) {
        expectedPort = named.ports.public ?? null;
        if (named.state !== 'running') {
          status = 'endpoint-down';
          detail = `~${named.ship} is ${named.state}; nothing is serving port ${ref.port}`;
        } else if (expectedPort !== ref.port) {
          status = 'port-drift';
          detail = `~${named.ship} is serving ${expectedPort}, entry points at ${ref.port}`;
        } else {
          status = 'ok';
          detail = `~${named.ship} on ${ref.port}`;
        }
      } else if (serving) {
        status = 'misnamed';
        pier = serving;
        expectedPort = ref.port;
        detail = `port ${ref.port} is served by ~${serving.ship}, not by a pier named "${ref.name}"`;
      } else {
        status = 'orphan';
        detail = `no pier named "${ref.name}" and nothing is listening on ${ref.port}`;
      }

      entries.push({ ref, status, pier, expectedPort, detail });
    }
  }
  return entries;
}

export interface SyncResult {
  changed: McpEntry[];
  skipped: McpEntry[];
  backups: string[];
}

/**
 * Rewrite the port of every `port-drift` entry to the port its moon is actually
 * serving, in whichever agent config it came from. Auth headers and cookies are
 * preserved verbatim — minato cannot mint %mcp keys or refresh an urbauth
 * cookie, so entries needing new credentials are reported rather than guessed.
 */
export function syncMcp(config: Config, piers: Pier[], dryRun: boolean): SyncResult {
  const audit = auditMcp(config, piers);
  const changed = audit.filter((e) => e.status === 'port-drift' && e.expectedPort);
  const skipped = audit.filter((e) => e.status !== 'ok' && !changed.includes(e));
  if (dryRun || changed.length === 0) return { changed, skipped, backups: [] };

  const backups: string[] = [];
  for (const path of config.agentConfigs) {
    const agent = buildAgent(path);
    if (!agent.exists()) continue;
    const mine: PortChange[] = changed
      .filter((e) => e.ref.agent === agent.id)
      .map((e) => ({ ref: e.ref, toPort: e.expectedPort as number }));
    if (mine.length > 0) backups.push(agent.applyPortChanges(mine));
  }
  return { changed, skipped, backups };
}
