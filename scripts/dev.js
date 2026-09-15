// 一键本地启动：后端 API(5102) + 前端 Vite(5101，代理 /api)。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const procs = [];
let shuttingDown = false;

function run(name, cmd, args) {
  const p = spawn(cmd, args, { cwd: root, stdio: 'inherit' });
  p.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`[${name}] 已退出 (code ${code})，正在停止其余进程…`);
      shutdown(code ?? 0);
    }
  });
  procs.push(p);
}

function shutdown(code) {
  shuttingDown = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', process.execPath, [path.join(root, 'server', 'index.js')]);
run('web', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '0.0.0.0', '--port', '5101']);

console.log('消毒与校准追踪台启动中…');
console.log('  前端: http://localhost:5101');
console.log('  API : http://localhost:5102/api/health');
