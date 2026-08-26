import { toID } from './battle-dex';
import { PS, type RoomID } from './client-main';
import { PokemonAIApp, type AppMode } from './pokemonai-app';
import { getActivePlayerBattle, openPokemonAIPopup } from './pokemonai/navigation';
import {
	PokemonAIConfig, type PokemonAIFormat, type PokemonAIOpponent,
} from './pokemonai-config';
import './pokemonai/catalog';
import { openPokemonAITeamWorkspace, pokemonAILocalTeamStore } from './pokemonai/teams';

const PENDING_KEY = 'pokemonai-pending-challenge';
const LEGACY_PENDING_KEY = 'pokemonai-pending-opponent';
const LAST_TEAM_PREFIX = 'pokemonai-last-team-';
const LAST_TEAM_NAME_PREFIX = 'pokemonai-last-team-name-';
const SELECTED_TEAMS_KEY = 'pokemonai-selected-teams';
const AI_TEAM_SETTINGS_KEY = 'pokemonai-ai-team-settings';
const PENDING_ONLINE_KEY = 'pokemonai-pending-online-action';
const DEFAULT_AGENT_ID = 'ranked-doubles-ai';
const LEGACY_FORMAT_ID = 'champions-reg-mb';

function sanitizePackedTeam(packedTeam: string): string {
	return packedTeam.replace(/[\r\n]/g, '').trim();
}

interface PendingPokemonAIChallenge {
	opponentId: string;
	packedTeam: string;
	aiTeamSettings: PokemonAITeamSettings;
}

export type PokemonAIFormatId = string;
export type PokemonAISetupView = 'setup' | 'library';
export type PokemonAITeamMode = 'mirror' | 'counter' | 'popular-random' | 'generated-random' | 'fixed';

export interface PokemonAITeamSettings {
	mode: PokemonAITeamMode;
	fixedTeamId?: string;
	fixedTeamName?: string;
}

export interface PokemonAITeamSelection {
	formatId: PokemonAIFormatId;
	localTeamId?: string;
	source: 'showdown' | 'catalog';
	key: string;
	name: string;
	packedTeam: string;
}

export interface PokemonAISetupState {
	formatId: PokemonAIFormatId;
	view: PokemonAISetupView;
	selectedTeamIds: Partial<Record<PokemonAIFormatId, string>>;
	aiTeamSettings: Partial<Record<PokemonAIFormatId, PokemonAITeamSettings>>;
}

const DEFAULT_AI_TEAM_SETTINGS: PokemonAITeamSettings = { mode: 'popular-random' };
const AI_TEAM_MODES: readonly PokemonAITeamMode[] = [
	'mirror', 'counter', 'popular-random', 'generated-random', 'fixed',
];

function normalizeAITeamSettings(value: unknown): PokemonAITeamSettings {
	if (!value || typeof value !== 'object') return { ...DEFAULT_AI_TEAM_SETTINGS };
	const raw = value as Partial<PokemonAITeamSettings>;
	const mode = raw.mode && AI_TEAM_MODES.includes(raw.mode) ? raw.mode : 'popular-random';
	return {
		mode,
		...(typeof raw.fixedTeamId === 'string' && raw.fixedTeamId ? { fixedTeamId: raw.fixedTeamId } : {}),
		...(typeof raw.fixedTeamName === 'string' && raw.fixedTeamName ? { fixedTeamName: raw.fixedTeamName } : {}),
	};
}

export function findPokemonAIFormat(id: string): PokemonAIFormat | undefined {
	return PokemonAIConfig.formats.find(format => format.id === id);
}

export function rememberPokemonAITeam(formatId: string, packedTeam: string, name = '') {
	packedTeam = sanitizePackedTeam(packedTeam);
	if (!formatId || !packedTeam) return;
	localStorage.setItem(`${LAST_TEAM_PREFIX}${formatId}`, packedTeam);
	if (name) {
		localStorage.setItem(`${LAST_TEAM_NAME_PREFIX}${formatId}`, name);
	} else {
		localStorage.removeItem(`${LAST_TEAM_NAME_PREFIX}${formatId}`);
	}
}

export function getRememberedPokemonAITeam(formatId: string) {
	if (formatId === 'champions-ranked-doubles' && !localStorage.getItem(`${LAST_TEAM_PREFIX}${formatId}`)) {
		const legacyTeam = localStorage.getItem(`${LAST_TEAM_PREFIX}${LEGACY_FORMAT_ID}`);
		if (legacyTeam) {
			localStorage.setItem(`${LAST_TEAM_PREFIX}${formatId}`, legacyTeam);
			const legacyName = localStorage.getItem(`${LAST_TEAM_NAME_PREFIX}${LEGACY_FORMAT_ID}`);
			if (legacyName) localStorage.setItem(`${LAST_TEAM_NAME_PREFIX}${formatId}`, legacyName);
		}
	}
	const packedTeam = sanitizePackedTeam(localStorage.getItem(`${LAST_TEAM_PREFIX}${formatId}`) || '');
	if (!packedTeam) return null;
	return {
		packedTeam,
		name: localStorage.getItem(`${LAST_TEAM_NAME_PREFIX}${formatId}`) || '',
	};
}

function normalizePokemonAIFormatId(formatId?: string): PokemonAIFormatId {
	return findPokemonAIFormat(formatId || '')?.id || PokemonAIConfig.defaultFormat;
}

class PokemonAISetupStore {
	state: PokemonAISetupState = {
		formatId: normalizePokemonAIFormatId(),
		view: 'setup',
		selectedTeamIds: this.loadSelectedTeamIds(),
		aiTeamSettings: this.loadAITeamSettings(),
	};
	private listeners = new globalThis.Set<() => void>();
	constructor() {
		pokemonAILocalTeamStore.subscribe(() => this.emit());
	}

	getState(): PokemonAISetupState {
		return this.state;
	}
	setFormat(formatId?: string) {
		const normalized = normalizePokemonAIFormatId(formatId);
		this.ensureRememberedSelection(normalized);
		if (this.state.formatId === normalized) return;
		this.state = { ...this.state, formatId: normalized };
		this.emit();
	}
	setView(view: PokemonAISetupView) {
		if (this.state.view === view) return;
		this.state = { ...this.state, view };
		this.emit();
	}
	getAITeamSettings(formatId = this.state.formatId): PokemonAITeamSettings {
		return { ...(this.state.aiTeamSettings[normalizePokemonAIFormatId(formatId)] || DEFAULT_AI_TEAM_SETTINGS) };
	}
	setAITeamSettings(formatId: PokemonAIFormatId, settings: PokemonAITeamSettings) {
		formatId = normalizePokemonAIFormatId(formatId);
		const normalized = normalizeAITeamSettings(settings);
		this.state = {
			...this.state,
			aiTeamSettings: { ...this.state.aiTeamSettings, [formatId]: normalized },
		};
		localStorage.setItem(AI_TEAM_SETTINGS_KEY, JSON.stringify(this.state.aiTeamSettings));
		this.emit();
	}
	selectTeam(formatId: PokemonAIFormatId, localTeamId: string) {
		formatId = normalizePokemonAIFormatId(formatId);
		const record = pokemonAILocalTeamStore.get(localTeamId);
		const format = findPokemonAIFormat(formatId);
		if (!record || record.deletedAt || record.kind !== 'team' || record.validation.status === 'invalid' ||
			!format || PS.teams.teambuilderFormat(record.formatId) !== PS.teams.teambuilderFormat(format.showdownFormat)) {
			return false;
		}
		this.state = {
			...this.state,
			formatId,
			selectedTeamIds: { ...this.state.selectedTeamIds, [formatId]: localTeamId },
		};
		this.persistSelectedTeamIds();
		this.emit();
		return true;
	}
	selection(formatId = this.state.formatId): PokemonAITeamSelection | null {
		const normalized = normalizePokemonAIFormatId(formatId);
		this.ensureRememberedSelection(normalized);
		const localTeamId = this.state.selectedTeamIds[normalized];
		const record = localTeamId ? pokemonAILocalTeamStore.get(localTeamId) : null;
		const format = findPokemonAIFormat(normalized);
		if (!record || record.deletedAt || record.kind !== 'team' || record.validation.status === 'invalid' ||
			!format || PS.teams.teambuilderFormat(record.formatId) !== PS.teams.teambuilderFormat(format.showdownFormat)) {
			if (localTeamId) this.clearSelection(normalized);
			return null;
		}
		return {
			formatId: normalized,
			localTeamId: record.id,
			source: 'showdown',
			key: record.id,
			name: record.name,
			packedTeam: record.packedTeam,
		};
	}
	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private ensureRememberedSelection(formatId: PokemonAIFormatId) {
		if (this.state.selectedTeamIds[formatId]) return;
		const remembered = getRememberedPokemonAITeam(formatId);
		if (!remembered) return;
		const format = findPokemonAIFormat(formatId);
		if (!format) return;
		const teamFormat = PS.teams.teambuilderFormat(format.showdownFormat);
		let local = pokemonAILocalTeamStore.list().find(team => (
			team.kind === 'team' && PS.teams.teambuilderFormat(team.formatId) === teamFormat &&
			team.packedTeam === remembered.packedTeam
		));
		if (!local) {
			local = pokemonAILocalTeamStore.create({
				formatId: teamFormat,
				name: remembered.name || '上次使用的队伍',
				packedTeam: remembered.packedTeam,
			});
		}
		this.state = {
			...this.state,
			selectedTeamIds: { ...this.state.selectedTeamIds, [formatId]: local.id },
		};
		this.persistSelectedTeamIds();
		localStorage.removeItem(`${LAST_TEAM_PREFIX}${formatId}`);
		localStorage.removeItem(`${LAST_TEAM_NAME_PREFIX}${formatId}`);
		if (formatId === 'champions-ranked-doubles') {
			localStorage.removeItem(`${LAST_TEAM_PREFIX}${LEGACY_FORMAT_ID}`);
			localStorage.removeItem(`${LAST_TEAM_NAME_PREFIX}${LEGACY_FORMAT_ID}`);
		}
	}
	private clearSelection(formatId: PokemonAIFormatId) {
		const selectedTeamIds = { ...this.state.selectedTeamIds };
		delete selectedTeamIds[formatId];
		this.state = { ...this.state, selectedTeamIds };
		this.persistSelectedTeamIds();
	}
	private loadSelectedTeamIds() {
		try {
			const value = JSON.parse(localStorage.getItem(SELECTED_TEAMS_KEY) || '{}');
			if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
			const result: Record<string, string> = {};
			for (const [formatId, localTeamId] of Object.entries(value)) {
				if (typeof localTeamId === 'string' && localTeamId) result[formatId] = localTeamId;
			}
			return result;
		} catch {
			return {};
		}
	}
	private persistSelectedTeamIds() {
		localStorage.setItem(SELECTED_TEAMS_KEY, JSON.stringify(this.state.selectedTeamIds));
	}
	private loadAITeamSettings() {
		try {
			const value = JSON.parse(localStorage.getItem(AI_TEAM_SETTINGS_KEY) || '{}');
			if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
			const result: Record<string, PokemonAITeamSettings> = {};
			for (const [formatId, settings] of Object.entries(value)) result[formatId] = normalizeAITeamSettings(settings);
			return result;
		} catch {
			return {};
		}
	}
	private emit() {
		for (const listener of this.listeners) listener();
	}
}

export const pokemonAISetupStore = new PokemonAISetupStore();

export function openPokemonAISetup(formatId?: PokemonAIFormatId, view: PokemonAISetupView = 'setup') {
	pokemonAISetupStore.setFormat(formatId);
	if (view === 'library') {
		openPokemonAITeamWorkspace('catalog', pokemonAISetupStore.getState().formatId);
		return;
	}
	PS.join('ai-battle' as RoomID);
}

export function selectPokemonAISetupFormat(formatId: PokemonAIFormatId) {
	pokemonAISetupStore.setFormat(formatId);
}

export function selectPokemonAILocalTeam(formatId: PokemonAIFormatId, localTeamId: string) {
	return pokemonAISetupStore.selectTeam(formatId, localTeamId);
}

/** Compatibility entry point for existing local-team selectors. Catalog teams are intentionally rejected. */
export function selectPokemonAISetupTeam(selection: Partial<PokemonAITeamSelection> & { formatId: string }) {
	const localTeamId = selection.localTeamId || (selection.source === 'showdown' ? selection.key : '');
	return !!localTeamId && pokemonAISetupStore.selectTeam(selection.formatId, localTeamId);
}

export function subscribePokemonAISetup(listener: () => void) {
	return pokemonAISetupStore.subscribe(listener);
}

export function selectPokemonAIAITeamSettings(formatId: PokemonAIFormatId, settings: PokemonAITeamSettings) {
	pokemonAISetupStore.setAITeamSettings(formatId, settings);
}

export function rememberPokemonAIChallenge(
	opponent: PokemonAIOpponent, packedTeam = '', aiTeamSettings = pokemonAISetupStore.getAITeamSettings(opponent.formatId)
) {
	packedTeam = sanitizePackedTeam(packedTeam);
	const pending: PendingPokemonAIChallenge = {
		opponentId: opponent.id, packedTeam, aiTeamSettings: normalizeAITeamSettings(aiTeamSettings),
	};
	localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
	localStorage.removeItem(LEGACY_PENDING_KEY);
}

function loadPendingPokemonAIChallenge(): PendingPokemonAIChallenge | null {
	const raw = localStorage.getItem(PENDING_KEY);
	if (raw) {
		try {
			const pending = JSON.parse(raw) as Partial<PendingPokemonAIChallenge>;
			if (typeof pending.opponentId === 'string') {
				return {
					opponentId: migrateOpponentId(pending.opponentId),
					packedTeam: typeof pending.packedTeam === 'string' ? sanitizePackedTeam(pending.packedTeam) : '',
					aiTeamSettings: normalizeAITeamSettings(pending.aiTeamSettings),
				};
			}
		} catch {}
	}
	const legacy = localStorage.getItem(LEGACY_PENDING_KEY);
	if (!legacy) return null;
	// Migrate the legacy pending opponent to the stable key; keep the legacy
	// entry when the migration itself fails so no pending challenge is lost.
	const migrated: PendingPokemonAIChallenge = {
		opponentId: migrateOpponentId(legacy), packedTeam: '', aiTeamSettings: { ...DEFAULT_AI_TEAM_SETTINGS },
	};
	try {
		localStorage.setItem(PENDING_KEY, JSON.stringify(migrated));
		localStorage.removeItem(LEGACY_PENDING_KEY);
	} catch {}
	return migrated;
}

function migrateOpponentId(value: string) {
	if (/^(vgc-[1-8]|vgc-learned-expert|random-(easy|normal|hard|expert))$/.test(value)) {
		return DEFAULT_AGENT_ID;
	}
	return value;
}

export function findPokemonAIOpponent(idOrUsername: string): PokemonAIOpponent | undefined {
	const id = toID(idOrUsername);
	return PokemonAIConfig.opponents.find(opponent => toID(opponent.id) === id || toID(opponent.username) === id);
}

export function buildPokemonAIChallengeCommand(opponent: PokemonAIOpponent): string {
	const format = findPokemonAIFormat(opponent.formatId);
	if (!format) throw new Error(`Unknown PokémonAI format: ${opponent.formatId}`);
	return `/challenge ${opponent.username}, ${format.showdownFormat}`;
}

export function buildPokemonAIRematchCommand(opponent: PokemonAIOpponent): string {
	return `/closeand ${buildPokemonAIChallengeCommand(opponent)}`;
}

export function challengePokemonAI(
	opponent: PokemonAIOpponent, team?: PokemonAITeamSelection, parentElem?: HTMLElement | null
): boolean {
	if (opponent.availability && opponent.availability !== 'ready') {
		PS.alert(opponent.reason || '这个 AI 对手目前不可用。', { parentElem: parentElem || undefined });
		return false;
	}
	if (!PokemonAIApp.isAI()) {
		PS.alert('请先切换到 AI 训练模式。', { parentElem: parentElem || undefined });
		return false;
	}
	if (PS.isOffline) {
		PS.alert('尚未连接到对战服务器，请稍后重试。', { parentElem: parentElem || undefined });
		return false;
	}
	const format = findPokemonAIFormat(opponent.formatId);
	const selected = pokemonAISetupStore.selection(opponent.formatId);
	if (team?.localTeamId && selected?.localTeamId !== team.localTeamId) {
		PS.alert('所选本地队伍已经发生变化，请重新选择。', { parentElem: parentElem || undefined });
		return false;
	}
	const packedTeam = sanitizePackedTeam(selected?.packedTeam || '');
	if (format?.requiresTeam && !packedTeam) {
		PS.alert('请先从本地队伍中选择一支可用队伍。', {
			parentElem: parentElem || undefined,
		});
		return false;
	}
	const aiTeamSettings = pokemonAISetupStore.getAITeamSettings(opponent.formatId);
	if (aiTeamSettings.mode === 'fixed' && !aiTeamSettings.fixedTeamId) {
		PS.alert('请先选择一支 AI 队伍。', { parentElem: parentElem || undefined });
		return false;
	}
	rememberPokemonAIChallenge(opponent, packedTeam, aiTeamSettings);
	if (!PS.user.named) {
		ensurePokemonAITrainerIdentity();
		return true;
	}
	void resumePendingPokemonAIChallenge();
	return true;
}

export function ensurePokemonAITrainerIdentity() {
	if (!PokemonAIApp.isAI() || PS.user.named || PS.user.loggingIn || PS.isOffline) return false;
	PS.user.changeName(PokemonAIApp.localTrainerName());
	return true;
}

let resumingPokemonAIChallenge = false;

export function resumePendingPokemonAIChallenge() {
	if (!PokemonAIApp.isAI() || !PS.user.named || PS.isOffline) return;
	if (resumingPokemonAIChallenge) return;
	const pending = loadPendingPokemonAIChallenge();
	if (!pending) return;
	const opponent = findPokemonAIOpponent(pending.opponentId);
	if (!opponent) return;
	resumingPokemonAIChallenge = true;
	const randomSeed = new Uint32Array(1);
	globalThis.crypto.getRandomValues(randomSeed);
	// The control endpoint accepts JSON and returns structured HTTP errors, so use the browser response API here.
	// eslint-disable-next-line no-restricted-globals
	const request = fetch('/api/ai/battle-presets', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-PokemonAI-Control': '1' },
		body: JSON.stringify({
			challenger: PS.user.name,
			opponentId: opponent.id,
			formatId: opponent.formatId,
			playerTeamPacked: pending.packedTeam,
			mode: pending.aiTeamSettings.mode,
			fixedTeamId: pending.aiTeamSettings.fixedTeamId,
			seed: (randomSeed[0] % 0x7ffffffe) + 1,
		}),
	}).then(response => response.json().catch(() => ({})).then((result: { error?: string }) => {
		if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
	}));
	return request.then(() => {
		localStorage.removeItem(PENDING_KEY);
		localStorage.removeItem(LEGACY_PENDING_KEY);
		PS.mainmenu.lastChallenged = Date.now();
		PS.requestNotifications();
		PS.send(`/utm ${pending.packedTeam}`);
		PS.send(buildPokemonAIChallengeCommand(opponent));
		resumingPokemonAIChallenge = false;
	}, error => {
		localStorage.removeItem(PENDING_KEY);
		localStorage.removeItem(LEGACY_PENDING_KEY);
		PS.alert(`无法准备 AI 对战：${error instanceof Error ? error.message : String(error)}`);
		resumingPokemonAIChallenge = false;
	});
}

type OnlineAction = { type: 'search' } | { type: 'challenge', username: string };

function rememberOnlineAction(action: OnlineAction) {
	localStorage.setItem(PENDING_ONLINE_KEY, JSON.stringify(action));
}

function onlineShowdownFormat(): string {
	return findPokemonAIFormat('gen9-random')?.showdownFormat || 'gen9randombattle';
}

function sendOnlineAction(action: OnlineAction) {
	PS.mainmenu.lastChallenged = Date.now();
	PS.requestNotifications();
	PS.send('/utm ');
	if (action.type === 'search') {
		PS.send(`/search ${onlineShowdownFormat()}`);
	} else {
		PS.send(`/challenge ${action.username}, ${onlineShowdownFormat()}`);
	}
}

function prepareOnlineAction(action: OnlineAction, parentElem?: HTMLElement | null) {
	if (!PokemonAIApp.isOnline()) {
		PS.alert('请先切换到真人竞技模式。', { parentElem: parentElem || undefined });
		return;
	}
	if (PS.isOffline) {
		PS.alert('尚未连接到官方服务器，请稍后重试。', { parentElem: parentElem || undefined });
		return;
	}
	rememberOnlineAction(action);
	if (!PS.user.named) {
		setTimeout(() => openPokemonAIPopup('account', 'login' as RoomID), 0);
		return;
	}
	resumePendingOnlineAction();
}

export function startOfficialRandomBattle(parentElem?: HTMLElement | null) {
	prepareOnlineAction({ type: 'search' }, parentElem);
}

export function challengeOfficialPlayer(username: string, parentElem?: HTMLElement | null) {
	const cleaned = username.replace(/[|,;]+/g, '').trim();
	if (!toID(cleaned)) {
		PS.alert('请输入有效的对手昵称。', { parentElem: parentElem || undefined });
		return;
	}
	if (toID(cleaned) === PS.user.userid) {
		PS.alert('不能挑战自己。', { parentElem: parentElem || undefined });
		return;
	}
	prepareOnlineAction({ type: 'challenge', username: cleaned }, parentElem);
}

export function resumePendingOnlineAction() {
	if (!PokemonAIApp.isOnline() || !PS.user.named || PS.isOffline) return;
	let action: OnlineAction | null = null;
	try {
		action = JSON.parse(localStorage.getItem(PENDING_ONLINE_KEY) || 'null');
	} catch {}
	if (!action || (action.type !== 'search' && action.type !== 'challenge')) return;
	localStorage.removeItem(PENDING_ONLINE_KEY);
	sendOnlineAction(action);
}

export function switchPokemonAIMode(mode: AppMode, parentElem?: HTMLElement | null) {
	if (mode === PokemonAIApp.mode) return;
	const activeBattle = getActivePlayerBattle();
	if (!activeBattle) {
		PokemonAIApp.navigateToMode(mode);
		return;
	}
	setTimeout(() => {
		PS.confirm('当前对战尚未结束。投降并切换模式吗？', {
			okButton: '投降并切换', cancelButton: '继续对战', parentElem: parentElem || undefined,
		}).then(confirmed => {
			if (!confirmed) return;
			activeBattle.send('/forfeit');
			setTimeout(() => PokemonAIApp.navigateToMode(mode), 250);
		});
	}, 0);
}

export function showPokemonAIOrientationTip() {
	if (localStorage.getItem(PokemonAIApp.storageKeys.orientationTipSeen)) return;
	if (!matchMedia('(orientation: portrait)').matches || Math.max(innerWidth, innerHeight) > 1000) return;
	localStorage.setItem(PokemonAIApp.storageKeys.orientationTipSeen, '1');
	PS.alert('横置手机可以获得更宽的战场和更大的招式按钮。', { okButton: '知道了' });
}
