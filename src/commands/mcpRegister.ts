import { loadConfig, loadState } from '../config.ts';
import { readAllPiers, resolvePier } from '../discover.ts';
import { findClick, runStrand, type Click } from '../click.ts';
import { buildAgent } from '../agents.ts';
import type { Pier } from '../types.ts';
import { color, confirm } from '../ui.ts';
import { EXIT_FAILED, EXIT_OK, EXIT_VALIDATION } from './start.ts';

export interface McpRegisterOptions {
  moon: string;
  /** Entry name in the agent configs; defaults to the moon's shortname. */
  name?: string;
  click?: string;
  yes?: boolean;
  dryRun?: boolean;
}

/**
 * Read %mcp's client key off the ship.
 *
 * `%mcp-proxy` generates this at install and exposes it at `/x/client-key`; it
 * is the `x-api-key` the `/apps/mcp/mcp` endpoint expects. Reading it beats
 * minting a fresh credential — the ship already decided what its key is.
 */
function readClientKey(click: Click, pierPath: string): string {
  const out = runStrand(click, pierPath, [
    '=/  m  (strand ,vase)',
    ';<  =bowl  bind:m  get-bowl',
    '=+  .^(key=@t %gx /(scot %p our.bowl)/mcp-proxy/(scot %da now.bowl)/client-key/noun)',
    '(pure:m !>(key))',
  ]);

  // click prints the result as a hoon literal, e.g. [0 %avow 0 %noun 'key'].
  const match = out.match(/'([^']+)'/);
  if (!match) {
    throw new Error(
      `could not read a client key from ~mcp-proxy (is %mcp installed and running?)\n${out.trim().slice(-200)}`,
    );
  }
  return match[1];
}

export async function mcpRegisterCommand(opts: McpRegisterOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const pier = resolvePier(readAllPiers(config, state), opts.moon);

  if (pier.state !== 'running') {
    process.stderr.write(
      `${color('red', 'error')} ~${pier.ship} is ${pier.state}; it must be running to read its key\n`,
    );
    return EXIT_VALIDATION;
  }
  if (!pier.ports.public) {
    process.stderr.write(`${color('red', 'error')} ~${pier.ship} has no public port\n`);
    return EXIT_VALIDATION;
  }

  let click: Click | null;
  try {
    click = findClick(opts.click);
  } catch (err) {
    process.stderr.write(`${color('red', 'error')} ${(err as Error).message}\n`);
    return EXIT_VALIDATION;
  }
  if (!click) {
    process.stderr.write(`${color('red', 'error')} no usable click found; pass --click <path>\n`);
    return EXIT_VALIDATION;
  }

  const name = opts.name ?? pier.shortname;
  const url = `http://localhost:${pier.ports.public}/apps/mcp/mcp`;

  let key: string;
  try {
    key = readClientKey(click, pier.path);
  } catch (err) {
    process.stderr.write(`${color('red', 'error')} ${(err as Error).message}\n`);
    return EXIT_FAILED;
  }

  process.stdout.write(`${color('bold', 'plan')} — register ~${pier.ship}\n`);
  process.stdout.write(`  entry name  ${name}\n`);
  process.stdout.write(`  url         ${url}\n`);
  // The key is a credential; show only enough to recognise it.
  process.stdout.write(`  x-api-key   ${key.slice(0, 8)}… (${key.length} chars)\n`);
  for (const path of config.agentConfigs) {
    const agent = buildAgent(path);
    process.stdout.write(`  ${agent.exists() ? 'write ' : 'skip  '} ${path}\n`);
  }

  if (opts.dryRun) {
    process.stdout.write(`\n${color('dim', 'dry run — no config was changed')}\n`);
    return EXIT_OK;
  }
  if (!opts.yes && !(await confirm('\nwrite these entries?'))) {
    process.stdout.write('cancelled\n');
    return EXIT_OK;
  }

  const written: string[] = [];
  for (const path of config.agentConfigs) {
    const agent = buildAgent(path);
    if (!agent.exists()) continue;
    try {
      const backupPath = agent.upsertServer({ name, url, headers: { 'X-Api-Key': key } });
      written.push(`${agent.id} ${color('dim', `(backup: ${backupPath})`)}`);
    } catch (err) {
      process.stderr.write(
        color('yellow', `warn  could not write ${path}: ${(err as Error).message}\n`),
      );
    }
  }

  if (written.length === 0) {
    process.stderr.write(`${color('red', 'error')} nothing was written\n`);
    return EXIT_FAILED;
  }

  process.stdout.write(`\n${color('green', 'registered')} ${name} in ${written.length} config(s)\n`);
  for (const w of written) process.stdout.write(`  ${w}\n`);
  process.stdout.write(
    color('dim', 'restart Claude Code / Codex to pick it up — MCP servers connect at startup\n'),
  );
  return EXIT_OK;
}

/** Best-effort registration used after an install; never throws. */
export async function tryRegisterMcp(pier: Pier, opts: Partial<McpRegisterOptions>): Promise<void> {
  try {
    await mcpRegisterCommand({ ...opts, moon: pier.path, yes: true });
  } catch (err) {
    process.stderr.write(
      color('yellow', `warn  %mcp registration skipped: ${(err as Error).message}\n`),
    );
  }
}
