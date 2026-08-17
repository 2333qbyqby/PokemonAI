import {closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join} from 'node:path';

const [configPath, pidRoot, logRoot] = process.argv.slice(2);
if (!configPath || !pidRoot || !logRoot) {
  throw new Error('Usage: supervisor.mjs CONFIG PID_ROOT LOG_ROOT');
}

mkdirSync(pidRoot, {recursive: true});
mkdirSync(logRoot, {recursive: true});
const services = JSON.parse(readFileSync(configPath, 'utf8'));
let stopping = false;

function readPid(name) {
  const path = join(pidRoot, `${name}.pid`);
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, 'utf8'));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startService(service) {
  const stdout = openSync(join(logRoot, `${service.name}.stdout.log`), 'a');
  const stderr = openSync(join(logRoot, `${service.name}.stderr.log`), 'a');
  const child = spawn(service.filePath, service.arguments, {
    cwd: service.workingDirectory,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
    env: process.env,
  });
  closeSync(stdout);
  closeSync(stderr);
  writeFileSync(join(pidRoot, `${service.name}.pid`), String(child.pid));
  console.log(`${new Date().toISOString()} restarted ${service.name} as PID ${child.pid}`);
}

function checkServices() {
  if (stopping) return;
  for (const service of services) {
    const pid = readPid(service.name);
    if (!isAlive(pid)) startService(service);
  }
}

const timer = setInterval(checkServices, 1000);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(timer);
    process.exit(0);
  });
}
console.log(`Monitoring ${services.map(service => service.name).join(', ')}`);
