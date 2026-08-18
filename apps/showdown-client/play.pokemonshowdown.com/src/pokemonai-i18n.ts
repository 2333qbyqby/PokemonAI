import { toID } from './battle-dex';
import { PokemonAIZhHansData } from './pokemonai-zh-hans-data';

export type PokemonAITermKind = 'pokemon' | 'moves' | 'abilities' | 'items' | 'types';

const STATUS_NAMES: Record<string, string> = {
	brn: '灼伤', par: '麻痹', slp: '睡眠', frz: '冰冻', psn: '中毒', tox: '剧毒', fnt: '濒死',
};

export function pokemonAITerm(kind: PokemonAITermKind, englishName: string): string {
	const id = toID(englishName);
	return PokemonAIZhHansData[kind][id] || englishName;
}

export function pokemonAIAnyTerm(englishName: string): string {
	const id = toID(englishName);
	return PokemonAIZhHansData.pokemon[id] || PokemonAIZhHansData.moves[id] ||
		PokemonAIZhHansData.abilities[id] || PokemonAIZhHansData.items[id] ||
		PokemonAIZhHansData.types[id] || STATUS_NAMES[id] || englishName;
}

export function pokemonAITypeName(englishName: string): string {
	return pokemonAITerm('types', englishName);
}
