'use strict';
// Keep the unauthenticated provider on loopback and stop both services together.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const children = new Set();
let stopping = false;
let exitCode = 0;
let app;
function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  const deadline = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(exitCode);
  }, 5000);
  deadline.unref();
  if (!children.size) process.exit(exitCode);
}
function launch(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
  children.add(child);
  child.on('error', (err) => { console.error(err); stop(1); });
  child.on('exit', (code) => {
    children.delete(child);
    if (!stopping) stop(code || 1);
    else if (!children.size) process.exit(exitCode);
  });
  return child;
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
launch(['build/main.js', '--host', '127.0.0.1', '--port', '4416'], '/opt/bgutil/server');
const deadline = Date.now() + 30000;
function waitReady() {
  if (stopping) return;
  const socket = net.createConnection({ host: '127.0.0.1', port: 4416 });
  socket.setTimeout(1000, () => socket.destroy(new Error('timeout')));
  socket.once('connect', () => {
    socket.destroy();
    if (!stopping && !app) app = launch(['server.js'], path.resolve(__dirname, '..'));
  });
  socket.once('error', () => {
    if (Date.now() >= deadline) { console.error('Token provider failed to start'); stop(1); }
    else setTimeout(waitReady, 200);
  });
}
waitReady();
