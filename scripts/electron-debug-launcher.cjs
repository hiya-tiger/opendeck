const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const cwd = path.resolve(__dirname, '..');
const electron = path.join(cwd, 'node_modules', 'electron', 'dist', 'electron.exe');
const logFile = path.join(process.env.TEMP || '/tmp', 'opendecks-spawn.log');

const log = fs.createWriteStream(logFile, { flags: 'w' });

const child = spawn(electron, ['.'], {
  cwd,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
});

child.stdout.on('data', (d) => {
  const s = d.toString();
  log.write('[STDOUT] ' + s + '\n');
  console.log('[STDOUT]', s.trim());
});

child.stderr.on('data', (d) => {
  const s = d.toString();
  log.write('[STDERR] ' + s + '\n');
  console.error('[STDERR]', s.trim());
});

child.on('exit', (code) => {
  log.write(`[EXIT] code=${code}\n`);
  console.log('[EXIT] code=', code);
  log.end();
});

// Auto-kill after 8 seconds so this script doesn't hang
setTimeout(() => {
  if (!child.killed) {
    child.kill();
    log.write('[TIMEOUT] killed after 8s\n');
    console.log('[TIMEOUT] killed after 8s');
    log.end();
  }
}, 8000);
