import { Config, PS, type PSRoom, type RoomID } from '../client-main';

export type PokemonAINavSection = 'home' | 'battle' | 'teams' | 'advanced';

export type PokemonAIOverlayKind =
	'team-picker' | 'ai-team-picker' | 'team-detail' | 'catalog-copy' | 'new-local' |
	'account' | 'settings' | 'confirm';

export interface PokemonAIReturnTarget {
	roomid: RoomID;
	args?: Record<string, unknown>;
	focusSelector?: string;
	scrollTop?: number;
	historyBack?: boolean;
}

export interface PokemonAIOverlayState {
	id: number;
	kind: PokemonAIOverlayKind;
	ownerRoomid: RoomID;
	payload?: Record<string, unknown>;
}

export interface PokemonAIHistoryState {
	panelState?: string;
	pokemonai?: {
		layers?: PokemonAIOverlayState[],
		battleBase?: RoomID,
		battleGuard?: RoomID,
	};
}

const POKEMONAI_PRODUCT_ROOMS = new Set(['', 'ai-battle', 'ai-teams', 'ai-meta']);
let pokemonAILayerSequence = 0;
let pokemonAILayers: PokemonAIOverlayState[] = [];
let pokemonAILayerListeners: (() => void)[] = [];
let pokemonAIBattleGuardRoomid = '' as RoomID;
let pokemonAIRestoringBattleGuard = false;
let pokemonAIRestoringEditorHistory = false;
let pokemonAIRestoringPopupHistory = false;

function pokemonAIManagedPopupLayer(layer: PokemonAIOverlayState | null | undefined) {
	return !!layer && (layer.kind === 'account' || layer.kind === 'settings') &&
		typeof layer.payload?.popupRoomid === 'string';
}

function pokemonAIHistoryState(raw: unknown = history.state): PokemonAIHistoryState {
	if (typeof raw === 'string') return { panelState: raw };
	if (!raw || typeof raw !== 'object') return {};
	const state = raw as PokemonAIHistoryState;
	return {
		...state,
		pokemonai: state.pokemonai ? {
			...state.pokemonai,
			layers: Array.isArray(state.pokemonai.layers) ? state.pokemonai.layers : [],
		} : undefined,
	};
}

function pokemonAIEmitLayerChange() {
	for (const listener of pokemonAILayerListeners) listener();
}

function pokemonAISyncLayers(raw: unknown = history.state) {
	const previousTop = pokemonAILayers[pokemonAILayers.length - 1] || null;
	const state = pokemonAIHistoryState(raw);
	const nextLayers = state.pokemonai?.layers || [];
	if (JSON.stringify(nextLayers) === JSON.stringify(pokemonAILayers)) return;
	pokemonAILayers = nextLayers;
	pokemonAIEmitLayerChange();
	if (pokemonAIManagedPopupLayer(previousTop) && !pokemonAILayers.some(layer => layer.id === previousTop.id)) {
		PS.closePopup();
	}
}

export function subscribePokemonAINavigation(listener: () => void) {
	pokemonAILayerListeners.push(listener);
	return () => {
		const index = pokemonAILayerListeners.indexOf(listener);
		if (index >= 0) pokemonAILayerListeners.splice(index, 1);
	};
}

export function getPokemonAILayers(ownerRoomid?: RoomID) {
	return ownerRoomid ? pokemonAILayers.filter(layer => layer.ownerRoomid === ownerRoomid) : [...pokemonAILayers];
}

export function getPokemonAITopLayer(ownerRoomid?: RoomID) {
	const layers = getPokemonAILayers(ownerRoomid);
	return layers[layers.length - 1] || null;
}

export function openPokemonAILayer(
	kind: PokemonAIOverlayKind, ownerRoomid: RoomID, payload?: Record<string, unknown>
) {
	const layer: PokemonAIOverlayState = { id: ++pokemonAILayerSequence, kind, ownerRoomid, payload };
	const state = pokemonAIHistoryState();
	pokemonAILayers = [...pokemonAILayers, layer];
	history.pushState({
		...state,
		panelState: state.panelState || PS.router.panelState,
		pokemonai: { ...state.pokemonai, layers: pokemonAILayers },
	} satisfies PokemonAIHistoryState, '', location.href);
	pokemonAIEmitLayerChange();
	return layer;
}

export function openPokemonAIPopup(
	kind: 'account' | 'settings', popupRoomid: RoomID, parentElem?: HTMLElement | null,
) {
	const ownerRoomid = (PS.panel?.id || '') as RoomID;
	openPokemonAILayer(kind, ownerRoomid, { popupRoomid });
	PS.join(popupRoomid, { parentElem: parentElem || undefined, parentRoomid: ownerRoomid });
}

export function closePokemonAILayer(ownerRoomid?: RoomID) {
	const top = getPokemonAITopLayer();
	if (!top || (ownerRoomid && top.ownerRoomid !== ownerRoomid)) return false;
	history.back();
	return true;
}

export function clearPokemonAILayers(replaceHistory = true) {
	if (!pokemonAILayers.length) return;
	pokemonAILayers = [];
	if (replaceHistory) {
		const state = pokemonAIHistoryState();
		history.replaceState({
			...state,
			pokemonai: { ...state.pokemonai, layers: [] },
		} satisfies PokemonAIHistoryState, '', location.href);
	}
	pokemonAIEmitLayerChange();
}

export function pokemonAINavSection(room: PSRoom | null | undefined = PS.panel): PokemonAINavSection {
	if (!room || room.id === '') return 'home';
	if (room.id === 'ai-battle' || room.type === 'aibattle' || room.type === 'battle') return 'battle';
	if (room.id === 'ai-teams' || room.id.startsWith('aiteam-') ||
		room.type === 'pokemonai-teams' || room.type === 'pokemonai-team-editor') return 'teams';
	return 'advanced';
}

export function isPokemonAIProductRoom(room: PSRoom | null | undefined) {
	if (!room) return false;
	return POKEMONAI_PRODUCT_ROOMS.has(room.id) || room.id.startsWith('aiteam-');
}

export function getPokemonAIOngoingBattles() {
	return Object.values(PS.rooms).filter((room): room is PSRoom => !!room && room.type === 'battle');
}

export function getActivePlayerBattle() {
	return getPokemonAIOngoingBattles().find(room => {
		const battleRoom = room as any;
		return !!battleRoom.side && !!battleRoom.battle && !battleRoom.battle.ended;
	}) || null;
}

function pokemonAISectionRoomid(section: PokemonAINavSection): RoomID {
	switch (section) {
	case 'home': return '' as RoomID;
	case 'battle': return 'ai-battle' as RoomID;
	case 'teams': return 'ai-teams' as RoomID;
	case 'advanced': return 'ai-meta' as RoomID;
	}
}

async function pokemonAICanLeaveEditor() {
	const room = PS.room as any;
	if (room?.type !== 'pokemonai-team-editor' || !room.dirty) return true;
	const discard = await PS.confirm('放弃尚未保存的修改？', {
		okButton: '放弃修改', cancelButton: '继续编辑',
	});
	if (discard) room.dirty = false;
	return discard;
}

export async function navigatePokemonAI(
	section: PokemonAINavSection, options: { args?: Record<string, unknown>, parentElem?: HTMLElement | null } = {}
) {
	const activeBattle = getActivePlayerBattle();
	if (activeBattle && PS.room !== activeBattle) {
		PS.focusRoom(activeBattle.id);
		return false;
	}
	if (activeBattle && section !== 'battle') {
		PS.focusRoom(activeBattle.id);
		return false;
	}
	if (!await pokemonAICanLeaveEditor()) return false;

	const roomid = pokemonAISectionRoomid(section);
	const previousEditor = PS.room.type === 'pokemonai-team-editor' ? PS.room : null;
	clearPokemonAILayers(true);
	PS.router.replaceNextNavigation();
	PS.join(roomid, { args: options.args, parentElem: options.parentElem });
	if (previousEditor && previousEditor.id !== roomid) PS.leave(previousEditor.id);
	return true;
}

export function focusPokemonAIReturnTarget(target?: PokemonAIReturnTarget | null) {
	const fallback: PokemonAIReturnTarget = { roomid: 'ai-teams' as RoomID, args: { view: 'local' } };
	const destination = target || fallback;
	if (destination.historyBack) {
		history.back();
		return;
	}
	clearPokemonAILayers(false);
	const existingRoom = PS.rooms[destination.roomid];
	if (existingRoom) existingRoom.args = destination.args || {};
	PS.router.replaceNextNavigation();
	PS.join(destination.roomid, { args: destination.args });
	window.dispatchEvent(new CustomEvent('pokemonai-return-target', { detail: destination }));
	requestAnimationFrame(() => {
		const room = PS.rooms[destination.roomid];
		const element = destination.focusSelector ? document.querySelector<HTMLElement>(destination.focusSelector) : null;
		if (element) element.focus();
		if (typeof destination.scrollTop === 'number') {
			document.getElementById(`room-${room?.id}`)?.scrollTo({ top: destination.scrollTop });
		}
	});
}

function pokemonAIInstallBattleGuard() {
	const activeBattle = getActivePlayerBattle();
	if (activeBattle && PS.room !== activeBattle && !PS.room.noURL) {
		PS.focusRoom(activeBattle.id);
		return;
	}
	if (!activeBattle || PS.room !== activeBattle) {
		pokemonAIBattleGuardRoomid = '' as RoomID;
		return;
	}
	if (pokemonAIBattleGuardRoomid === activeBattle.id) return;
	pokemonAIBattleGuardRoomid = activeBattle.id;
	const state = pokemonAIHistoryState();
	history.replaceState({
		...state,
		pokemonai: { ...state.pokemonai, battleBase: activeBattle.id, battleGuard: undefined },
	} satisfies PokemonAIHistoryState, '', location.href);
	history.pushState({
		...state,
		pokemonai: { ...state.pokemonai, battleBase: undefined, battleGuard: activeBattle.id },
	} satisfies PokemonAIHistoryState, '', location.href);
}

PS.router.routeChangeGuard = () => {
	if (pokemonAIRestoringPopupHistory) return false;
	if (PS.room.noURL && !pokemonAIManagedPopupLayer(getPokemonAITopLayer())) {
		pokemonAIRestoringPopupHistory = true;
		history.forward();
		setTimeout(() => {
			PS.closePopup();
			pokemonAIRestoringPopupHistory = false;
		}, 0);
		return false;
	}
	if (pokemonAIRestoringEditorHistory) {
		pokemonAIRestoringEditorHistory = false;
		return false;
	}
	const editor = PS.room as any;
	if (editor?.type !== 'pokemonai-team-editor' || !editor.dirty) return true;
	pokemonAIRestoringEditorHistory = true;
	history.forward();
	void PS.confirm('放弃尚未保存的修改？', {
		okButton: '放弃修改', cancelButton: '继续编辑',
	}).then(discard => {
		if (!discard) return;
		editor.dirty = false;
		history.back();
		setTimeout(() => PS.leave(editor.id), 50);
	});
	return false;
};

window.addEventListener('popstate', event => {
	if (pokemonAIRestoringPopupHistory) return;
	if (PS.room.noURL && !pokemonAIManagedPopupLayer(getPokemonAITopLayer())) {
		pokemonAIRestoringPopupHistory = true;
		history.forward();
		setTimeout(() => {
			PS.closePopup();
			pokemonAIRestoringPopupHistory = false;
		}, 0);
		return;
	}
	const state = pokemonAIHistoryState(event.state);
	const activeBattle = getActivePlayerBattle();
	if (activeBattle && state.pokemonai?.battleBase === activeBattle.id && !pokemonAIRestoringBattleGuard) {
		pokemonAIRestoringBattleGuard = true;
		history.forward();
		setTimeout(() => {
			pokemonAIRestoringBattleGuard = false;
			activeBattle.interruptClose(true);
		}, 0);
		return;
	}
	pokemonAISyncLayers(event.state);
});

window.addEventListener('click', event => {
	if (!Config.pokemonaiApp) return;
	const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('a,button');
	if (!target) return;
	const topLayer = getPokemonAITopLayer();
	if ((target as HTMLButtonElement).name === 'closeRoom' && pokemonAIManagedPopupLayer(topLayer)) {
		event.preventDefault();
		event.stopImmediatePropagation();
		closePokemonAILayer();
		return;
	}
	const route = target.getAttribute('data-href')?.replace(/^\//, '') || target.getAttribute('href')?.replace(/^\//, '');
	let kind: 'account' | 'settings' | null = null;
	if (route === 'login' || route === 'official-account') kind = 'account';
	if (route === 'options' || route === 'volume') kind = 'settings';
	if (!kind || !route) return;
	event.preventDefault();
	event.stopImmediatePropagation();
	openPokemonAIPopup(kind, route as RoomID, target);
}, true);

PS.subscribe(() => {
	pokemonAIInstallBattleGuard();
	const topLayer = getPokemonAITopLayer();
	if (!pokemonAIManagedPopupLayer(topLayer)) return;
	const popupRoomid = topLayer.payload!.popupRoomid as RoomID;
	if (!PS.rooms[popupRoomid]) closePokemonAILayer();
});
pokemonAISyncLayers();
