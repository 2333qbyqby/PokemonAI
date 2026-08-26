const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const {describe, it} = require('node:test');
const vm = require('vm');

const publicRoot = path.resolve(__dirname, '../play.pokemonshowdown.com');
const appSource = fs.readFileSync(path.join(publicRoot, 'js/pokemonai-app.js'), 'utf8');

function makeContext(search = '', initialStorage = {}) {
	const storage = new Map(Object.entries(initialStorage));
	const assigned = [];
	const logs = [];
	const testConsole = {};
	for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
		testConsole[method] = (...args) => logs.push([method, ...args]);
	}
	const context = {
		console: testConsole,
		CustomEvent: class CustomEvent {
			constructor(type, init) { this.type = type; this.detail = init?.detail; }
		},
		URL,
		URLSearchParams,
		document: {documentElement: {dataset: {}, lang: ''}},
		localStorage: {
			getItem: key => storage.get(key) ?? null,
			removeItem: key => storage.delete(key),
			setItem: (key, value) => storage.set(key, String(value)),
		},
		location: {
			assign: url => assigned.push(url),
			hostname: 'pokemonai.example',
			href: `https://pokemonai.example/${search}`,
			protocol: 'https:',
			search,
		},
	};
	context.window = context;
	context.dispatchEvent = () => {};
	vm.createContext(context);
	vm.runInContext(`${appSource}\nthis.api = {PokemonAIApp, Config};`, context);
	return {api: context.api, assigned, context, logs, storage};
}

describe('PokemonAI application mode bootstrap', () => {
	it('defaults invalid modes to AI and remembers the locale', () => {
		const fixture = makeContext('?mode=unsupported');
		assert.equal(fixture.api.PokemonAIApp.mode, 'ai');
		assert.equal(fixture.api.Config.pokemonai, true);
		assert.equal(fixture.context.document.documentElement.dataset.appMode, 'ai');
		assert.equal(fixture.storage.get('pokemonai-locale'), 'zh-CN');
	});

	it('restores the stored mode and lets an explicit query override it', () => {
		assert.equal(makeContext('', {'pokemonai-app-mode': 'online'}).api.PokemonAIApp.mode, 'online');
		assert.equal(
			makeContext('?mode=ai', {'pokemonai-app-mode': 'online'}).api.PokemonAIApp.mode,
			'ai'
		);
	});

	it('uses the self-hosted server for AI and official WebSocket host for online', () => {
		const ai = makeContext('?mode=ai&server=127.0.0.1%3A8123').api;
		assert.equal(ai.Config.defaultserver.host, '127.0.0.1');
		assert.equal(ai.Config.defaultserver.port, 8123);
		const online = makeContext('?mode=online').api;
		assert.equal(online.Config.defaultserver.host, 'sim3.psim.us');
		assert.equal(online.Config.defaultserver.port, 443);
		assert.equal(online.PokemonAIApp.profile.allowedFormats[0], 'gen9randombattle');
	});

	it('allocates numbered local trainer names and localizes their display labels', () => {
		const app = makeContext('?mode=ai').api.PokemonAIApp;
		assert.equal(app.localTrainerName(), 'Local Player 1');
		assert.equal(app.displayTrainerName(app.localTrainerName()), '本地玩家1');
		assert.equal(app.nextLocalTrainerName(), 'Local Player 2');
		assert.equal(app.isLocalTrainerName('Local Player 2'), true);
		assert.equal(app.isLocalTrainerName('Official User'), false);
	});

	it('stores, reads, and clears SID only through the dedicated local key', () => {
		const fixture = makeContext('?mode=online');
		assert.equal(fixture.api.PokemonAIApp.saveOfficialSid('  secret-sid  '), true);
		assert.equal(fixture.api.PokemonAIApp.getOfficialSid(), 'secret-sid');
		assert.equal(fixture.storage.get('pokemonai-official-sid'), 'secret-sid');
		fixture.api.PokemonAIApp.clearOfficialSid();
		assert.equal(fixture.api.PokemonAIApp.hasOfficialSid(), false);
	});

	it('redacts SID, assertion, challstr, and /trn credentials', () => {
		const fixture = makeContext('?mode=online');
		const app = fixture.api.PokemonAIApp;
		const redacted = app.redactSensitive(
			'sid=abc assertion:xyz challstr=1|two /trn User,0,private-assertion'
		);
		assert.doesNotMatch(redacted, /abc|xyz|two|private-assertion/);
		assert.match(redacted, /\[REDACTED\]/);
		fixture.context.console.error({sid: 'nested-secret'}, 'assertion=console-secret');
		assert.equal(fixture.logs[0][1].sid, '[REDACTED]');
		assert.doesNotMatch(fixture.logs[0][2], /console-secret/);
	});

	it('builds a clean mode URL and removes the local server in online mode', () => {
		const fixture = makeContext('?mode=ai&server=127.0.0.1%3A8000');
		fixture.api.PokemonAIApp.navigateToMode('online');
		const url = new URL(fixture.assigned[0]);
		assert.equal(url.pathname, '/');
		assert.equal(url.searchParams.get('mode'), 'online');
		assert.equal(url.searchParams.has('server'), false);
	});
});
