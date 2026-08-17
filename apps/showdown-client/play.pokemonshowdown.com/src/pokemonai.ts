import { toID } from './battle-dex';
import { PS, type RoomID } from './client-main';
import { PokemonAIConfig, type PokemonAIOpponent } from './pokemonai-config';

const PENDING_KEY = 'pokemonai-pending-opponent';

export function rememberPokemonAIChallenge(opponent: PokemonAIOpponent) {
	localStorage.setItem(PENDING_KEY, opponent.id);
}

export function findPokemonAIOpponent(idOrUsername: string): PokemonAIOpponent | undefined {
	const id = toID(idOrUsername);
	return PokemonAIConfig.opponents.find(opponent => opponent.id === id || toID(opponent.username) === id);
}

export function buildPokemonAIChallengeCommand(opponent: PokemonAIOpponent): string {
	return `/challenge ${opponent.username}, ${PokemonAIConfig.format}`;
}

export function buildPokemonAIRematchCommand(opponent: PokemonAIOpponent): string {
	return `/closeand ${buildPokemonAIChallengeCommand(opponent)}`;
}

export function challengePokemonAI(opponent: PokemonAIOpponent, parentElem?: HTMLElement | null) {
	if (PS.isOffline) {
		PS.alert('尚未连接到对战服务器，请稍后重试。', { parentElem: parentElem || undefined });
		return;
	}
	rememberPokemonAIChallenge(opponent);
	if (!PS.user.named) {
		PS.join('login' as RoomID, { parentElem: parentElem || undefined });
		return;
	}
	resumePendingPokemonAIChallenge();
}

export function resumePendingPokemonAIChallenge() {
	if (!PS.user.named || PS.isOffline) return;
	const opponent = findPokemonAIOpponent(localStorage.getItem(PENDING_KEY) || '');
	if (!opponent) return;
	localStorage.removeItem(PENDING_KEY);
	PS.mainmenu.lastChallenged = Date.now();
	PS.requestNotifications();
	PS.send('/utm ');
	PS.send(buildPokemonAIChallengeCommand(opponent));
}
