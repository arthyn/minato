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

function findCandidatePiers(shortname) {
  if (!fs.existsSync(MOONS_DIR)) return [];
  return fs.readdirSync(MOONS_DIR)
    .filter(d => d.includes(shortname))
    .map(d => path.join(MOONS_DIR, d));
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
    const runtime = detectRuntime(moon);

    if (cmd === 'start') {
      if (runtime.running) {
        console.log(`Refusing start: ${moon.shortname} already appears running (2/3 checks).`);
        process.exitCode = 2;
        return;
      }
      if (runtime.hasScreen || runtime.hasProc || runtime.hasPierSignal) {
        console.log(`Ambiguous runtime signals for ${moon.shortname}; refusing risky start.`);
        console.log('Run: minato inspect <moon> and resolve manually first.');
        process.exitCode = 2;
        return;
      }
      moon.state = 'booting';
      moon.updated_at = now();
      saveState(state);
      console.log(`Start preflight ok for ${moon.shortname}.`);
      console.log('Runtime boot hook not wired yet (will start via managed screen in next step).');
      return;
    }

    if (cmd === 'stop') {
      if (!runtime.running) {
        moon.state = 'stopped';
        moon.updated_at = now();
        saveState(state);
        console.log(`Marked stopped: ${moon.shortname} (no live runtime detected).`);
        return;
      }
      console.log(`Refusing automatic stop for ${moon.shortname} (safety rule).`);
      console.log('Use manual dojo/screen shutdown, then run: minato sync <moon>');
      process.exitCode = 2;
      return;
    }

    if (cmd === 'restart') {
      if (runtime.running) {
        console.log(`Refusing automatic restart for ${moon.shortname} (no auto-kill policy).`);
        console.log('Manually stop first, then run: minato start <moon>');
        process.exitCode = 2;
        return;
      }
      moon.state = 'booting';
      moon.last_booted_at = now();
      moon.updated_at = now();
      saveState(state);
      console.log(`Restart preflight ok for ${moon.shortname}.`);
      console.log('Runtime boot hook not wired yet (next step).');
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
    console.log(`dojo stub for ${moon.shortname}: will attach to screen safely.`);
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
