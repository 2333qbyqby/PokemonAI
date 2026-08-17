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
		Date,
		console,
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
		`PokemonAIConfig, findPokemonAIOpponent, challengePokemonAI, ` +
		`resumePendingPokemonAIChallenge, buildPokemonAIChallengeCommand, buildPokemonAIRematchCommand};`,
		context
	);
	return {api: context.api, calls, context, storage};
}

describe('PokemonAI client flow', () => {
	let fixture;
	beforeEach(() => { fixture = makeContext(); });

	it('maps generated config and builds native Showdown commands', () => {
		const hard = fixture.api.findPokemonAIOpponent('PokemonAI Hard');
		assert.equal(hard.id, 'hard');
		assert.equal(
			fixture.api.buildPokemonAIChallengeCommand(hard),
			'/challenge PokemonAI Hard, gen9randombattle'
		);
		assert.equal(
			fixture.api.buildPokemonAIRematchCommand(hard),
			'/closeand /challenge PokemonAI Hard, gen9randombattle'
		);
	});

	it('opens the guest nickname flow and resumes the pending challenge', () => {
		fixture.context.PS.user.named = false;
		fixture.api.challengePokemonAI(fixture.api.PokemonAIConfig.opponents[0]);
		assert.equal(fixture.calls.joins[0][0], 'login');
		assert.deepEqual(fixture.calls.sends, []);

		fixture.context.PS.user.named = true;
		fixture.api.resumePendingPokemonAIChallenge();
		assert.deepEqual(fixture.calls.sends, [
			'/utm ',
			'/challenge PokemonAI Easy, gen9randombattle',
		]);
		assert.equal(fixture.storage.size, 0);
	});

	it('shows an error and sends nothing while disconnected', () => {
		fixture.context.PS.isOffline = true;
		fixture.api.challengePokemonAI(fixture.api.PokemonAIConfig.opponents[3]);
		assert.equal(fixture.calls.alerts.length, 1);
		assert.deepEqual(fixture.calls.sends, []);
		assert.equal(fixture.storage.size, 0);
	});
});
