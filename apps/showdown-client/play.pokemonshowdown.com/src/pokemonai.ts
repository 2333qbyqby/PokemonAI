import { toID } from './battle-dex';
import { PS, type RoomID, type Team } from './client-main';
import { PokemonAIApp, type AppMode } from './pokemonai-app';
import {
	PokemonAIConfig, type PokemonAIFormat, type PokemonAIOpponent,
} from './pokemonai-config';

const PENDING_KEY = 'pokemonai-pending-challenge';
const LEGACY_PENDING_KEY = 'pokemonai-pending-opponent';
const LAST_TEAM_PREFIX = 'pokemonai-last-team-';
const LAST_TEAM_NAME_PREFIX = 'pokemonai-last-team-name-';
const PENDING_ONLINE_KEY = 'pokemonai-pending-online-action';

function sanitizePackedTeam(packedTeam: string): string {
	return packedTeam.replace(/[\r\n]/g, '').trim();
}

interface PendingPokemonAIChallenge {
	opponentId: string;
	packedTeam: string;
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
	const packedTeam = sanitizePackedTeam(localStorage.getItem(`${LAST_TEAM_PREFIX}${formatId}`) || '');
	if (!packedTeam) return null;
	return {
		packedTeam,
		name: localStorage.getItem(`${LAST_TEAM_NAME_PREFIX}${formatId}`) || '',
	};
}

export function rememberPokemonAIChallenge(opponent: PokemonAIOpponent, packedTeam = '') {
	packedTeam = sanitizePackedTeam(packedTeam);
	const pending: PendingPokemonAIChallenge = { opponentId: opponent.id, packedTeam };
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
					opponentId: pending.opponentId,
					packedTeam: typeof pending.packedTeam === 'string' ? sanitizePackedTeam(pending.packedTeam) : '',
				};
			}
		} catch {}
	}
	const legacy = localStorage.getItem(LEGACY_PENDING_KEY);
	if (!legacy) return null;
	// Migrate the legacy pending opponent to the stable key; keep the legacy
	// entry when the migration itself fails so no pending challenge is lost.
	const migrated: PendingPokemonAIChallenge = { opponentId: legacy, packedTeam: '' };
	try {
		localStorage.setItem(PENDING_KEY, JSON.stringify(migrated));
		localStorage.removeItem(LEGACY_PENDING_KEY);
	} catch {}
	return migrated;
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
	opponent: PokemonAIOpponent, team?: Team, parentElem?: HTMLElement | null
): boolean {
	if (!PokemonAIApp.isAI()) {
		PS.alert('请先切换到 AI 训练模式。', { parentElem: parentElem || undefined });
		return false;
	}
	if (PS.isOffline) {
		PS.alert('尚未连接到对战服务器，请稍后重试。', { parentElem: parentElem || undefined });
		return false;
	}
	const format = findPokemonAIFormat(opponent.formatId);
	const remembered = getRememberedPokemonAITeam(opponent.formatId);
	const packedTeam = sanitizePackedTeam(team?.packedTeam || remembered?.packedTeam || '');
	if (team?.packedTeam) rememberPokemonAITeam(opponent.formatId, team.packedTeam, team.name);
	if (format?.requiresTeam && !packedTeam) {
		PS.alert('请在 Teambuilder 中选择队伍，或先从 PokémonAI 阵容库设定一支快速对战队伍。', {
			parentElem: parentElem || undefined,
		});
		return false;
	}
	rememberPokemonAIChallenge(opponent, packedTeam);
	if (!PS.user.named) {
		// Opening a popup synchronously from a Preact room click can be
		// overwritten by the room's own render pass on narrow layouts.
		setTimeout(() => PS.join('login' as RoomID), 0);
		return true;
	}
	resumePendingPokemonAIChallenge();
	return true;
}

export function resumePendingPokemonAIChallenge() {
	if (!PokemonAIApp.isAI() || !PS.user.named || PS.isOffline) return;
	const pending = loadPendingPokemonAIChallenge();
	if (!pending) return;
	const opponent = findPokemonAIOpponent(pending.opponentId);
	if (!opponent) return;
	localStorage.removeItem(PENDING_KEY);
	localStorage.removeItem(LEGACY_PENDING_KEY);
	PS.mainmenu.lastChallenged = Date.now();
	PS.requestNotifications();
	PS.send(`/utm ${pending.packedTeam}`);
	PS.send(buildPokemonAIChallengeCommand(opponent));
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
		setTimeout(() => PS.join('login' as RoomID), 0);
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
	const activeBattle = Object.values(PS.rooms).find(room => {
		const battleRoom = room as any;
		return room?.type === 'battle' && battleRoom.side && battleRoom.battle && !battleRoom.battle.ended;
	});
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
