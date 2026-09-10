import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail } from './store.mjs';

export function environment(root) {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: path.join(root, 'qmd'),
    XDG_CONFIG_HOME: path.join(root, 'qmd/config'), XDG_CACHE_HOME: path.join(root, 'qmd/cache'),
    QMD_CONFIG_DIR: path.join(root, 'qmd/config/qmd'), LANG: 'C.UTF-8',
    RCLONE_CONFIG: path.join(root, 'sync/rclone.conf') };
}
export function native(root, executable, args, { inherit = false, env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: { ...environment(root), ...env }, stdio: inherit ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (!inherit && input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    let out = '', err = '', bytes = 0;
    const collect = (chunk, stderr) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) { child.kill('SIGTERM'); return; }
      if (stderr) err += chunk; else out += chunk;
    };
    child.stdout?.on('data', x => collect(x, false)); child.stderr?.on('data', x => collect(x, true));
    const terminate = () => child.kill('SIGTERM');
    const interrupt = () => child.kill('SIGINT');
    process.once('SIGTERM', terminate); process.once('SIGINT', interrupt);
    const cleanup = () => { process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', interrupt); };
    child.once('error', e => { cleanup(); reject(e); });
    child.once('close', code => {
      cleanup();
      if (bytes > 32 * 1024 * 1024) reject(Error('Native output exceeded 32 MiB'));
      else resolve({ code: code ?? 130, stdout: out, stderr: err });
    });
  });
}
export async function rclone(root, args, options) {
  return native(root, '/usr/local/bin/rclone', args, options);
}
export async function qmd(root, args) {
  const cli = fileURLToPath(new URL('./cli/qmd.js', import.meta.resolve('@tobilu/qmd')));
  return native(root, process.execPath, [cli, ...args]);
}
export function succeeded(result, label) {
  if (result.code !== 0) fail('UNAVAILABLE', `${label} exited ${result.code}: ${result.stderr.slice(-4000)}`);
  return result.stdout;
}
