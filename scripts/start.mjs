import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await mkdir('.runtime/workspace', { recursive: true, mode: 0o700 });
const log = await open('.runtime/server.log', 'a', 0o600);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|DSH_/.test(key)));
env.DSH_HOME = root + '.runtime/home';
const initialize = existsSync(env.DSH_HOME + '/profiles/gea-proof/package.json') ? [] : ['--from-default-profile', 'web'];
const child = spawn(process.execPath, ['node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'gea-proof', ...initialize, '--patch', root + 'gea.patch.yml', '--host', '127.0.0.1', '--port', '3199', '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
await writeFile('.runtime/pid', String(child.pid));
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', async data => {
  await log.write(data);
  process.stdout.write(data.toString().replace(/(https?:\/\/[^\s]+)[?#][^\s]+/g, '$1?[redacted]'));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', async code => { await log.close(); process.exit(code ?? 1); });
