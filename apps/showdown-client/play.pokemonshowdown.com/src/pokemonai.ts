import { toID } from './battle-dex';
import { PS, type RoomID, type Team } from './client-main';
import {
	PokemonAIConfig, type PokemonAIFormat, type PokemonAIOpponent,
} from './pokemonai-config';

const PENDING_KEY = 'pokemonai-pending-challenge';
const LEGACY_PENDING_KEY = 'pokemonai-pending-opponent';
const LAST_TEAM_PREFIX = 'pokemonai-last-team-';
const LAST_TEAM_NAME_PREFIX = 'pokemonai-last-team-name-';

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
		PS.join('login' as RoomID, { parentElem: parentElem || undefined });
		return true;
	}
	resumePendingPokemonAIChallenge();
	return true;
}

export function resumePendingPokemonAIChallenge() {
	if (!PS.user.named || PS.isOffline) return;
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
