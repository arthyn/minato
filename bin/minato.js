#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';

const STATE_DIR = path.join(os.homedir(), '.config', 'minato');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const MOONS_DIR = path.join(os.homedir(), 'piers', 'moons');

function sh(command) {
  const r = spawnSync('zsh', ['-lc', command], { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim()
  };
}

function shInteractive(command) {
  const r = spawnSync('zsh', ['-lc', command], { stdio: 'inherit' });
  return {
    ok: r.status === 0,
    code: r.status
  };
}

function findCandidatePiers(shortname) {
  if (!fs.existsSync(MOONS_DIR)) return [];
  return fs.readdirSync(MOONS_DIR)
    .filter(d => d.includes(shortname))
    .map(d => path.join(MOONS_DIR, d));
}

function resolvePier(moon) {
  if (moon.pier_hint && fs.existsSync(moon.pier_hint)) {
    return { ok: true, pier: moon.pier_hint, source: 'hint' };
  }
  const candidates = findCandidatePiers(moon.shortname);
  if (candidates.length === 1) {
    return { ok: true, pier: candidates[0], source: 'auto' };
  }
  if (candidates.length === 0) {
    return { ok: false, reason: 'no-pier-found', candidates: [] };
  }
  return { ok: false, reason: 'multiple-piers-found', candidates };
}

function shellEscapeSingle(s) {
  return String(s).replace(/'/g, `'\\''`);
}

function detectRuntime(moon) {
  const short = moon.shortname;
  const screen = sh(`screen -ls | grep -i '\\.${short}$' || true`);
  const proc = sh(`ps aux | grep -i '[u]rbit' | grep -i '${short}' || true`);
  const piers = findCandidatePiers(short);

  const pierChecks = piers.map((pier) => {
    const lockPath = path.join(pier, '.vere.lock');
    const portsPath = path.join(pier, '.http.ports');
    return {
      pier,
      hasLock: fs.existsSync(lockPath),
      hasHttpPorts: fs.existsSync(portsPath)
    };
  });

  const hasScreen = !!screen.out;
  const hasProc = !!proc.out;
  const hasPierSignal = pierChecks.some(p => p.hasLock || p.hasHttpPorts);
  const running = [hasScreen, hasProc, hasPierSignal].filter(Boolean).length >= 2;

  return {
    hasScreen,
    hasProc,
    hasPierSignal,
    running,
    screenLines: screen.out ? screen.out.split('\n') : [],
    procLines: proc.out ? proc.out.split('\n') : [],
    pierChecks
  };
}

function pickScreenSession(runtime, shortname) {
  const lines = runtime.screenLines || [];
  for (const line of lines) {
    const m = line.match(/\t([^\s]+)\s*\(/);
    if (!m) continue;
    const session = m[1];
    if (session.endsWith(`.${shortname}`)) return session;
  }
  return null;
}

function cmdStart(state, moon) {
  const runtime = detectRuntime(moon);
  if (runtime.running) {
    console.log(`Refusing start: ${moon.shortname} already appears running (2/3 checks).`);
    return { ok: false, code: 2 };
  }
  if (runtime.hasScreen || runtime.hasProc || runtime.hasPierSignal) {
    console.log(`Ambiguous runtime signals for ${moon.shortname}; refusing risky start.`);
    console.log('Run: minato inspect <moon> and resolve manually first.');
    return { ok: false, code: 2 };
  }

  const pier = resolvePier(moon);
  if (!pier.ok) {
    console.log(`Cannot start ${moon.shortname}: ${pier.reason}`);
    if (pier.candidates?.length) {
      console.log('Candidates:');
      for (const c of pier.candidates) console.log(`- ${c}`);
    }
    console.log('Set moon.pier_hint in state file for deterministic starts.');
    return { ok: false, code: 2 };
  }

  const runPath = path.join(pier.pier, '.run');
  if (!fs.existsSync(runPath)) {
    console.log(`Cannot start ${moon.shortname}: missing executable ${runPath}`);
    return { ok: false, code: 2 };
  }

  const sessionName = moon.shortname;
  const startCmd = `screen -dmS ${sessionName} zsh -lc 'cd ${shellEscapeSingle(pier.pier)} && exec ./.run'`;
  const launched = sh(startCmd);
  if (!launched.ok) {
    console.log(`Failed to start ${moon.shortname}`);
    if (launched.err) console.log(launched.err);
    return { ok: false, code: 1 };
  }

  sh('sleep 1');
  const after = detectRuntime(moon);
  if (!after.running) {
    console.log(`Start attempted for ${moon.shortname}, but runtime not confirmed yet.`);
    console.log('Run: minato inspect <moon> to verify.');
    moon.state = 'booting';
  } else {
    moon.state = 'running';
    moon.last_seen_running_at = now();
  }
  moon.last_booted_at = now();
  moon.pier_hint = pier.pier;
  moon.updated_at = now();
  saveState(state);
  console.log(`start ok: ${moon.shortname} (${moon.state}) via screen session '${sessionName}'`);
  return { ok: true, code: 0 };
}

function cmdStop(state, moon) {
  const runtime = detectRuntime(moon);
  if (!runtime.running) {
    moon.state = 'stopped';
    moon.updated_at = now();
    saveState(state);
    console.log(`Marked stopped: ${moon.shortname} (no live runtime detected).`);
    return { ok: true, code: 0 };
  }

  if (!runtime.hasScreen) {
    console.log(`Refusing stop for ${moon.shortname}: running but no screen session detected.`);
    console.log('Manual intervention required (no-kill safety policy).');
    return { ok: false, code: 2 };
  }

  const session = pickScreenSession(runtime, moon.shortname);
  if (!session) {
    console.log(`Refusing stop for ${moon.shortname}: could not resolve screen session name.`);
    return { ok: false, code: 2 };
  }

  const sendExit = sh(`screen -S '${shellEscapeSingle(session)}' -p 0 -X stuff $'|exit\\n'`);
  if (!sendExit.ok) {
    console.log(`Failed to send |exit to ${session}`);
    if (sendExit.err) console.log(sendExit.err);
    return { ok: false, code: 1 };
  }

  let stopped = false;
  for (let i = 0; i < 8; i++) {
    sh('sleep 1');
    const after = detectRuntime(moon);
    if (!after.running) { stopped = true; break; }
  }

  if (!stopped) {
    console.log(`Graceful stop initiated for ${moon.shortname}, but still appears running.`);
    console.log('No force-kill performed (policy). Re-run stop or inspect manually.');
  }

  moon.state = 'stopped';
  moon.updated_at = now();
  saveState(state);
  console.log(`stop ok: ${moon.shortname} (graceful |exit via ${session})`);
  return { ok: true, code: 0 };
}

function ensureState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ version: 1, moons: [], planet: null, updatedAt: Date.now() }, null, 2)
    );
  }
}

function loadState() {
  ensureState();
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  state.updatedAt = Date.now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function now() { return new Date().toISOString(); }

function getMoon(state, key) {
  return state.moons.find(m => m.shortname === key || m.moon_ship === key);
}

function usage() {
  console.log(`minato v0

Usage:
  minato
  minato new <shortname>
  minato list
  minato inspect <moon>
  minato start <moon>
  minato stop <moon>
  minato restart <moon>
  minato swap <moon> [workspace]
  minato update [moon|--all]
  minato doctor [moon]
  minato sync [moon|--all]
  minato dojo <moon>
`);
}

async function interactive() {
  const rl = readline.createInterface({ input, output });
  while (true) {
    console.log('\nMinato');
    console.log('1) list');
    console.log('2) new');
    console.log('3) inspect');
    console.log('4) start');
    console.log('5) stop');
    console.log('6) restart');
    console.log('7) swap');
    console.log('8) doctor');
    console.log('9) exit');
    const pick = (await rl.question('> ')).trim();
    if (pick === '9') break;
    if (pick === '1') await run(['list']);
    if (pick === '2') {
      const name = (await rl.question('shortname: ')).trim();
      await run(['new', name]);
    }
    if (pick === '3') await run(['inspect', (await rl.question('moon: ')).trim()]);
    if (pick === '4') await run(['start', (await rl.question('moon: ')).trim()]);
    if (pick === '5') await run(['stop', (await rl.question('moon: ')).trim()]);
    if (pick === '6') await run(['restart', (await rl.question('moon: ')).trim()]);
    if (pick === '7') {
      const moon = (await rl.question('moon: ')).trim();
      const ws = (await rl.question('workspace: ')).trim();
      await run(['swap', moon, ws]);
    }
    if (pick === '8') await run(['doctor']);
  }
  rl.close();
}

async function run(argv) {
  const state = loadState();
  const [cmd, ...args] = argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === 'list') {
    if (!state.moons.length) return console.log('No moons tracked yet.');
    for (const m of state.moons) {
      console.log(`${m.shortname}\t${m.state}\t${m.moon_ship || '-'}\t${m.last_seen_running_at || '-'}`);
    }
    return;
  }

  if (cmd === 'new') {
    const shortname = args[0];
    if (!shortname) return console.log('Usage: minato new <shortname>');
    if (state.moons.some(m => m.shortname === shortname)) {
      console.log(`Shortname already exists: ${shortname}`);
      process.exitCode = 1;
      return;
    }
    const moon = {
      shortname,
      moon_ship: null,
      pier_hint: null,
      state: 'created',
      created_at: now(),
      updated_at: now(),
      last_booted_at: null,
      last_seen_running_at: null,
      version_vere: null,
      version_arvo: null,
      archived: false,
      notes: null,
      mappings: []
    };
    state.moons.push(moon);
    saveState(state);
    console.log(`Created ${shortname}.`);
    console.log('Next: wire real moon allocation/boot + %mcp install flow.');
    return;
  }

  if (cmd === 'inspect') {
    const moon = getMoon(state, args[0]);
    if (!moon) return console.log('Moon not found.');
    const runtime = detectRuntime(moon);
    console.log(JSON.stringify({ moon, runtime }, null, 2));
    return;
  }

  if (['start', 'stop', 'restart'].includes(cmd)) {
    const key = args[0];
    const moon = getMoon(state, key);
    if (!moon) return console.log('Moon not found.');
    if (cmd === 'start') {
      const res = cmdStart(state, moon);
      if (!res.ok) process.exitCode = res.code;
      return;
    }

    if (cmd === 'stop') {
      const res = cmdStop(state, moon);
      if (!res.ok) process.exitCode = res.code;
      return;
    }

    if (cmd === 'restart') {
      const before = detectRuntime(moon);
      if (before.running) {
        console.log(`restart: stopping ${moon.shortname}...`);
        const stopRes = cmdStop(state, moon);
        if (!stopRes.ok) {
          process.exitCode = stopRes.code;
          return;
        }
      } else {
        console.log(`restart: ${moon.shortname} already stopped, continuing to start...`);
      }

      sh('sleep 1');
      const afterStop = detectRuntime(moon);
      if (afterStop.running) {
        console.log(`Refusing restart: ${moon.shortname} still appears running after stop attempt.`);
        console.log('No force-kill performed (policy).');
        process.exitCode = 2;
        return;
      }

      console.log(`restart: starting ${moon.shortname}...`);
      const startRes = cmdStart(state, moon);
      if (!startRes.ok) {
        process.exitCode = startRes.code;
        return;
      }
      console.log(`restart ok: ${moon.shortname}`);
      return;
    }
  }

  if (cmd === 'swap') {
    const key = args[0];
    const workspace = args[1];
    if (!key || !workspace) return console.log('Usage: minato swap <moon> <workspace>');
    const moon = getMoon(state, key);
    if (!moon) return console.log('Moon not found.');
    moon.active_workspace = workspace;
    moon.updated_at = now();
    saveState(state);
    console.log(`swap ok: ${moon.shortname} -> ${workspace}`);
    return;
  }

  if (cmd === 'doctor') {
    const key = args[0];
    const targets = key ? [getMoon(state, key)].filter(Boolean) : state.moons;
    if (!targets.length) return console.log('No moons to check.');
    for (const moon of targets) {
      const problems = [];
      const runtime = detectRuntime(moon);
      if (moon.archived && runtime.running) problems.push('archived-but-running');
      if (!moon.shortname) problems.push('missing-shortname');
      const signalCount = [runtime.hasScreen, runtime.hasProc, runtime.hasPierSignal].filter(Boolean).length;
      if (signalCount === 1) problems.push('ambiguous-runtime-1of3');
      if (signalCount === 0 && moon.state === 'running') problems.push('metadata-running-but-runtime-dead');

      const status = problems.length ? problems.join(', ') : 'ok';
      console.log(`${moon.shortname}: ${status} [screen=${runtime.hasScreen} proc=${runtime.hasProc} pier=${runtime.hasPierSignal}]`);
    }
    return;
  }

  if (cmd === 'update') {
    console.log('update stub: will do mcp refresh + moon update flow');
    return;
  }

  if (cmd === 'sync') {
    const key = args[0];
    const all = key === '--all' || !key;
    const targets = all ? state.moons : [getMoon(state, key)].filter(Boolean);
    if (!targets.length) return console.log('No moons to sync.');
    for (const moon of targets) {
      const runtime = detectRuntime(moon);
      moon.state = runtime.running ? 'running' : 'stopped';
      if (runtime.running) moon.last_seen_running_at = now();
      moon.updated_at = now();
      console.log(`sync ${moon.shortname}: ${moon.state}`);
    }
    saveState(state);
    return;
  }

  if (cmd === 'dojo') {
    const key = args[0];
    const moon = getMoon(state, key);
    if (!moon) return console.log('Moon not found.');

    const runtime = detectRuntime(moon);
    if (!runtime.running) {
      console.log(`Cannot attach dojo: ${moon.shortname} does not appear to be running.`);
      process.exitCode = 2;
      return;
    }
    if (!runtime.hasScreen) {
      console.log(`Cannot attach dojo: runtime exists but no screen session found for ${moon.shortname}.`);
      console.log('Use minato inspect <moon> and attach manually if needed.');
      process.exitCode = 2;
      return;
    }

    const session = pickScreenSession(runtime, moon.shortname);
    if (!session) {
      console.log(`Cannot attach dojo: could not resolve screen session for ${moon.shortname}.`);
      process.exitCode = 2;
      return;
    }

    console.log(`Attaching to dojo for ${moon.shortname} via screen session '${session}'...`);
    console.log('Detach safely with Ctrl-a d');
    const attached = shInteractive(`screen -r '${shellEscapeSingle(session)}'`);
    if (!attached.ok) {
      console.log('Screen attach failed.');
      process.exitCode = attached.code || 1;
      return;
    }
    return;
  }

  usage();
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  await interactive();
} else {
  await run(argv);
}
