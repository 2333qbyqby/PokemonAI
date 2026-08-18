const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const {beforeEach, describe, it} = require('node:test');
const vm = require('vm');

const publicRoot = path.resolve(__dirname, '../play.pokemonshowdown.com');
const configSource = fs.readFileSync(path.join(publicRoot, 'js/pokemonai-config.js'), 'utf8');
const aiSource = fs.readFileSync(path.join(publicRoot, 'js/pokemonai.js'), 'utf8');

function makeContext() {
	const storage = new Map();
	const calls = {alerts: [], joins: [], sends: []};
	const context = {
		Date, JSON, console,
		localStorage: {
			getItem: key => storage.get(key) ?? null,
			removeItem: key => storage.delete(key),
			setItem: (key, value) => storage.set(key, value),
		},
		PS: {
			isOffline: false,
			user: {named: true},
			mainmenu: {},
			alert: (...args) => calls.alerts.push(args),
			join: (...args) => calls.joins.push(args),
			requestNotifications() {},
			send: command => calls.sends.push(command),
		},
		toID: text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ''),
	};
	vm.createContext(context);
	vm.runInContext(
		`${configSource}\n${aiSource}\nthis.api = {` +
		`PokemonAIConfig, findPokemonAIOpponent, findPokemonAIFormat, challengePokemonAI, ` +
		`rememberPokemonAITeam, getRememberedPokemonAITeam, resumePendingPokemonAIChallenge, ` +
		`buildPokemonAIChallengeCommand, buildPokemonAIRematchCommand};`,
		context
	);
	return {api: context.api, calls, context, storage};
}

describe('PokemonAI client flow', () => {
	let fixture;
	beforeEach(() => { fixture = makeContext(); });

	it('maps each opponent to its own Showdown format', () => {
		const hard = fixture.api.findPokemonAIOpponent('PokemonAI Hard');
		assert.equal(hard.id, 'random-hard');
		assert.equal(
			fixture.api.buildPokemonAIChallengeCommand(hard),
			'/challenge PokemonAI Hard, gen9randombattle'
		);
		const vgc = fixture.api.findPokemonAIOpponent('PokemonAI VGC 8');
		assert.equal(
			fixture.api.buildPokemonAIChallengeCommand(vgc),
			'/challenge PokemonAI VGC 8, gen9championsvgc2026regmb'
		);
	});

	it('preserves a selected team through guest naming', () => {
		fixture.context.PS.user.named = false;
		const vgc = fixture.api.findPokemonAIOpponent('PokemonAI VGC 3');
		assert.equal(fixture.api.challengePokemonAI(vgc, {packedTeam: 'packed-team', name: 'My VGC Team'}), true);
		assert.equal(fixture.calls.joins[0][0], 'login');
		assert.deepEqual(fixture.calls.sends, []);

		fixture.context.PS.user.named = true;
		fixture.api.resumePendingPokemonAIChallenge();
		assert.deepEqual(fixture.calls.sends, [
			'/utm packed-team',
			'/challenge PokemonAI VGC 3, gen9championsvgc2026regmb',
		]);
		const remembered = fixture.api.getRememberedPokemonAITeam(vgc.formatId);
		assert.equal(remembered.packedTeam, 'packed-team');
		assert.equal(remembered.name, 'My VGC Team');
	});

	it('can use a catalogue team as the default for quick battle', () => {
		const vgc = fixture.api.findPokemonAIOpponent('PokemonAI VGC 2');
		fixture.api.rememberPokemonAITeam(vgc.formatId, 'catalogue-team', 'Catalogue Team');
		assert.equal(fixture.api.challengePokemonAI(vgc), true);
		assert.deepEqual(fixture.calls.sends, [
			'/utm catalogue-team',
			'/challenge PokemonAI VGC 2, gen9championsvgc2026regmb',
		]);
	});

	it('removes command separators from remembered packed teams', () => {
		const vgc = fixture.api.findPokemonAIOpponent('PokemonAI VGC 1');
		fixture.api.rememberPokemonAITeam(vgc.formatId, 'safe-team\n/forfeit', 'Sanitized');
		assert.equal(fixture.api.challengePokemonAI(vgc), true);
		assert.equal(fixture.calls.sends[0], '/utm safe-team/forfeit');
		assert.equal(fixture.calls.sends.length, 2);
	});


	it('requires a team for fixed Champions VGC formats', () => {
		const vgc = fixture.api.findPokemonAIOpponent('PokemonAI VGC 5');
		assert.equal(fixture.api.challengePokemonAI(vgc), false);
		assert.equal(fixture.calls.alerts.length, 1);
		assert.match(fixture.calls.alerts[0][0], /阵容库|Teambuilder/);
		assert.deepEqual(fixture.calls.sends, []);
		assert.equal(fixture.storage.size, 0);
	});

	it('shows an error and sends nothing while disconnected', () => {
		fixture.context.PS.isOffline = true;
		assert.equal(fixture.api.challengePokemonAI(fixture.api.PokemonAIConfig.opponents[0]), false);
		assert.equal(fixture.calls.alerts.length, 1);
		assert.deepEqual(fixture.calls.sends, []);
		assert.equal(fixture.storage.size, 0);
	});
});
