import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.env.POKEMONAI_WEB_ROOT || 'apps/showdown-client/play.pokemonshowdown.com');
const host = process.env.POKEMONAI_WEB_BIND || '127.0.0.1';
const port = Number(process.env.POKEMONAI_WEB_PORT || 8080);
const showdownPort = Number(process.env.POKEMONAI_SHOWDOWN_PORT || 8000);
const securityHeaders = {
  'content-security-policy': "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https://play.pokemonshowdown.com wss://sim3.psim.us; img-src 'self' data: http://play.pokemonshowdown.com http://*.psim.us https://play.pokemonshowdown.com https://*.psim.us https://pokemonshowdown.com; media-src 'self' http://play.pokemonshowdown.com https://play.pokemonshowdown.com; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

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
    const hostname = (request.headers.host || '127.0.0.1').replace(/:\d+$/, '');
    const mode = requestUrl.searchParams.get('mode') === 'online' ? 'online' : 'ai';
    const query = new URLSearchParams({ mode });
    if (mode === 'ai') query.set('server', `${hostname}:${showdownPort}`);
    response.writeHead(302, { location: `/testclient-new.html?${query}` });
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
    ...securityHeaders,
  });
  createReadStream(candidate).pipe(response);
});

server.listen(port, host, () => {
  console.log(`PokemonAI client available at http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
