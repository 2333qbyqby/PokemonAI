import {hashString} from './random.js';
import type {
  BattleEvent,
  BattleObservation,
  FormatId,
  PublicPokemonState,
  PublicSideState,
  SideId,
} from './types.js';

interface MutablePokemon {
  ident: string;
  species: string;
  details?: string;
  condition?: string;
  active: boolean;
  fainted: boolean;
  revealedMoves: Set<string>;
  revealedItem?: string;
  itemConsumed: boolean;
  revealedAbility?: string;
  teraType?: string;
  status?: string;
  boosts: Record<string, number>;
}

interface MutableSide {
  id: SideId;
  name?: string;
  pokemon: Map<string, MutablePokemon>;
  sideConditions: Record<string, number>;
  teraUsed: boolean;
}

function sideOf(value: string): SideId | undefined {
  const side = value.slice(0, 2);
  return side === 'p1' || side === 'p2' ? side : undefined;
}

function displayName(ident: string): string {
  return ident.includes(':') ? ident.slice(ident.indexOf(':') + 1).trim() : ident;
}

function speciesFromDetails(details: string): string {
  return details.split(',')[0]?.trim() || details;
}

function conditionRatio(condition?: string): number | undefined {
  if (!condition) return undefined;
  if (condition.endsWith(' fnt')) return 0;
  const [hp, maximum] = condition.split(' ')[0]!.split('/').map(Number);
  if (!Number.isFinite(hp) || !Number.isFinite(maximum) || !maximum) return undefined;
  return hp! / maximum!;
}

function freezePokemon(pokemon: MutablePokemon): PublicPokemonState {
  return Object.freeze({
    ident: pokemon.ident,
    species: pokemon.species,
    ...(pokemon.details ? {details: pokemon.details} : {}),
    ...(pokemon.condition ? {condition: pokemon.condition} : {}),
    active: pokemon.active,
    fainted: pokemon.fainted,
    revealedMoves: Object.freeze([...pokemon.revealedMoves]),
    ...(pokemon.revealedItem ? {revealedItem: pokemon.revealedItem} : {}),
    itemConsumed: pokemon.itemConsumed,
    ...(pokemon.revealedAbility ? {revealedAbility: pokemon.revealedAbility} : {}),
    ...(pokemon.teraType ? {teraType: pokemon.teraType} : {}),
    ...(pokemon.status ? {status: pokemon.status} : {}),
    boosts: Object.freeze({...pokemon.boosts}),
  });
}

function emptySide(id: SideId): MutableSide {
  return {id, pokemon: new Map(), sideConditions: {}, teraUsed: false};
}

export class ObservationReducer {
  private readonly sides: Record<SideId, MutableSide> = {p1: emptySide('p1'), p2: emptySide('p2')};
  private readonly history: string[] = [];
  private turn = 0;
  private weather?: string;
  private terrain?: string;
  private readonly pseudoWeather = new Set<string>();
  private lastMove?: {side: SideId; actor: string; move: string};

  constructor(
    private readonly battleId: string,
    private readonly formatId: FormatId,
    private readonly perspective: SideId,
  ) {}

  ingest(line: string): readonly BattleEvent[] {
    if (!line.startsWith('|')) return [];
    this.history.push(line);
    const parts = line.split('|');
    const command = parts[1] ?? '';
    const events: BattleEvent[] = [];

    if (command === 'player') {
      const side = sideOf(parts[2] ?? '');
      if (side) this.sides[side].name = parts[3];
    } else if (command === 'poke') {
      const side = sideOf(parts[2] ?? '');
      const details = parts[3] ?? '';
      if (side) {
        const species = speciesFromDetails(details);
        this.ensurePokemon(side, species, species, details);
        events.push({type: 'team-preview', side, species: [species]});
      }
    } else if (command === 'turn') {
      this.turn = Number.parseInt(parts[2] ?? '0', 10) || this.turn;
      this.lastMove = undefined;
      events.push({type: 'turn', turn: this.turn});
    } else if (command === 'switch' || command === 'drag' || command === 'replace') {
      const ident = parts[2] ?? '';
      const side = sideOf(ident);
      if (side) {
        const position = ident.slice(0, 3);
        for (const pokemon of this.sides[side].pokemon.values()) {
          if (pokemon.ident.slice(0, 3) === position) pokemon.active = false;
        }
        const details = parts[3] ?? displayName(ident);
        const pokemon = this.ensurePokemon(side, ident, speciesFromDetails(details), details);
        pokemon.active = true;
        pokemon.condition = parts[4] ?? pokemon.condition;
        events.push({type: 'switch', side, actor: ident, details, condition: parts[4] ?? ''});
      }
    } else if (command === 'move') {
      const ident = parts[2] ?? '';
      const side = sideOf(ident);
      if (side) {
        const pokemon = this.findPokemon(side, ident);
        pokemon?.revealedMoves.add(parts[3] ?? '');
        if (this.lastMove && this.lastMove.actor !== ident) {
          events.push({
            type: 'speed-order',
            faster: this.lastMove.actor,
            slower: ident,
            context: `${this.lastMove.move} before ${parts[3] ?? ''}`,
          });
        }
        events.push({type: 'move', side, actor: ident, move: parts[3] ?? '', ...(parts[4] ? {target: parts[4]} : {})});
        this.lastMove = {side, actor: ident, move: parts[3] ?? ''};
      }
    } else if (command === '-damage' || command === '-heal') {
      const ident = parts[2] ?? '';
      const side = sideOf(ident);
      const condition = parts[3] ?? '';
      let previousCondition: string | undefined;
      if (side) {
        const pokemon = this.findPokemon(side, ident);
        if (pokemon) {
          previousCondition = pokemon.condition;
          pokemon.condition = condition;
          pokemon.fainted = condition.endsWith(' fnt');
          pokemon.status = condition.split(' ')[1];
        }
      }
      const source = parts.find(value => value.startsWith('[from]'))?.slice(6).trim();
      const before = conditionRatio(previousCondition);
      const after = conditionRatio(condition);
      events.push({
        type: command === '-damage' ? 'damage' : 'heal',
        target: ident,
        condition,
        ...(source ? {source} : {}),
        ...(previousCondition ? {previousCondition} : {}),
        ...(command === '-damage' && before !== undefined && after !== undefined
          ? {fractionLost: Math.max(0, before - after)} : {}),
      });
    } else if (command === '-item' || command === '-enditem') {
      const ident = parts[2] ?? '';
      const side = sideOf(ident);
      const pokemon = side ? this.findPokemon(side, ident) : undefined;
      if (pokemon) {
        pokemon.revealedItem = parts[3] ?? pokemon.revealedItem;
        pokemon.itemConsumed = command === '-enditem';
      }
      events.push({type: 'item', target: ident, item: parts[3] ?? '', consumed: command === '-enditem'});
    } else if (command === '-ability') {
      const ident = parts[2] ?? '';
      const side = sideOf(ident);
      const pokemon = side ? this.findPokemon(side, ident) : undefined;
      if (pokemon) pokemon.revealedAbility = parts[3];
      events.push({type: 'ability', target: ident, ability: parts[3] ?? ''});
    } else if (command === '-terastallize') {
      const ident = parts[2] ?? '';
      const side = sideOf(ident);
      const pokemon = side ? this.findPokemon(side, ident) : undefined;
      if (pokemon && side) {
        pokemon.teraType = parts[3];
        this.sides[side].teraUsed = true;
      }
      events.push({type: 'tera', target: ident, teraType: parts[3] ?? ''});
    } else if (command === 'faint') {
      const ident = parts[2] ?? '';
      const side = sideOf(ident);
      const pokemon = side ? this.findPokemon(side, ident) : undefined;
      if (pokemon) {
        pokemon.fainted = true;
        pokemon.active = false;
        pokemon.condition = '0 fnt';
      }
      events.push({type: 'faint', target: ident});
    } else if (command === '-weather') {
      this.weather = parts[2] === 'none' ? undefined : parts[2];
      events.push({type: 'field', effect: parts[2] ?? '', active: parts[2] !== 'none'});
    } else if (command === '-fieldstart' || command === '-fieldend') {
      const effect = (parts[2] ?? '').replace('move: ', '');
      if (command === '-fieldstart') this.pseudoWeather.add(effect);
      else this.pseudoWeather.delete(effect);
      if (effect.toLowerCase().includes('terrain')) this.terrain = command === '-fieldstart' ? effect : undefined;
      events.push({type: 'field', effect, active: command === '-fieldstart'});
    } else if (command === '-sidestart' || command === '-sideend') {
      const side = sideOf(parts[2] ?? '');
      const effect = (parts[3] ?? '').replace('move: ', '');
      if (side) {
        if (command === '-sidestart') this.sides[side].sideConditions[effect] = (this.sides[side].sideConditions[effect] ?? 0) + 1;
        else delete this.sides[side].sideConditions[effect];
      }
    } else if (command === '-boost' || command === '-unboost' || command === '-setboost') {
      const ident = parts[2] ?? '';
      const side = sideOf(ident);
      const pokemon = side ? this.findPokemon(side, ident) : undefined;
      const stat = parts[3] ?? '';
      const amount = Number.parseInt(parts[4] ?? '0', 10) || 0;
      if (pokemon) pokemon.boosts[stat] = command === '-setboost' ? amount : (pokemon.boosts[stat] ?? 0) + (command === '-unboost' ? -amount : amount);
    }
    return events;
  }

  snapshot(requestId: number, forceSwitch: boolean, teamPreview: boolean): BattleObservation {
    const freezeSide = (side: MutableSide): PublicSideState => Object.freeze({
      id: side.id,
      ...(side.name ? {name: side.name} : {}),
      pokemon: Object.freeze([...side.pokemon.values()].map(freezePokemon)),
      sideConditions: Object.freeze({...side.sideConditions}),
      teraUsed: side.teraUsed,
    });
    return Object.freeze({
      battleId: this.battleId,
      formatId: this.formatId,
      perspective: this.perspective,
      turn: this.turn,
      requestId,
      forceSwitch,
      teamPreview,
      ...(this.weather ? {weather: this.weather} : {}),
      ...(this.terrain ? {terrain: this.terrain} : {}),
      pseudoWeather: Object.freeze([...this.pseudoWeather]),
      sides: Object.freeze({p1: freezeSide(this.sides.p1), p2: freezeSide(this.sides.p2)}),
      historyHash: hashString(this.history.join('\n')).toString(16).padStart(8, '0'),
    });
  }

  private ensurePokemon(side: SideId, ident: string, species: string, details?: string): MutablePokemon {
    const name = displayName(ident);
    const existing = this.findPokemon(side, ident) ?? this.sides[side].pokemon.get(name) ?? this.sides[side].pokemon.get(species);
    if (existing) {
      if (ident.includes(':')) existing.ident = ident;
      if (details) existing.details = details;
      return existing;
    }
    const pokemon: MutablePokemon = {
      ident,
      species,
      ...(details ? {details} : {}),
      active: false,
      fainted: false,
      revealedMoves: new Set(),
      itemConsumed: false,
      boosts: {},
    };
    this.sides[side].pokemon.set(name || species, pokemon);
    return pokemon;
  }

  private findPokemon(side: SideId, ident: string): MutablePokemon | undefined {
    const name = displayName(ident);
    return [...this.sides[side].pokemon.values()].find(pokemon => pokemon.ident === ident || displayName(pokemon.ident) === name || pokemon.species === name);
  }
}
