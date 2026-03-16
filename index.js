'use strict';

const { spawnSync, spawn } = require('child_process');
const fs   = require('fs');
const fsp  = fs.promises;
const path = require('path');
const https = require('https');
const os   = require('os');

// ═══════════════════════════════════════════════════════
//  CONFIGURATION  — edit these values to customise
// ═══════════════════════════════════════════════════════
const CONFIG = {
  SESSION_ID:           'tct_2d35677f',
  REPO_URL:             'https://github.com/kogo198/kiplaa.git',
  TMP_REPO_DIR:         'tct_tmp_clone',
  BINARY_NAME:          'tct-linux',
  BINARY_DOWNLOAD_URL:  'https://github.com/i-tct/tct/releases/latest/download/tct-linux',
  MAX_RESTART_BACKOFF:  10_000,   // ms — max wait between restarts
  MAX_RESTART_EXPONENT: 4,        // 2^4 × 1000 = 16 s cap before MAX_RESTART_BACKOFF kicks in
  SHUTDOWN_GRACE_MS:    10_000,   // ms — wait for child before SIGKILL
  HEALTH_INTERVAL_MS:   60_000,   // ms — how often to log memory/cpu info
};

// ─── Default env values (override in .env) ───────────────
const REQUIRED_ENV = {
  DB_BATCH_SIZE:            '600',       // ⚡ high-throughput batch writes
  DB_FLUSH_INTERVAL:        '2000',      // ⚡ flush every 2 s (was 5 s)
  DB_CACHE_MAX_BYTES:       '268435456', // ⚡ 256 MB RAM cache
  DB_BUSY_TIMEOUT_MS:       '8000',      // ⚡ fast fail on DB lock
  PREFIX:                   '.',
  TIMEZONE:                 'Africa/Nairobi',
  SESSION_ID:               CONFIG.SESSION_ID,
  FILTER_NOISE_LOGS:        'true',
  DISABLE_SESSION_DOWNLOAD: 'false',
};

// ═══════════════════════════════════════════════════════
//  LOGGER  — coloured, timestamped, emoji-tagged
// ═══════════════════════════════════════════════════════
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
};

const log = {
  _ts() { return `${C.dim}${new Date().toISOString()}${C.reset}`; },
  info (tag, msg) { console.log (`${this._ts()} ${C.cyan}[${tag}]${C.reset} ${msg}`); },
  ok   (tag, msg) { console.log (`${this._ts()} ${C.green}✔ [${tag}]${C.reset} ${C.green}${msg}${C.reset}`); },
  warn (tag, msg) { console.warn(`${this._ts()} ${C.yellow}⚠ [${tag}]${C.reset} ${msg}`); },
  error(tag, msg) { console.error(`${this._ts()} ${C.red}✖ [${tag}]${C.reset} ${C.red}${msg}${C.reset}`); },
  step (msg)      { console.log (`\n${C.magenta}${C.bold}▶  ${msg}${C.reset}`); },

  banner() {
    console.log(`
${C.cyan}${C.bold}┌──────────────────────────────────────────┐
│                                          │
│       Kiplaa WhatsApp Bot Launcher       │
│             v2.0  ⚡ Modern              │
│                                          │
└──────────────────────────────────────────┘${C.reset}
`);
  },
};

// ═══════════════════════════════════════════════════════
//  SYSTEM  INFO
// ═══════════════════════════════════════════════════════
function sysInfo() {
  const mem = process.memoryUsage();
  return (
    `RSS: ${Math.round(mem.rss / 1024 / 1024)} MB  ` +
    `| HeapUsed: ${Math.round(mem.heapUsed / 1024 / 1024)} MB  ` +
    `| SysFree: ${Math.round(os.freemem() / 1024 / 1024)} MB  ` +
    `| CPUs: ${os.cpus().length}`
  );
}

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════
function safeSpawnSync(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', ...opts });
}

// Download file with redirect-following + live progress dots
function downloadFile(url, dest, depth = 0) {
  if (depth > 10) return Promise.reject(new Error('Too many redirects'));

  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {

      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest, depth + 1)
          .then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }

      const file = fs.createWriteStream(dest);
      let bytes = 0;

      // Show progress dots every 500 ms
      const tick = setInterval(() => process.stdout.write(`${C.cyan}.${C.reset}`), 500);

      res.on('data', chunk => { bytes += chunk.length; });
      res.pipe(file);

      file.on('finish', () => {
        clearInterval(tick);
        process.stdout.write('\n');
        file.close();
        resolve(bytes);
      });

      file.on('error', err => {
        clearInterval(tick);
        fs.unlink(dest, () => {});
        reject(err);
      });
    });

    req.on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ═══════════════════════════════════════════════════════
//  REPO  CLONE  (shallow, single-branch — fastest)
// ═══════════════════════════════════════════════════════
function cloneRepo() {
  if (fs.existsSync(CONFIG.TMP_REPO_DIR)) {
    try { safeSpawnSync('rm', ['-rf', CONFIG.TMP_REPO_DIR]); } catch (_) {}
  }

  log.step('Cloning repository (shallow + single-branch)…');

  const res = safeSpawnSync('git', [
    'clone', '--depth', '1', '--single-branch',
    CONFIG.REPO_URL, CONFIG.TMP_REPO_DIR,
  ]);

  if (res.error || res.status !== 0) {
    log.error('Git', 'Clone failed — check your internet connection.');
    process.exit(1);
  }

  log.ok('Git', 'Repository cloned successfully.');
}

// ═══════════════════════════════════════════════════════
//  RECURSIVE COPY  (parallel with Promise.all — faster)
// ═══════════════════════════════════════════════════════
async function copyRecursive(src, dest, opts = {}) {
  const skipNames    = opts.skipNames    || new Set();
  const ignoreErrors = opts.ignoreErrors ?? true;

  const entries = await fsp.readdir(src, { withFileTypes: true });
  await fsp.mkdir(dest, { recursive: true });

  // Run all copies IN PARALLEL for speed
  await Promise.all(entries.map(async (e) => {
    if (skipNames.has(e.name)) return;

    const srcPath  = path.join(src, e.name);
    const destPath = path.join(dest, e.name);

    try {
      if (e.isDirectory()) {
        await copyRecursive(srcPath, destPath, opts);
      } else if (e.isSymbolicLink()) {
        const target = await fsp.readlink(srcPath);
        try { await fsp.unlink(destPath); } catch (_) {}
        await fsp.symlink(target, destPath);
      } else {
        await fsp.copyFile(srcPath, destPath);
      }
    } catch (err) {
      if (!ignoreErrors) throw err;
    }
  }));
}

async function copyRepoToRoot() {
  log.step('Copying repository contents into working directory…');

  const skip = new Set([
    '.git', 'index.js', 'package.json', 'package-lock.json', 'yarn.lock',
  ]);

  await fsp.stat(CONFIG.TMP_REPO_DIR); // throws if missing
  await copyRecursive(CONFIG.TMP_REPO_DIR, '.', { skipNames: skip, ignoreErrors: true });

  try { safeSpawnSync('rm', ['-rf', CONFIG.TMP_REPO_DIR]); } catch (_) {}
  log.ok('Copy', 'Files copied and temp folder cleaned up.');
}

// ═══════════════════════════════════════════════════════
//  ENV  MANAGEMENT
// ═══════════════════════════════════════════════════════
function parseEnv(content) {
  return Object.fromEntries(
    content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => {
        const idx = l.indexOf('=');
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
      })
  );
}

function writeEnv(env) {
  const lines = [
    '# ──────────────────────────────────────────────',
    '# .env  —  managed automatically by TCT launcher',
    '# ──────────────────────────────────────────────',
    '',
  ];
  for (const [k, v] of Object.entries(env)) lines.push(`${k}=${v}`);
  fs.writeFileSync('.env', lines.join('\n') + '\n');
}

function ensureEnvFile() {
  log.step('Syncing .env configuration…');
  let existing = {};

  if (fs.existsSync('.env')) {
    existing = parseEnv(fs.readFileSync('.env', 'utf8'));
    log.info('Env', 'Existing .env found — merging with performance defaults.');
  } else {
    log.info('Env', 'No .env found — creating one from defaults.');
  }

  // REQUIRED_ENV always overrides to enforce performance settings
  writeEnv({ ...existing, ...REQUIRED_ENV });
  log.ok('Env', '.env synced and ready.');
}

// ═══════════════════════════════════════════════════════
//  PERMISSIONS
// ═══════════════════════════════════════════════════════
function makeExecutable(absPath) {
  try {
    fs.chmodSync(absPath, 0o755);
    log.ok('Permissions', `chmod 755 applied to ${path.basename(absPath)}`);
    return true;
  } catch (e) {
    log.warn('Permissions', `Could not set executable bit: ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════
//  HEALTH  MONITOR  — logs RAM/CPU every minute
// ═══════════════════════════════════════════════════════
function startHealthMonitor() {
  setInterval(() => {
    log.info('Health', sysInfo());
  }, CONFIG.HEALTH_INTERVAL_MS).unref(); // unref so it doesn't prevent clean exit
}

// ═══════════════════════════════════════════════════════
//  SUPERVISOR  — launches binary, auto-restarts on crash
// ═══════════════════════════════════════════════════════
function startBinarySupervisor() {
  const absBin = path.resolve('./', CONFIG.BINARY_NAME);

  if (!fs.existsSync(absBin)) {
    log.error('Launcher', `Binary not found at: ${absBin}`);
    process.exit(1);
  }

  makeExecutable(absBin);

  const env = {
    ...process.env,
    DISABLE_SESSION_DOWNLOAD: 'false',
    FORCE_COLOR: '1',
  };

  let child        = null;
  let restartCount = 0;
  let stopping     = false;
  let restartTimer = null;

  // Exponential backoff with random jitter to avoid thundering-herd
  function getBackoff() {
    const base   = 1000 * Math.pow(2, Math.min(restartCount, CONFIG.MAX_RESTART_EXPONENT));
    const jitter = Math.floor(Math.random() * 300);
    return Math.min(base, CONFIG.MAX_RESTART_BACKOFF) + jitter;
  }

  function spawnChild() {
    log.step(`Launching ${C.bold}${CONFIG.BINARY_NAME}${C.reset}${C.magenta} (run #${restartCount + 1})${C.reset}`);
    log.info('System', sysInfo());

    child = spawn(absBin, [], { env, stdio: 'inherit' });

    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;

      restartCount++;
      const wait = getBackoff();
      log.warn('Launcher', `Process exited (code=${code}, signal=${signal}) — restarting in ${wait} ms…`);
      restartTimer = setTimeout(spawnChild, wait);
    });

    child.on('error', (err) => {
      log.error('Launcher', `Spawn error: ${err.message}`);
      child = null;
      if (!stopping) {
        restartCount++;
        const wait = getBackoff();
        restartTimer = setTimeout(spawnChild, wait);
      }
    });
  }

  function shutdown(signal) {
    if (stopping) return;
    stopping = true;

    log.warn('Launcher', `Signal ${signal} received — shutting down gracefully…`);
    if (restartTimer) clearTimeout(restartTimer);

    if (child) {
      child.kill(signal);
      // Force-kill after grace period
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        log.warn('Launcher', 'Force-killed child. Exiting.');
        process.exit(0);
      }, CONFIG.SHUTDOWN_GRACE_MS);
    } else {
      process.exit(0);
    }
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  startHealthMonitor();
  spawnChild();
}

// ═══════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════
(async function main() {

  log.banner();
  log.info('System', sysInfo());
  log.info('Node',   `v${process.versions.node}  |  PID: ${process.pid}`);

  try {

    if (fs.existsSync(CONFIG.BINARY_NAME)) {
      log.ok('Init', `Binary "${CONFIG.BINARY_NAME}" already present — skipping clone & download.`);
    } else {

      cloneRepo();
      await copyRepoToRoot();

      log.step(`Downloading binary: ${CONFIG.BINARY_NAME}`);
      process.stdout.write('  ');

      const bytes = await downloadFile(CONFIG.BINARY_DOWNLOAD_URL, CONFIG.BINARY_NAME);
      log.ok('Download', `Complete — ${(bytes / 1024).toFixed(1)} KB received.`);

      makeExecutable(path.resolve('./', CONFIG.BINARY_NAME));
    }

    ensureEnvFile();
    startBinarySupervisor();

  } catch (err) {
    log.error('Fatal', err.stack || err.message || String(err));
    process.exit(1);
  }

})();
