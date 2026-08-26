const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const {beforeEach, describe, it} = require('node:test');
const vm = require('vm');

const publicRoot = path.resolve(__dirname, '../play.pokemonshowdown.com');
const configSource = fs.readFileSync(path.join(publicRoot, 'js/pokemonai-config.js'), 'utf8');
const localTeamsSource = fs.readFileSync(path.join(publicRoot, 'js/pokemonai/teams.js'), 'utf8');
const aiSource = fs.readFileSync(path.join(publicRoot, 'js/pokemonai.js'), 'utf8');
const mainMenuSource = fs.readFileSync(path.join(publicRoot, 'src/panel-mainmenu.tsx'), 'utf8');
const workspaceSource = fs.readFileSync(path.join(publicRoot, 'src/panel-pokemonai-teams.tsx'), 'utf8');
const carouselSource = fs.readFileSync(path.join(publicRoot, 'src/pokemonai/team-carousel.tsx'), 'utf8');

function unpackLine(line) {
	const pipe = line.indexOf('|');
	if (pipe < 0) return null;
	const bracket = line.indexOf(']');
	let formatPart = bracket >= 0 ? line.slice(0, bracket) : 'gen9';
	const teamidMatch = /^(\d+)\[/.exec(formatPart);
	if (teamidMatch) formatPart = formatPart.slice(teamidMatch[0].length);
	const isBox = formatPart.endsWith('-box');
	const format = isBox ? formatPart.slice(0, -4) : formatPart;
	const left = bracket >= 0 ? bracket + 1 : 0;
	const slash = line.lastIndexOf('/', pipe);
	return {
		name: line.slice(slash >= left ? slash + 1 : left, pipe),
		format,
		folder: slash >= left ? line.slice(left, slash) : '',
		packedTeam: line.slice(pipe + 1),
		iconCache: null,
		key: '',
		isBox,
		teamid: teamidMatch ? Number(teamidMatch[1]) : undefined,
	};
}

function makeContext(initialStorage = {}) {
	const storage = new Map(Object.entries(initialStorage));
	const calls = {alerts: [], joins: [], sends: [], fetches: [], names: []};
	let uuid = 0;
	const teams = {
		list: [], byKey: {}, deletedTeams: [],
		teambuilderFormat: format => String(format).split('@@@')[0],
		unpackLine,
		update() {},
		save() {},
	};
	const context = {
		Date, JSON, console, URLSearchParams, Uint32Array,
		innerHeight: 844,
		innerWidth: 390,
		crypto: {
			randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
			getRandomValues: values => { values[0] = 12345; return values; },
		},
		fetch: async (url, options = {}) => {
			calls.fetches.push({url, options});
			return {ok: true, status: 201, json: async () => ({id: 'preset'})};
		},
		CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
		localStorage: {
			getItem: key => storage.get(key) ?? null,
			removeItem: key => storage.delete(key),
			setItem: (key, value) => storage.set(key, value),
		},
		PS: {
			teams,
			isOffline: false,
			rooms: {},
			user: {
				named: true, userid: 'localuser', name: 'Local User', loggingIn: null,
				changeName: name => calls.names.push(name),
			},
			mainmenu: {},
			alert: (...args) => calls.alerts.push(args),
			confirm: async () => true,
			join: (...args) => calls.joins.push(args),
			leave() {},
			requestNotifications() {},
			send: command => calls.sends.push(command),
		},
		PokemonAIApp: {
			mode: 'ai',
			isAI() { return this.mode === 'ai'; },
			isOnline() { return this.mode === 'online'; },
			localTrainerName() { return 'Local Player 1'; },
			navigateToMode(mode) { calls.navigated = mode; },
			storageKeys: {orientationTipSeen: 'pokemonai-orientation-tip-seen'},
		},
		getActivePlayerBattle: () => null,
		openPokemonAIPopup: (_kind, roomid) => calls.joins.push([roomid]),
		window: {addEventListener() {}, removeEventListener() {}, dispatchEvent() {}},
		matchMedia: () => ({matches: true}),
		setTimeout: callback => callback(),
		toID: text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ''),
	};
	vm.createContext(context);
	vm.runInContext(
		`${configSource}\n${localTeamsSource}\n${aiSource}\nthis.api = {` +
		`PokemonAIConfig, findPokemonAIOpponent, findPokemonAIFormat, challengePokemonAI, ` +
		`resumePendingPokemonAIChallenge, buildPokemonAIChallengeCommand, buildPokemonAIRematchCommand, ` +
		`startOfficialRandomBattle, challengeOfficialPlayer, resumePendingOnlineAction, switchPokemonAIMode, ` +
		`openPokemonAISetup, selectPokemonAIAITeamSettings, selectPokemonAILocalTeam, ` +
		`pokemonAISetupStore, pokemonAILocalTeamStore};`,
		context
	);
	return {api: context.api, calls, context, storage};
}

async function flushChallenge() {
	await new Promise(resolve => setImmediate(resolve));
}

function addTeam(fixture, formatId, packedTeam = 'packed-team', name = 'My Team') {
	const format = fixture.api.PokemonAIConfig.formats.find(item => item.id === formatId);
	const local = fixture.api.pokemonAILocalTeamStore.create({
		formatId: format.showdownFormat.split('@@@')[0], name, packedTeam,
	});
	assert.equal(fixture.api.selectPokemonAILocalTeam(formatId, local.id), true);
	return local;
}

describe('PokemonAI local-team flow', () => {
	let fixture;
	beforeEach(() => { fixture = makeContext(); });

	it('maps each opponent to its own Showdown format', () => {
		const doubles = fixture.api.findPokemonAIOpponent('PokemonAI Doubles');
		assert.equal(
			fixture.api.buildPokemonAIChallengeCommand(doubles),
			'/challenge PokemonAI Doubles, gen9championsvgc2026regmb@@@!Open Team Sheets'
		);
		assert.equal(
			fixture.api.buildPokemonAIChallengeCommand(fixture.api.findPokemonAIOpponent('PokemonAI Singles')),
			'/challenge PokemonAI Singles, gen9championsbssregmb'
		);
	});

	it('submits only the latest saved version of a selected local team', async () => {
		const opponent = fixture.api.findPokemonAIOpponent('PokemonAI Doubles');
		const local = addTeam(fixture, opponent.formatId, 'old-packed');
		fixture.api.pokemonAILocalTeamStore.update(local.id, {packedTeam: 'new-packed'});
		assert.equal(fixture.api.challengePokemonAI(opponent), true);
		await flushChallenge();
		const preset = JSON.parse(fixture.calls.fetches[0].options.body);
		assert.equal(preset.playerTeamPacked, 'new-packed');
		assert.equal(preset.mode, 'popular-random');
		assert.deepEqual(fixture.calls.sends, [
			'/utm new-packed',
			'/challenge PokemonAI Doubles, gen9championsvgc2026regmb@@@!Open Team Sheets',
		]);
	});

	it('preserves a selected local team through guest naming', async () => {
		const opponent = fixture.api.findPokemonAIOpponent('PokemonAI Doubles');
		addTeam(fixture, opponent.formatId);
		fixture.context.PS.user.named = false;
		assert.equal(fixture.api.challengePokemonAI(opponent), true);
		assert.deepEqual(fixture.calls.names, ['Local Player 1']);
		assert.deepEqual(fixture.calls.joins, []);
		fixture.context.PS.user.named = true;
		await fixture.api.resumePendingPokemonAIChallenge();
		assert.equal(fixture.calls.sends[0], '/utm packed-team');
	});

	it('creates a fixed-team preset without changing the player team', async () => {
		const opponent = fixture.api.findPokemonAIOpponent('PokemonAI Doubles');
		addTeam(fixture, opponent.formatId, 'player-packed');
		fixture.api.selectPokemonAIAITeamSettings(opponent.formatId, {
			mode: 'fixed', fixedTeamId: 'observed:team-7', fixedTeamName: 'Practice Team',
		});
		assert.equal(fixture.api.challengePokemonAI(opponent), true);
		await flushChallenge();
		const preset = JSON.parse(fixture.calls.fetches[0].options.body);
		assert.equal(preset.mode, 'fixed');
		assert.equal(preset.fixedTeamId, 'observed:team-7');
		assert.equal(preset.playerTeamPacked, 'player-packed');
	});

	it('does not use a catalog packed snapshot directly', () => {
		const opponent = fixture.api.findPokemonAIOpponent('PokemonAI Singles');
		assert.equal(fixture.api.challengePokemonAI(opponent, {
			formatId: opponent.formatId, source: 'catalog', key: 'catalog', name: 'Catalog', packedTeam: 'catalog-packed',
		}), false);
		assert.match(fixture.calls.alerts[0][0], /本地队伍/);
		assert.deepEqual(fixture.calls.sends, []);
	});

	it('soft-deletes and restores a stable local record', () => {
		const local = fixture.api.pokemonAILocalTeamStore.create({formatId: 'gen9ou', name: 'Stable', packedTeam: 'x'});
		assert.match(local.id, /^[0-9a-f-]{36}$/);
		assert.equal(fixture.api.pokemonAILocalTeamStore.softDelete(local.id), true);
		assert.equal(fixture.api.pokemonAILocalTeamStore.list().length, 0);
		assert.equal(fixture.api.pokemonAILocalTeamStore.restore(local.id), true);
		assert.equal(fixture.api.pokemonAILocalTeamStore.get(local.id).name, 'Stable');
	});

	it('uses normal rooms for setup, workspace, editor, and meta', () => {
		assert.match(mainMenuSource, /class AISetupPanel[\s\S]*?routes = \['ai-battle'\][\s\S]*?location = 'left'/);
		assert.match(workspaceSource, /class PokemonAITeamsPanel[\s\S]*?routes = \['ai-teams'\][\s\S]*?location = 'left'/);
		assert.match(workspaceSource, /class PokemonAILocalTeamEditorPanel[\s\S]*?routes = \['aiteam-\*'\]/);
		assert.match(mainMenuSource, /class AIMetaPanel[\s\S]*?routes = \['ai-meta'\][\s\S]*?location = 'left'/);
	});

	it('keeps online teams read-only until explicit local creation', () => {
		assert.match(workspaceSource, /startCatalogCopy[\s\S]*?confirmCatalogCopy/);
		assert.match(workspaceSource, /completeness === 'roster-only'[\s\S]*?没有完整配置/);
		assert.doesNotMatch(mainMenuSource, /showCatalog \? this\.renderCatalogTeams/);
		assert.match(workspaceSource, /pokemonAILocalTeamStore\.create\(\{[\s\S]*?name: this\.copyName/);
	});

	it('uses fixed pages for online teams', () => {
		assert.match(workspaceSource, /readonly catalogPageSize = 20/);
		assert.match(workspaceSource, /cursor: String\(\(this\.catalogPage - 1\) \* this\.catalogPageSize\)/);
		assert.match(workspaceSource, /aria-label="线上队伍分页"/);
		assert.doesNotMatch(workspaceSource, /加载更多|catalogNextCursor/);
	});

	it('keeps carousel browsing separate from the battle-team selection', () => {
		assert.match(carouselSource, /onActiveChange: \(id: string\) => void/);
		assert.doesNotMatch(carouselSource, /selectPokemonAI|pokemonAISetupStore/);
		assert.match(mainMenuSource, /browseLocalTeam = \(id: string\)[\s\S]*?this\.activeLocalTeamIds\[formatId\] = id/);
		assert.match(mainMenuSource, /selectActiveTeam = \(\)[\s\S]*?selectPokemonAILocalTeam/);
	});

	it('requires a local team for every closed-team format', () => {
		assert.equal(fixture.api.challengePokemonAI(fixture.api.findPokemonAIOpponent('PokemonAI Doubles')), false);
		assert.match(fixture.calls.alerts[0][0], /本地队伍/);
		assert.deepEqual(fixture.calls.sends, []);
	});

	it('keeps AI and official actions isolated by mode', () => {
		fixture.api.startOfficialRandomBattle();
		assert.match(fixture.calls.alerts[0][0], /真人竞技模式/);
		fixture.context.PokemonAIApp.mode = 'online';
		fixture.api.challengePokemonAI(fixture.api.PokemonAIConfig.opponents[0]);
		assert.match(fixture.calls.alerts[1][0], /AI 训练模式/);
	});
});

describe('PokemonAI local-team migration', () => {
	it('migrates every Showdown format and box before removing the old key', () => {
		const fixture = makeContext({
			showdown_teams: 'gen9ou]OU Team|ou-packed\ngen8-box]Archive/Set Box|box-packed',
		});
		const records = fixture.api.pokemonAILocalTeamStore.list({includeBoxes: true});
		assert.equal(records.length, 2);
		assert.equal(records[0].formatId, 'gen9ou');
		assert.equal(records[1].kind, 'box');
		assert.equal(records[1].folder, 'Archive');
		assert.equal(fixture.storage.has('showdown_teams'), false);
		assert.equal(fixture.storage.has('pokemonai-local-teams'), true);
	});
});
