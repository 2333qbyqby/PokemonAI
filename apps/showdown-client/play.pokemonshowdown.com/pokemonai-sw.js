const CACHE_NAME = 'pokemonai-shell';
const SHELL = [
	'/testclient-new.html',
	'/manifest.webmanifest',
	'/style/pokemonai.css',
	'/favicon-32.png',
	'/favicon-256.png',
	'/data/pokemonai-teams.json',
];

self.addEventListener('install', event => {
	event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).catch(() => undefined));
	self.skipWaiting();
});

self.addEventListener('activate', event => {
	event.waitUntil(caches.keys().then(keys => Promise.all(
		keys.filter(key => key.startsWith('pokemonai-shell-') && key !== CACHE_NAME).map(key => caches.delete(key))
	)));
	self.clients.claim();
});

self.addEventListener('fetch', event => {
	const url = new URL(event.request.url);
	if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/showdown/')) return;
	if (url.pathname.endsWith('.js') || url.pathname.endsWith('.json') || url.pathname.endsWith('.html')) {
		event.respondWith(fetch(event.request).then(response => {
			const copy = response.clone();
			caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
			return response;
		}).catch(() => caches.match(event.request)));
		return;
	}
	event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
