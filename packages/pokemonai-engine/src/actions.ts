import type {FormatPack, LegalSideAction, SlotCommand} from './types.js';

export interface RequestMove {
  readonly id: string;
  readonly move: string;
  readonly target: string;
  readonly disabled?: boolean;
  readonly basePower?: number;
  readonly category?: 'Physical' | 'Special' | 'Status';
  readonly priority?: number;
  readonly accuracy?: number | true;
}

export interface RequestActive {
  readonly moves: readonly RequestMove[];
  readonly trapped?: boolean;
  readonly maybeTrapped?: boolean;
  readonly canTerastallize?: string;
}

export interface RequestPokemon {
  readonly ident: string;
  readonly details: string;
  readonly condition: string;
  readonly active: boolean;
  readonly fainted?: boolean;
}

export interface ShowdownRequest {
  readonly rqid?: number;
  readonly wait?: boolean;
  readonly teamPreview?: boolean;
  readonly forceSwitch?: readonly boolean[];
  readonly active?: readonly (RequestActive | null)[];
  readonly side?: {readonly pokemon: readonly RequestPokemon[]};
}

const foeTargets = [1, 2] as const;
const adjacentTargets = [-2, -1, 1, 2] as const;

function moveTargets(move: RequestMove, activeSlots: number, activeIndex: number): readonly (number | undefined)[] {
  if (activeSlots === 1) return [undefined];
  switch (move.target) {
  case 'normal':
  case 'adjacentFoe':
    return foeTargets;
  case 'adjacentAlly':
    return [activeIndex === 0 ? -2 : -1];
  case 'adjacentAllyOrSelf':
    return [-1, -2];
  case 'any':
    return [...foeTargets, activeIndex === 0 ? -2 : -1];
  default:
    return [undefined];
  }
}

function renderCommand(command: SlotCommand): string {
  if (command.kind === 'pass') return 'pass';
  if (command.kind === 'switch') return `switch ${command.slot}`;
  const target = command.target === undefined ? '' : ` ${command.target}`;
  const tera = command.tera ? ' terastallize' : '';
  return `move ${command.slot}${target}${tera}`;
}

function commandTags(command: SlotCommand, move?: RequestMove): string[] {
  if (command.kind === 'switch') return ['switch'];
  if (command.kind === 'pass') return ['pass'];
  const id = move?.id ?? '';
  const tags = ['move'];
  if (id === 'protect' || id === 'detect' || id === 'spikyshield' || id === 'kingsshield') tags.push('protect');
  if (id.includes('helpinghand')) tags.push('support');
  if (id === 'followme' || id === 'ragepowder') tags.push('support', 'redirection');
  if (id === 'fakeout') tags.push('disruption', 'fake-out');
  if (id.includes('tailwind') || id.includes('trickroom') || id.includes('icywind') || id.includes('electroweb')) tags.push('speed-control');
  if (['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'].includes(id)) tags.push('hazard');
  if (['rapidspin', 'defog', 'mortalspin', 'tidyup'].includes(id)) tags.push('hazard-control');
  if (['recover', 'roost', 'slackoff', 'synthesis', 'softboiled', 'wish', 'rest'].includes(id)) tags.push('recovery');
  if (['swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'quiverdance', 'bulkup', 'shellsmash'].includes(id)) tags.push('setup');
  if (['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport'].includes(id)) tags.push('pivot');
  if (move && ['allAdjacentFoes', 'allAdjacent'].includes(move.target)) tags.push('spread');
  if (move?.category === 'Status') tags.push('status-move');
  if ((move?.basePower ?? 0) >= 100) tags.push('high-power');
  if ((move?.priority ?? 0) > 0) tags.push('priority');
  if (move?.accuracy !== true && (move?.accuracy ?? 100) < 85) tags.push('low-accuracy');
  if (command.tera) tags.push('tera');
  return tags;
}

function slotChoices(
  request: ShowdownRequest,
  format: FormatPack,
  activeIndex: number,
  allowForcedPass: boolean,
): Array<{command: SlotCommand; tags: string[]}> {
  const forceSwitch = request.forceSwitch?.[activeIndex] ?? false;
  if (request.forceSwitch?.some(Boolean) && !forceSwitch) {
    return [{command: {kind: 'pass'}, tags: ['pass']}];
  }
  const activePokemon = request.side?.pokemon.filter(pokemon => pokemon.active)[activeIndex];
  if (!forceSwitch && activePokemon && (activePokemon.fainted || activePokemon.condition.endsWith(' fnt'))) {
    return [{command: {kind: 'pass'}, tags: ['pass']}];
  }
  const active = request.active?.[activeIndex] ?? null;
  const choices: Array<{command: SlotCommand; tags: string[]}> = [];

  if (!forceSwitch && active) {
    active.moves.forEach((move, index) => {
      if (move.disabled) return;
      for (const target of moveTargets(move, format.activeSlots, activeIndex)) {
        const command: SlotCommand = {kind: 'move', slot: index + 1, ...(target === undefined ? {} : {target})};
        choices.push({command, tags: [...commandTags(command, move), `move-id:${idForTag(move.id)}`]});
        if (active.canTerastallize) {
          const teraCommand: SlotCommand = {...command, tera: true};
          choices.push({command: teraCommand, tags: [...commandTags(teraCommand, move), `move-id:${idForTag(move.id)}`]});
        }
      }
    });
  }

  const trapped = !forceSwitch && (active?.trapped ?? false);
  if (!trapped) {
    request.side?.pokemon.forEach((pokemon, index) => {
      if (pokemon.active || pokemon.fainted || pokemon.condition.endsWith(' fnt')) return;
      const command: SlotCommand = {kind: 'switch', slot: index + 1};
      choices.push({command, tags: ['switch']});
    });
  }

  if (forceSwitch && allowForcedPass) choices.push({command: {kind: 'pass'}, tags: ['pass']});
  if (!choices.length && !forceSwitch) choices.push({command: {kind: 'pass'}, tags: ['pass']});
  return choices;
}

function idForTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function validJoint(commands: readonly SlotCommand[]): boolean {
  const switches = commands.filter((command): command is Extract<SlotCommand, {kind: 'switch'}> => command.kind === 'switch');
  if (new Set(switches.map(command => command.slot)).size !== switches.length) return false;
  if (commands.filter(command => command.kind === 'move' && command.tera).length > 1) return false;
  return true;
}

function product<T>(sets: readonly (readonly T[])[]): T[][] {
  return sets.reduce<T[][]>((rows, set) => rows.flatMap(row => set.map(item => [...row, item])), [[]]);
}

function teamPreviewActions(request: ShowdownRequest, format: FormatPack): LegalSideAction[] {
  const size = request.side?.pokemon.length ?? format.rosterSize;
  const slots = Array.from({length: size}, (_, index) => index + 1);
  const choose = (remaining: number[], count: number, prefix: number[]): number[][] => {
    if (count === 0) return [prefix];
    return remaining.flatMap((slot, index) => choose(remaining.slice(index + 1), count - 1, [...prefix, slot]));
  };
  const brought = choose(slots, format.bringSize, []);
  const actions: LegalSideAction[] = [];
  for (const team of brought) {
    const leads = format.activeSlots === 1
      ? team.map(slot => [slot])
      : team.flatMap(first => team.filter(second => second !== first).map(second => [first, second]));
    for (const lead of leads) {
      const remainder = team.filter(slot => !lead.includes(slot));
      const order = [...lead, ...remainder];
      const showdown = `team ${order.join('')}`;
      actions.push({id: showdown, commands: [], showdown, tags: ['team-preview', ...lead.map(slot => `lead-slot:${slot}`)]});
    }
  }
  return actions;
}

export function enumerateLegalActions(request: ShowdownRequest, format: FormatPack): LegalSideAction[] {
  if (request.wait) return [];
  if (request.teamPreview) return teamPreviewActions(request, format);
  const slotCount = Math.max(request.active?.length ?? 0, request.forceSwitch?.length ?? 0, format.activeSlots);
  const forcedSlots = request.forceSwitch?.filter(Boolean).length ?? 0;
  const availableSwitches = request.side?.pokemon.filter(pokemon =>
    !pokemon.active && !pokemon.fainted && !pokemon.condition.endsWith(' fnt')
  ).length ?? 0;
  const requiredForcedSwitches = Math.min(forcedSlots, availableSwitches);
  const choices = Array.from({length: slotCount}, (_, index) =>
    slotChoices(request, format, index, forcedSlots > availableSwitches)
  );
  return product(choices)
    .filter(row => validJoint(row.map(choice => choice.command)))
    .filter(row => !forcedSlots || row.filter(choice => choice.command.kind === 'switch').length === requiredForcedSwitches)
    .map(row => {
      const commands = row.map(choice => choice.command);
      const showdown = commands.map(renderCommand).join(', ');
      return {
        id: showdown,
        commands,
        showdown,
        tags: [...new Set(row.flatMap(choice => choice.tags))],
      };
    });
}

export function validateAction(action: LegalSideAction, request: ShowdownRequest, format: FormatPack): boolean {
  return enumerateLegalActions(request, format).some(candidate => candidate.showdown === action.showdown);
}
