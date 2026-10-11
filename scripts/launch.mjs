// Starts server.mjs and starts it again when it exits with code 75 ("Relaunch to update" in the interface).
// The access token is generated here and handed to every run, so the browser tab reconnects to the new server by itself.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.CLAUDE_WEB_UI_TOKEN || randomBytes(16).toString('hex');
let first = true;

function run() {
  const env = { ...process.env, CLAUDE_WEB_UI_TOKEN: token, CLAUDE_WEB_UI_SUPERVISED: '1' };
  if (!first) env.NO_OPEN = '1';   // the tab that asked for the update is still open
  first = false;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
  child.on('exit', (code, signal) => {
    if (code === 75) return run();
    process.exit(signal ? 0 : (code ?? 0));
  });
}
process.on('SIGINT', () => {});   // Ctrl+C reaches the server directly; we leave when it does
process.on('SIGTERM', () => {});
run();
