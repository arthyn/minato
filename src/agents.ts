import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './config.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/** One locally-pointed MCP server entry found in some agent's config. */
export interface ServerRef {
  /** Which agent's config this came from, e.g. `claude` or `codex`. */
  agent: string;
  /** `global`, or the project path the block lives under. */
  scope: string;
  name: string;
  url: string;
  port: number;
}

export interface PortChange {
  ref: ServerRef;
  toPort: number;
}

/**
 * Each agent stores MCP servers differently, so the audit works against this
 * interface rather than against any one file format.
 */
export interface AgentConfig {
  id: string;
  path: string;
  exists(): boolean;
  read(): ServerRef[];
  /** Rewrite only the ports of the given entries; everything else untouched. */
  applyPortChanges(changes: PortChange[]): string;
}

function parseLocalUrl(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) return null;
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
}

function backup(path: string): string {
  const dest = `${path}.minato-backup`;
  copyFileSync(path, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Claude Code — JSON, with a global mcpServers block plus per-project blocks
// ---------------------------------------------------------------------------

interface ClaudeConfigShape {
  mcpServers?: Record<string, { url?: string }>;
  projects?: Record<string, { mcpServers?: Record<string, { url?: string }> } | null>;
  [key: string]: unknown;
}

export function claudeAgent(path: string): AgentConfig {
  const load = (): ClaudeConfigShape => JSON.parse(readFileSync(path, 'utf8')) as ClaudeConfigShape;

  const blocks = (cfg: ClaudeConfigShape): Array<[string, Record<string, { url?: string }>]> => {
    const out: Array<[string, Record<string, { url?: string }>]> = [];
    if (cfg.mcpServers) out.push(['global', cfg.mcpServers]);
    for (const [projectPath, project] of Object.entries(cfg.projects ?? {})) {
      if (project?.mcpServers) out.push([projectPath, project.mcpServers]);
    }
    return out;
  };

  return {
    id: 'claude',
    path,
    exists: () => existsSync(path),
    read() {
      if (!existsSync(path)) return [];
      const refs: ServerRef[] = [];
      for (const [scope, block] of blocks(load())) {
        for (const [name, server] of Object.entries(block)) {
          if (typeof server?.url !== 'string') continue;
          const port = parseLocalUrl(server.url);
          if (port !== null) refs.push({ agent: 'claude', scope, name, url: server.url, port });
        }
      }
      return refs;
    },
    applyPortChanges(changes) {
      const backupPath = backup(path);
      const cfg = load();
      for (const { ref, toPort } of changes) {
        const block =
          ref.scope === 'global' ? cfg.mcpServers : cfg.projects?.[ref.scope]?.mcpServers;
        const server = block?.[ref.name];
        if (!server?.url) continue;
        const url = new URL(server.url);
        url.port = String(toPort);
        server.url = url.toString();
      }
      writeJsonAtomic(path, cfg);
      return backupPath;
    },
  };
}

// ---------------------------------------------------------------------------
// Codex — TOML, with [mcp_servers.NAME] tables
// ---------------------------------------------------------------------------

interface TomlBlock {
  name: string;
  start: number;
  end: number;
  text: string;
}

/**
 * Locate each `[mcp_servers.NAME]` table in raw TOML.
 *
 * Deliberately a scanner rather than a parser: minato only ever needs to read
 * and rewrite a port inside a URL string, and editing the raw text keeps the
 * user's comments, ordering, and formatting byte-for-byte intact.
 */
function findMcpBlocks(toml: string): TomlBlock[] {
  const blocks: TomlBlock[] = [];
  const header = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = header.exec(toml)) !== null) {
    const start = match.index + match[0].length;
    const nextHeader = /^\s*\[/m.exec(toml.slice(start));
    const end = nextHeader ? start + nextHeader.index : toml.length;
    blocks.push({
      name: match[1].replace(/^["']|["']$/g, ''),
      start,
      end,
      text: toml.slice(start, end),
    });
  }
  return blocks;
}

/** Every localhost URL inside a block — Codex hides them in `args` arrays too. */
function localUrlsIn(text: string): string[] {
  return text.match(/https?:\/\/[^\s"',\]]+/g)?.filter((u) => parseLocalUrl(u) !== null) ?? [];
}

export function codexAgent(path: string): AgentConfig {
  return {
    id: 'codex',
    path,
    exists: () => existsSync(path),
    read() {
      if (!existsSync(path)) return [];
      const toml = readFileSync(path, 'utf8');
      const refs: ServerRef[] = [];
      for (const block of findMcpBlocks(toml)) {
        // A Codex entry may name the same endpoint twice (a proxy `url` plus an
        // `args` copy); the first is enough to identify the port.
        const url = localUrlsIn(block.text)[0];
        if (!url) continue;
        const port = parseLocalUrl(url);
        if (port !== null) {
          refs.push({ agent: 'codex', scope: 'global', name: block.name, url, port });
        }
      }
      return refs;
    },
    applyPortChanges(changes) {
      const backupPath = backup(path);
      let toml = readFileSync(path, 'utf8');
      // Rebuild back-to-front so earlier offsets stay valid as text is spliced.
      for (const { ref, toPort } of [...changes].reverse()) {
        const block = findMcpBlocks(toml).find((b) => b.name === ref.name);
        if (!block) continue;
        const updated = block.text.replace(
          /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)):(\d+)/g,
          (_full, host: string) => `${host}:${toPort}`,
        );
        toml = toml.slice(0, block.start) + updated + toml.slice(block.end);
      }
      writeFileSync(path, toml, 'utf8');
      return backupPath;
    },
  };
}

/**
 * Ships that some agent config reaches at a **remote** address.
 *
 * A local pier for one of these is almost always an archive or a backup of a
 * ship whose live instance runs elsewhere. Booting it would put a second
 * instance of that ship on the network, so it is worth flagging loudly.
 *
 * Ship names are recovered from `urbauth-~<ship>` session cookies, which is
 * where an authenticated remote endpoint records who it is talking to.
 */
export function remoteShips(paths: string[]): Set<string> {
  const ships = new Set<string>();
  const collect = (text: string): void => {
    for (const m of text.matchAll(/urbauth-~([a-z]+(?:-[a-z]+)*)/g)) ships.add(m[1]);
  };

  for (const path of paths) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');

    if (path.endsWith('.toml')) {
      for (const block of findMcpBlocks(raw)) {
        if (localUrlsIn(block.text).length === 0) collect(block.text);
      }
      continue;
    }

    let cfg: ClaudeConfigShape;
    try {
      cfg = JSON.parse(raw) as ClaudeConfigShape;
    } catch {
      continue;
    }
    const blocks: Array<Record<string, { url?: string }>> = [];
    if (cfg.mcpServers) blocks.push(cfg.mcpServers);
    for (const project of Object.values(cfg.projects ?? {})) {
      if (project?.mcpServers) blocks.push(project.mcpServers);
    }
    for (const block of blocks) {
      for (const server of Object.values(block)) {
        if (typeof server?.url !== 'string') continue;
        if (parseLocalUrl(server.url) !== null) continue;
        collect(JSON.stringify(server));
      }
    }
  }
  return ships;
}

export function defaultAgentConfigPaths(): string[] {
  return [join(homedir(), '.claude.json'), join(homedir(), '.codex', 'config.toml')];
}

export function buildAgent(path: string): AgentConfig {
  return path.endsWith('.toml') ? codexAgent(path) : claudeAgent(path);
}
