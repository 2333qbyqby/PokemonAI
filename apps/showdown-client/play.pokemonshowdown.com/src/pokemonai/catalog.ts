import {
	PokemonAIConfig, type PokemonAIFormat, type PokemonAIOpponent,
} from '../pokemonai-config';

interface RuntimeCatalog {
	formats: PokemonAIFormat[];
	opponents: PokemonAIOpponent[];
}

function isCatalog(value: unknown): value is RuntimeCatalog {
	if (!value || typeof value !== 'object') return false;
	const catalog = value as Partial<RuntimeCatalog>;
	return Array.isArray(catalog.formats) && Array.isArray(catalog.opponents);
}

/** Load the private runtime view. The generated config remains the offline fallback. */
export async function loadPokemonAIRuntimeCatalog(attempt = 0) {
	try {
		const response = await fetch('/runtime/catalog.json', {cache: 'no-store'});
		if (!response.ok) return false;
		const catalog: unknown = await response.json();
		if (!isCatalog(catalog)) return false;
		PokemonAIConfig.formats.splice(0, PokemonAIConfig.formats.length, ...catalog.formats);
		PokemonAIConfig.opponents.splice(0, PokemonAIConfig.opponents.length, ...catalog.opponents);
		window.dispatchEvent(new CustomEvent('pokemonai-catalog-ready'));
		if (attempt < 20 && catalog.opponents.some(item => item.availability !== 'ready')) {
			setTimeout(() => void loadPokemonAIRuntimeCatalog(attempt + 1), 1500);
		}
		return true;
	} catch {
		return false;
	}
}

void loadPokemonAIRuntimeCatalog();
