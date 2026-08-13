import { getMeta, loadConfig, loadState } from '../config.ts';
import { livenessDegraded, livenessUnknown, readAllPiers, resolvePier } from '../discover.ts';
import { auditMcp, type McpEntry } from '../mcp.ts';
import { remoteShips } from '../agents.ts';
import { color } from '../ui.ts';
import type { WorkItem } from '../types.ts';

export interface DoctorOptions {
  moon?: string;
  json?: boolean;
}

const MCP_HINT: Record<McpEntry['status'], (e: McpEntry) => string | null> = {
  ok: () => null,
  'port-drift': (e) => `minato mcp sync   (rewrites ${e.ref.port} -> ${e.expectedPort})`,
  'endpoint-down': (e) =>
    e.pier ? `minato start ${e.pier.shortname} --port ${e.ref.port}` : 'start the moon it names',
  misnamed: (e) => `rename the entry to "${e.pier?.shortname}" or point it elsewhere`,
  orphan: () => 'remove the entry — nothing serves this port',
  unknown: () => 'liveness could not be determined; re-run outside the sandbox',
};

export async function doctorCommand(opts: DoctorOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const allPiers = readAllPiers(config, state);
  const piers = opts.moon ? [resolvePier(allPiers, opts.moon)] : allPiers;

  // MCP is always audited against every pier, so a drifted entry is still
  // attributed correctly when the report is scoped to one moon.
  const mcpAll = auditMcp(config, allPiers);
  const mcp = opts.moon
    ? mcpAll.filter((e) => e.pier && e.pier.ship === piers[0].ship)
    : mcpAll.filter((e) => e.status !== 'ok');

  if (opts.json) {
    const unknown = livenessUnknown(allPiers);
    process.stdout.write(
      `${JSON.stringify(
        {
          ...(unknown
            ? {
                error: 'liveness-unknown',
                message:
                  'Cannot read the process table. Every result below is inconclusive; ' +
                  'no ship can be reported as running or stopped.',
              }
            : {}),
          piers: piers.map((p) => ({ ship: p.ship, state: p.state, issues: p.issues })),
          mcp,
        },
        null,
        2,
      )}\n`,
    );
    return mcp.some((e) => e.status !== 'ok') || piers.some((p) => p.issues.length) ? 1 : 0;
  }

  if (livenessDegraded(allPiers)) {
    const undetermined = allPiers.filter((p) => p.state === 'unknown').length;
    process.stdout.write(
      `${color('yellow', 'LIVENESS INFERRED')} — no process table (sandboxed?).\n` +
        'Ships reported running were confirmed from .vere.lock alone; duplicate boots\n' +
        `cannot be detected. ${undetermined} pier(s) are ${color('red', 'unknown')} — undetermined, ` +
        'NOT stopped.\nRe-run outside the sandbox for a full assessment.\n\n',
    );
  }

  let problems = 0;

  // A local pier for a ship an agent config reaches remotely is almost always
  // an archive. Booting it would run a second instance of a live ship, so this
  // is reported as an error and not merely a warning.
  const remote = remoteShips(config.agentConfigs);
  const twins = piers.filter((p) => !p.archived && remote.has(p.ship));
  if (twins.length > 0) {
    process.stdout.write(`${color('bold', 'ARCHIVE RISK')}\n`);
    for (const pier of twins) {
      problems += 1;
      process.stdout.write(
        `  ${color('red', 'error')}  ~${pier.ship} runs remotely, but a local pier exists\n` +
          `    ${color('dim', pier.path)}\n` +
          `    ${color('dim', 'booting it would put a second instance of a live ship on the network')}\n` +
          `    ${color('dim', `fix: minato archive ${pier.shortname}`)}\n`,
      );
    }
    process.stdout.write('\n');
  }

  // The recorded workstream is the part nothing can derive: mounted desks show
  // what a moon *can* do, never what is being done on it right now. So a moon
  // carrying no description, or work that has sat untouched, is reported —
  // otherwise the record quietly rots into being worse than nothing.
  const undescribed = piers.filter(
    (p) => p.state === 'running' && !p.archived && !getMeta(state, p.path).description,
  );
  const staleWork: Array<{ pier: typeof piers[number]; item: WorkItem; days: number }> = [];
  for (const pier of piers) {
    for (const item of getMeta(state, pier.path).work ?? []) {
      const days = Math.floor((Date.now() - new Date(item.started).getTime()) / 86_400_000);
      if (days > config.workStaleAfterDays) staleWork.push({ pier, item, days });
    }
  }

  if (undescribed.length > 0 || staleWork.length > 0) {
    process.stdout.write(`${color('bold', 'WORK RECORD')}\n`);
    for (const pier of undescribed) {
      problems += 1;
      process.stdout.write(
        `  ${color('yellow', ' warn')}  ~${pier.ship} is running with no description\n` +
          `           ${color('dim', `fix: minato describe ${pier.shortname} "<what it is for>"`)}\n`,
      );
    }
    for (const { pier, item, days } of staleWork) {
      problems += 1;
      process.stdout.write(
        `  ${color('yellow', ' warn')}  "${item.id}" on ~${pier.ship} has been open ${days} days\n` +
          `           ${color('dim', `${item.note}`)}\n` +
          `           ${color('dim', `fix: minato work done ${pier.shortname} ${item.id} — or confirm it is still active`)}\n`,
      );
    }
    process.stdout.write('\n');
  }

  // Shortnames must be globally unique (spec §12.5) — every shorthand command
  // resolves through them, so a collision makes those piers unaddressable.
  const byShortname = new Map<string, typeof allPiers>();
  for (const p of allPiers) {
    const key = p.shortname.toLowerCase();
    byShortname.set(key, [...(byShortname.get(key) ?? []), p]);
  }
  const collisions = [...byShortname.entries()].filter(([, group]) => group.length > 1);
  if (collisions.length > 0 && !opts.moon) {
    process.stdout.write(`${color('bold', 'SHORTNAMES')}\n`);
    for (const [name, group] of collisions) {
      problems += 1;
      process.stdout.write(
        `  ${color('yellow', 'collision')}  "${name}" refers to ${group.length} piers\n`,
      );
      for (const p of group) process.stdout.write(`    ${color('dim', p.path)}\n`);
      process.stdout.write(
        `    ${color('dim', `fix: minato name ${group[1].path} <unique-shortname>`)}\n`,
      );
    }
    process.stdout.write('\n');
  }

  const withIssues = piers.filter((p) => p.issues.length > 0);
  if (withIssues.length > 0) {
    process.stdout.write(`${color('bold', 'PIERS')}\n`);
    for (const pier of withIssues) {
      process.stdout.write(`  ~${pier.ship} ${color('dim', `(${pier.state})`)}\n`);
      for (const issue of pier.issues) {
        problems += 1;
        const tag = issue.level === 'error' ? color('red', 'error') : color('yellow', ' warn');
        process.stdout.write(`    ${tag}  ${issue.message}\n`);
        if (issue.fix) process.stdout.write(`           ${color('dim', `fix: ${issue.fix}`)}\n`);
      }
    }
    process.stdout.write('\n');
  }

  const mcpProblems = mcp.filter((e) => e.status !== 'ok');
  if (mcpProblems.length > 0) {
    process.stdout.write(`${color('bold', 'MCP ENDPOINTS')}\n`);
    for (const entry of mcpProblems) {
      problems += 1;
      const scope =
        entry.ref.scope === 'global' ? entry.ref.agent : `${entry.ref.agent}: ${entry.ref.scope}`;
      process.stdout.write(
        `  ${color('yellow', entry.status)}  ${color('bold', entry.ref.name)} ${color('dim', `(${scope})`)}\n`,
      );
      process.stdout.write(`    ${entry.detail}\n`);
      const hint = MCP_HINT[entry.status](entry);
      if (hint) process.stdout.write(`    ${color('dim', `fix: ${hint}`)}\n`);
    }
    process.stdout.write('\n');
  }

  if (problems === 0) {
    process.stdout.write(`${color('green', 'healthy')} — no drift found\n`);
    return 0;
  }
  process.stdout.write(color('dim', `${problems} issues found\n`));
  return 1;
}
