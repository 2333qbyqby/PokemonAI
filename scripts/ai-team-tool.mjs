import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {RandomChampionsTeams} = require('../vendor/pokemon-showdown/dist/data/random-battles/champions/teams.js');
const {Dex, TeamValidator, Teams} = require('../vendor/pokemon-showdown/dist/sim/index.js');

const FORMATS = {
	'champions-ranked-doubles': 'gen9championsvgc2026regmb',
	'champions-ranked-singles': 'gen9championsbssregmb',
	'champions-ou': 'gen9championsou',
};

const RANDOM_FORMATS = {
	'champions-ranked-doubles': 'gen9championsvgc2026regmb',
	'champions-ranked-singles': 'gen9championsbssregmb',
	'champions-ou': 'gen9championsrandombattle',
};

const ITEM_FALLBACKS = [
	'Sitrus Berry', 'Lum Berry', 'Focus Sash', 'Life Orb', 'Leftovers', 'Choice Scarf',
	'Choice Band', 'Choice Specs', 'Assault Vest', 'Expert Belt', 'Clear Amulet',
	'Covert Cloak', 'Safety Goggles', 'Mental Herb', 'White Herb', 'Rocky Helmet',
	'Weakness Policy', 'Eject Pack', 'Booster Energy', 'Air Balloon',
];

function toId(value) {
	return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function seedWords(seed, salt = 0) {
	let value = (Number(seed) + Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
	const words = [];
	for (let index = 0; index < 4; index++) {
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		words.push(value >>> 0);
	}
	return words;
}

function targetFormat(formatId) {
	const format = FORMATS[formatId];
	if (!format) throw new Error(`Unsupported format: ${formatId}`);
	return format;
}

function repairItems(team) {
	const used = new Set();
	for (const set of team) {
		const item = Dex.items.get(set.item);
		if (!item.exists || !used.has(item.id)) {
			if (item.exists) used.add(item.id);
			continue;
		}
		if (item.megaStone) continue;
		const replacement = ITEM_FALLBACKS.map(name => Dex.items.get(name)).find(candidate => (
			candidate.exists && !used.has(candidate.id)
		));
		if (replacement) {
			set.item = replacement.name;
			used.add(replacement.id);
		}
	}
	return team;
}

function validatePacked(formatId, packedTeam) {
	const team = Teams.unpack(String(packedTeam || ''));
	if (!team?.length) return {valid: false, errors: ['Team is empty or malformed.']};
	const errors = new TeamValidator(targetFormat(formatId)).validateTeam(team) || [];
	return {valid: !errors.length, errors};
}

function teamProfile(packedTeam) {
	return (Teams.unpack(String(packedTeam || '')) || []).map(set => ({
		species: set.species,
		moves: [...(set.moves || [])],
		...(set.item ? {item: set.item} : {}),
		...(set.ability ? {ability: set.ability} : {}),
	}));
}

function generateRandom(formatId, seed) {
	const validator = new TeamValidator(targetFormat(formatId));
	const generatorFormat = RANDOM_FORMATS[formatId];
	for (let attempt = 0; attempt < 256; attempt++) {
		try {
			const generator = new RandomChampionsTeams(generatorFormat, seedWords(seed, attempt));
			const team = repairItems(generator.randomTeam());
			const errors = validator.validateTeam(team);
			if (!errors) return {
				packedTeam: Teams.pack(team), roster: team.map(set => set.species),
				profile: team.map(set => ({species: set.species, moves: [...set.moves], item: set.item, ability: set.ability})),
			};
		} catch {}
	}
	throw new Error(`Unable to generate a legal random team for ${formatId}`);
}

function trackTeamDetails(details, set) {
	if (set.ability === 'Drizzle' || set.moves.includes('raindance')) details.rain = 1;
	if (set.ability === 'Drought' || set.moves.includes('sunnyday')) details.sun = 1;
	if (set.ability === 'Sand Stream') details.sand = 1;
	if (set.ability === 'Snow Warning' || set.moves.some(move => ['snowscape', 'chillyreception'].includes(move))) details.snow = 1;
	if (set.moves.includes('stealthrock') || set.moves.includes('stoneaxe')) details.stealthRock = 1;
	if (set.moves.includes('spikes') || set.moves.includes('ceaselessedge')) details.spikes = 1;
	if (set.moves.includes('defog')) details.defog = 1;
	if (set.moves.includes('rapidspin') || set.moves.includes('mortalspin')) details.rapidSpin = 1;
}

function materializeRoster(formatId, roster, seed) {
	if (!Array.isArray(roster) || roster.length !== 6) throw new Error('A roster must contain exactly six species.');
	const format = targetFormat(formatId);
	const validator = new TeamValidator(format);
	const isDoubles = formatId === 'champions-ranked-doubles';
	for (let attempt = 0; attempt < 256; attempt++) {
		try {
			const generator = new RandomChampionsTeams(format, seedWords(seed, attempt));
			const details = {};
			const team = roster.map((name, index) => {
				const species = Dex.species.get(name);
				if (!species.exists) throw new Error(`Unknown species: ${name}`);
				const set = generator.randomSet(species, details, index === 0, isDoubles);
				trackTeamDetails(details, set);
				return set;
			});
			repairItems(team);
			const errors = validator.validateTeam(team);
			if (!errors) return {
				packedTeam: Teams.pack(team), roster: team.map(set => set.species),
				profile: team.map(set => ({species: set.species, moves: [...set.moves], item: set.item, ability: set.ability})),
			};
		} catch {}
	}
	throw new Error(`Unable to materialize a legal roster for ${formatId}`);
}

function offensiveScore(attacker, defender) {
	const defenderSpecies = Dex.species.get(defender.species);
	let best = 0;
	for (const moveName of attacker.moves || []) {
		const move = Dex.moves.get(moveName);
		if (!move.exists || move.category === 'Status' || !move.basePower) continue;
		const effectiveness = Dex.getEffectiveness(move.type, defenderSpecies);
		const stab = Dex.species.get(attacker.species).types.includes(move.type) ? 1.5 : 1;
		const score = move.basePower * stab * (effectiveness >= 0 ? 2 ** effectiveness : 1 / (2 ** -effectiveness));
		best = Math.max(best, score);
	}
	return best;
}

function matchupScore(candidatePacked, playerPacked) {
	const candidate = Teams.unpack(candidatePacked) || [];
	const player = Teams.unpack(playerPacked) || [];
	if (!candidate.length || !player.length) return Number.NEGATIVE_INFINITY;
	const ownPressure = player.reduce((sum, defender) => (
		sum + Math.max(...candidate.map(attacker => offensiveScore(attacker, defender)), 0)
	), 0) / player.length;
	const incomingPressure = candidate.reduce((sum, defender) => (
		sum + Math.max(...player.map(attacker => offensiveScore(attacker, defender)), 0)
	), 0) / candidate.length;
	const ownSpeed = candidate.reduce((sum, set) => sum + Dex.species.get(set.species).baseStats.spe, 0);
	const playerSpeed = player.reduce((sum, set) => sum + Dex.species.get(set.species).baseStats.spe, 0);
	const utility = candidate.flatMap(set => set.moves || []).reduce((score, move) => (
		score + Number(['tailwind', 'trickroom', 'stealthrock', 'spikes', 'rapidspin', 'defog', 'fakeout', 'followme', 'ragepowder'].includes(toId(move))) * 8
	), 0);
	return ownPressure - incomingPressure + (ownSpeed - playerSpeed) * 0.08 + utility;
}

async function readInput() {
	let text = '';
	for await (const chunk of process.stdin) text += chunk;
	return JSON.parse(text || '{}');
}

const input = await readInput();
let result;
if (input.operation === 'validate') {
	result = validatePacked(input.formatId, input.packedTeam);
} else if (input.operation === 'random') {
	result = generateRandom(input.formatId, input.seed);
} else if (input.operation === 'materialize') {
	result = {
		teams: (input.requests || []).map(request => {
			try {
				return {id: request.id, ...materializeRoster(request.formatId, request.roster, request.seed)};
			} catch (error) {
				return {id: request.id, error: String(error?.message || error)};
			}
		}),
	};
} else if (input.operation === 'score') {
	result = {
		scores: (input.candidates || []).map(candidate => ({
			id: candidate.id,
			score: matchupScore(candidate.packedTeam, input.playerTeamPacked),
		})).sort((left, right) => right.score - left.score),
	};
} else if (input.operation === 'inspect') {
	result = {teams: (input.teams || []).map(team => ({id: team.id, profile: teamProfile(team.packedTeam)}))};
} else {
	throw new Error(`Unsupported operation: ${input.operation}`);
}

process.stdout.write(JSON.stringify(result));
