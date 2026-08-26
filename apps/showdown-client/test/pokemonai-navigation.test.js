const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const {describe, it} = require('node:test');
const vm = require('vm');

const publicRoot = path.resolve(__dirname, '../play.pokemonshowdown.com');
const navigationSource = fs.readFileSync(path.join(publicRoot, 'js/pokemonai/navigation.js'), 'utf8');
const panelsSource = fs.readFileSync(path.join(publicRoot, 'src/panels.tsx'), 'utf8');
const topbarSource = fs.readFileSync(path.join(publicRoot, 'src/panel-topbar.tsx'), 'utf8');
const mainMenuSource = fs.readFileSync(path.join(publicRoot, 'src/panel-mainmenu.tsx'), 'utf8');
const teamsSource = fs.readFileSync(path.join(publicRoot, 'src/panel-pokemonai-teams.tsx'), 'utf8');

function makeContext() {
	const calls = {joins: [], leaves: [], focuses: [], pushes: [], replaces: [], confirms: [], popupCloses: 0};
	const listeners = {};
	const subscriptions = [];
	const stack = [{state: '', url: 'https://pokemonai.example/'}];
	let stackIndex = 0;
	const location = {href: stack[0].url, pathname: '/', search: '', hash: ''};
	const emit = (type, event) => {
		for (const listener of listeners[type] || []) listener(event);
	};
	const history = {
		get state() { return stack[stackIndex].state; },
		pushState(state, _title, url) {
			stack.splice(stackIndex + 1);
			stack.push({state, url: String(url)});
			stackIndex++;
			location.href = String(url);
			calls.pushes.push(state);
		},
		replaceState(state, _title, url) {
			stack[stackIndex] = {state, url: String(url)};
			location.href = String(url);
			calls.replaces.push(state);
		},
		back() {
			if (!stackIndex) return;
			stackIndex--;
			location.href = stack[stackIndex].url;
			emit('popstate', {state: stack[stackIndex].state});
		},
		forward() {
			if (stackIndex >= stack.length - 1) return;
			stackIndex++;
			location.href = stack[stackIndex].url;
			emit('popstate', {state: stack[stackIndex].state});
		},
		go(delta) {
			const next = Math.max(0, Math.min(stack.length - 1, stackIndex + delta));
			if (next === stackIndex) return;
			stackIndex = next;
			emit('popstate', {state: stack[stackIndex].state});
		},
	};
	const home = {id: '', type: 'mainmenu', title: '首页', args: null, noURL: false, notifications: []};
	const PS = {
		rooms: {'': home}, room: home, panel: home,
		router: {
			panelState: '', replaceCalls: 0,
			replaceNextNavigation() { this.replaceCalls++; },
		},
		confirm: async (...args) => { calls.confirms.push(args); return calls.confirmResult ?? true; },
		join(roomid, options = {}) {
			calls.joins.push([roomid, options]);
			const room = this.rooms[roomid] || {
				id: roomid, type: roomid === 'ai-battle' ? 'aibattle' : roomid === 'ai-teams' ? 'pokemonai-teams' : 'html',
				title: roomid, args: options.args || null, noURL: false, notifications: [],
			};
			if (options.args) room.args = options.args;
			this.rooms[roomid] = room;
			this.room = room;
			this.panel = room;
			this.router.panelState = roomid;
			for (const listener of subscriptions) listener();
		},
		leave(roomid) { calls.leaves.push(roomid); delete this.rooms[roomid]; },
		focusRoom(roomid) { calls.focuses.push(roomid); this.room = this.rooms[roomid]; this.panel = this.room; },
		closePopup() { calls.popupCloses++; },
		subscribe(listener) { subscriptions.push(listener); },
	};
	const context = {
		console, history, location, PS, Config: {pokemonaiApp: true},
		CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
		document: {
			querySelector: () => null,
			getElementById: () => null,
		},
		requestAnimationFrame: callback => callback(),
		setTimeout: callback => callback(),
		window: {
			history,
			addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
			dispatchEvent() {},
		},
	};
	vm.createContext(context);
	vm.runInContext(`${navigationSource}\nthis.api = {
		pokemonAINavSection, getPokemonAIOngoingBattles, getActivePlayerBattle,
		openPokemonAILayer, closePokemonAILayer, getPokemonAITopLayer,
		openPokemonAIPopup, navigatePokemonAI, focusPokemonAIReturnTarget
	};`, context);
	return {api: context.api, calls, context, history, PS};
}

describe('PokemonAI product navigation', () => {
	it('maps product rooms to stable primary sections', () => {
		const {api} = makeContext();
		assert.equal(api.pokemonAINavSection({id: '', type: 'mainmenu'}), 'home');
		assert.equal(api.pokemonAINavSection({id: 'ai-battle', type: 'aibattle'}), 'battle');
		assert.equal(api.pokemonAINavSection({id: 'ai-teams', type: 'pokemonai-teams'}), 'teams');
		assert.equal(api.pokemonAINavSection({id: 'aiteam-123', type: 'pokemonai-team-editor'}), 'teams');
		assert.equal(api.pokemonAINavSection({id: 'ai-meta', type: 'aimeta'}), 'advanced');
	});

	it('keeps only battle rooms in ongoing and locks only an unfinished player battle', () => {
		const {api, PS} = makeContext();
		const player = {id: 'battle-player', type: 'battle', side: {}, battle: {ended: false}, notifications: []};
		const spectator = {id: 'battle-watch', type: 'battle', side: null, battle: {ended: false}, notifications: []};
		const ended = {id: 'battle-ended', type: 'battle', side: {}, battle: {ended: true}, notifications: []};
		PS.rooms = {...PS.rooms, [player.id]: player, [spectator.id]: spectator, [ended.id]: ended,
			lobby: {id: 'lobby', type: 'chat', notifications: []}};
		assert.deepEqual(Array.from(api.getPokemonAIOngoingBattles(), room => room.id), [player.id, spectator.id, ended.id]);
		assert.equal(api.getActivePlayerBattle().id, player.id);
	});

	it('uses replace navigation for fixed sections without pushing a layer history entry', async () => {
		const {api, calls, PS} = makeContext();
		await api.navigatePokemonAI('teams');
		assert.equal(PS.router.replaceCalls, 1);
		assert.equal(calls.joins.at(-1)[0], 'ai-teams');
		assert.equal(calls.pushes.length, 0);
	});

	it('pushes temporary layers and browser back closes them one at a time', () => {
		const {api} = makeContext();
		api.openPokemonAILayer('team-picker', 'ai-battle');
		api.openPokemonAILayer('team-detail', 'ai-battle');
		assert.equal(api.getPokemonAITopLayer('ai-battle').kind, 'team-detail');
		api.closePokemonAILayer('ai-battle');
		assert.equal(api.getPokemonAITopLayer('ai-battle').kind, 'team-picker');
		api.closePokemonAILayer('ai-battle');
		assert.equal(api.getPokemonAITopLayer('ai-battle'), null);
	});

	it('keeps a managed account popup on the underlying URL and back closes only the popup', () => {
		const {api, calls, PS, history} = makeContext();
		api.openPokemonAIPopup('account', 'official-account');
		PS.rooms['official-account'].noURL = true;
		assert.equal(api.getPokemonAITopLayer().kind, 'account');
		assert.equal(calls.pushes.length, 1);
		history.back();
		assert.equal(api.getPokemonAITopLayer(), null);
		assert.equal(calls.popupCloses, 1);
	});

	it('prevents primary navigation while a player battle is unfinished', async () => {
		const {api, calls, PS} = makeContext();
		const battle = {id: 'battle-live', type: 'battle', side: {}, battle: {ended: false}, notifications: []};
		PS.rooms[battle.id] = battle;
		assert.equal(await api.navigatePokemonAI('home'), false);
		assert.deepEqual(calls.focuses, [battle.id]);
	});

	it('asks before fixed navigation leaves a dirty editor', async () => {
		const {api, calls, PS} = makeContext();
		const editor = {
			id: 'aiteam-dirty', type: 'pokemonai-team-editor', title: '编辑', dirty: true,
			args: null, noURL: false, notifications: [],
		};
		PS.rooms[editor.id] = editor;
		PS.room = editor;
		PS.panel = editor;
		calls.confirmResult = false;
		assert.equal(await api.navigatePokemonAI('teams'), false);
		assert.equal(calls.joins.length, 0);
		assert.equal(editor.dirty, true);
		calls.confirmResult = true;
		assert.equal(await api.navigatePokemonAI('teams'), true);
		assert.equal(editor.dirty, false);
		assert.equal(calls.leaves.at(-1), editor.id);
	});

	it('uses teams as the direct editor return fallback', () => {
		const {api, calls, PS} = makeContext();
		api.focusPokemonAIReturnTarget();
		assert.equal(PS.router.replaceCalls, 1);
		assert.equal(calls.joins.at(-1)[0], 'ai-teams');
	});

	it('keeps replace handling in both path and local hash routers', () => {
		assert.match(panelsSource, /subscribeHash\(\)[\s\S]*?history\.replaceState/);
		assert.match(panelsSource, /subscribeHistory\(\)[\s\S]*?history\.replaceState/);
		assert.match(panelsSource, /typeof e\.state === 'string' \? e\.state : e\.state\?\.panelState/);
	});

	it('renders the fixed desktop and mobile shells and the unified battle entry', () => {
		for (const label of ['首页', '对战', '阵容', '进行中']) assert.match(topbarSource, new RegExp(`>${label}<`));
		assert.match(topbarSource, /class="pokemonai-mobile-nav"/);
		assert.match(topbarSource, /getPokemonAIOngoingBattles\(\)/);
		assert.match(mainMenuSource, /if \(PokemonAIApp\.isOnline\(\)\) return this\.renderOnlineSetup\(\)/);
		assert.match(mainMenuSource, /openPokemonAILayer\('team-picker'/);
		assert.match(mainMenuSource, /localizeCatalogTeam[\s\S]*?pokemonAILocalTeamStore\.create/);
		assert.match(mainMenuSource, /selectCatalogTeam[\s\S]*?selectPokemonAILocalTeam/);
		assert.match(teamsSource, /historyBack: true/);
		assert.match(teamsSource, /back = async \(\)[\s\S]*?PS\.confirm\('放弃尚未保存的修改/);
		assert.match(topbarSource, /PokemonAIApp\.isAI\(\)[\s\S]*?displayTrainerName/);
		assert.match(topbarSource, /PokemonAIApp\.isOnline\(\) && <a href="official-account"/);
		assert.match(mainMenuSource, /case 'challstr'[\s\S]*?ensurePokemonAITrainerIdentity\(\)/);
	});
});
