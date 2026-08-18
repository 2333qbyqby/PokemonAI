import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer, get as httpGet} from 'node:http';
import {once} from 'node:events';
import {resolve} from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

async function waitFor(url, child) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`web server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw lastError || new Error('web server did not become ready');
}

function rawRequest(port, path) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpGet({host: '127.0.0.1', port, path}, response => {
      response.resume();
      response.on('end', () => resolveRequest(response));
    });
    request.on('error', rejectRequest);
  });
}

test('local web server serves the PWA without escaping its root', async t => {
  const port = await freePort();
  const child = spawn(process.execPath, ['services/web-server/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      POKEMONAI_WEB_BIND: '127.0.0.1',
      POKEMONAI_WEB_PORT: String(port),
      POKEMONAI_SHOWDOWN_PORT: '19000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  const health = await waitFor(`http://127.0.0.1:${port}/healthz`, child);
  assert.deepEqual(await health.json(), {status: 'ok'});

  const root = await fetch(`http://127.0.0.1:${port}/`, {redirect: 'manual'});
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/testclient-new.html?mode=ai&server=127.0.0.1%3A19000');

  const onlineRoot = await fetch(`http://127.0.0.1:${port}/?mode=online`, {redirect: 'manual'});
  assert.equal(onlineRoot.status, 302);
  assert.equal(onlineRoot.headers.get('location'), '/testclient-new.html?mode=online');

  const manifest = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type') || '', /application\/manifest\+json/);
  assert.equal((await manifest.json()).short_name, 'PokémonAI');

  const traversal = await rawRequest(port, '/..%2f..%2fREADME.md');
  assert.equal(traversal.statusCode, 404);

  const malformed = await rawRequest(port, '/%zz');
  assert.equal(malformed.statusCode, 400);

  const stillHealthy = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(stillHealthy.status, 200);
});
