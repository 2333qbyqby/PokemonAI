import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.env.POKEMONAI_WEB_ROOT || 'apps/showdown-client/play.pokemonshowdown.com');
const host = process.env.POKEMONAI_WEB_BIND || '127.0.0.1';
const port = Number(process.env.POKEMONAI_WEB_PORT || 8080);
const showdownPort = Number(process.env.POKEMONAI_SHOWDOWN_PORT || 8000);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (requestUrl.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end('{"status":"ok"}');
    return;
  }
  if (requestUrl.pathname === '/') {
    const hostname = requestUrl.hostname || '127.0.0.1';
    response.writeHead(302, { location: `/testclient-new.html?~~${hostname}:${showdownPort}` });
    response.end();
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(requestUrl.pathname);
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }
  const candidate = resolve(join(root, normalize(decoded).replace(/^[/\\]+/, '')));
  if (!candidate.startsWith(`${root}${sep}`) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': contentTypes[extname(candidate)] || 'application/octet-stream',
    // This server is for local development; rebuilds must be visible on reload.
    'cache-control': 'no-cache',
  });
  createReadStream(candidate).pipe(response);
});

server.listen(port, host, () => {
  console.log(`PokemonAI client available at http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
