import type {ActionEvaluation, DecisionContext, LegalSideAction, PolicyPrior, ScoreBreakdown} from './types.js';

function zeros(): ScoreBreakdown {
  return {survival: 0, damage: 0, knockout: 0, speed: 0, resources: 0, position: 0, information: 0, winCondition: 0, risk: 0, formatSpecific: 0};
}

function hpRatio(condition?: string): number {
  if (!condition || condition.endsWith(' fnt')) return 0;
  const values = condition.split(' ')[0]!.split('/').map(Number);
  const hp = values[0] ?? Number.NaN;
  const max = values[1] ?? Number.NaN;
  return Number.isFinite(hp) && Number.isFinite(max) && max > 0 ? hp / max : 1;
}

function scoreAction(context: DecisionContext, action: LegalSideAction): ActionEvaluation {
  const breakdown = {...zeros()};
  const reasons: string[] = [];
  const tags = new Set(action.tags);
  const own = context.observation.sides[context.observation.perspective];
  const opponentId = context.observation.perspective === 'p1' ? 'p2' : 'p1';
  const opponent = context.observation.sides[opponentId];
  const active = own.pokemon.filter(pokemon => pokemon.active && !pokemon.fainted);
  const lowestActiveHp = Math.min(1, ...active.map(pokemon => hpRatio(pokemon.condition)));
  const previousOwnProtect = context.events.some(event =>
    event.type === 'move' && event.side === context.observation.perspective &&
    ['protect', 'detect', 'spikyshield', 'kingsshield'].includes(event.move.toLowerCase().replace(/[^a-z0-9]/g, ''))
  );
  if (tags.has('move')) breakdown.damage += 0.3;
  if (action.tactical) {
    breakdown.damage += Math.min(0.7, action.tactical.damagePressure * 0.18);
    breakdown.knockout += Math.min(0.35, action.tactical.superEffectiveHits * 0.12 + Number(action.tactical.focusFire) * 0.1);
    breakdown.risk -= Math.min(0.3, action.tactical.accuracyRisk * 0.25 + action.tactical.immuneHits * 0.2);
    if (action.tactical.focusFire) reasons.push('focus-fire');
    if (action.tactical.superEffectiveHits) reasons.push('super-effective-pressure');
    if (action.tactical.immuneHits) reasons.push('immunity-risk');
  }
  if (tags.has('high-power')) {
    breakdown.damage += 0.22;
    reasons.push('high-power-pressure');
  }
  if (tags.has('priority')) {
    breakdown.knockout += 0.14;
    reasons.push('priority-cleanup');
  }
  if (tags.has('status-move')) {
    breakdown.position += 0.08;
    breakdown.damage -= 0.08;
  }
  if (tags.has('low-accuracy')) breakdown.risk -= 0.14;
  if (tags.has('switch')) {
    breakdown.position += context.observation.forceSwitch ? 0.8 : 0.12;
    breakdown.risk -= context.observation.forceSwitch ? 0 : 0.08;
    reasons.push(context.observation.forceSwitch ? 'forced-switch' : 'positioning-switch');
  }
  if (tags.has('protect')) {
    breakdown.survival += 0.35;
    breakdown.information += 0.12;
    breakdown.damage -= 0.12;
    if (lowestActiveHp < 0.35) breakdown.survival += 0.2;
    if (previousOwnProtect) {
      breakdown.risk -= 0.7;
      reasons.push('consecutive-protect-risk');
    }
    if (own.pokemon.filter(pokemon => !pokemon.fainted).length === 1 && opponent.pokemon.some(pokemon => !pokemon.fainted)) {
      breakdown.risk -= 0.25;
    }
    reasons.push('protect-scout');
  }
  if (tags.has('speed-control')) {
    breakdown.speed += 0.38;
    reasons.push('speed-control');
  }
  if (tags.has('support')) breakdown.position += 0.2;
  if (tags.has('redirection') && context.format.gameType === 'doubles') breakdown.position += 0.22;
  if (tags.has('fake-out') && context.observation.turn <= 2) breakdown.position += 0.2;
  if (tags.has('pivot')) breakdown.position += 0.14;
  if (tags.has('setup')) {
    const boosted = active.some(pokemon => Object.values(pokemon.boosts).some(value => value > 0));
    breakdown.winCondition += boosted ? 0.02 : 0.2;
    breakdown.risk -= lowestActiveHp < 0.45 ? 0.18 : 0;
  }
  if (tags.has('recovery')) {
    breakdown.survival += lowestActiveHp < 0.55 ? 0.42 : -0.18;
  }
  if (tags.has('spread')) {
    breakdown.formatSpecific += context.format.gameType === 'doubles' ? 0.28 : 0;
    reasons.push('spread-pressure');
  }
  if (tags.has('tera')) {
    breakdown.resources -= 0.22;
    breakdown.damage += context.gamePlan.riskPosture === 'seek-variance' ? 0.28 : 0.12;
    reasons.push('commit-tera');
  }
  if (tags.has('team-preview')) {
    breakdown.position += 0.4;
    breakdown.formatSpecific += context.format.gameType === 'doubles' ? 0.25 : 0.12;
    const own = context.observation.sides[context.observation.perspective];
    const leadSpecies = [...tags]
      .filter(tag => tag.startsWith('lead-slot:'))
      .map(tag => own.pokemon[Number.parseInt(tag.slice('lead-slot:'.length), 10) - 1]?.species)
      .filter((species): species is string => Boolean(species));
    breakdown.winCondition += leadSpecies.filter(species => context.gamePlan.preferredLead.includes(species)).length * 0.18;
    reasons.push('preview-plan');
  }
  if (context.format.policyFamily === 'ou-singles') {
    breakdown.resources += tags.has('switch') ? 0.08 : 0;
    breakdown.formatSpecific += context.observation.turn > 20 && tags.has('move') ? 0.08 : 0;
    if (tags.has('hazard')) breakdown.formatSpecific += context.observation.turn <= 8 ? 0.34 : 0.12;
    if (tags.has('hazard-control')) {
      const hazards = Object.keys(own.sideConditions).length;
      breakdown.formatSpecific += hazards ? 0.18 + hazards * 0.12 : -0.12;
    }
  } else if (context.format.policyFamily === 'ranked-singles') {
    breakdown.formatSpecific += tags.has('switch') ? 0.06 : 0.1;
  } else {
    breakdown.formatSpecific += tags.has('protect') || tags.has('speed-control') ? 0.12 : 0;
  }
  if (context.gamePlan.riskPosture === 'protect-lead') breakdown.risk += tags.has('tera') ? -0.16 : 0.08;
  if (context.gamePlan.riskPosture === 'seek-variance') breakdown.risk += tags.has('tera') || tags.has('spread') ? 0.14 : 0;
  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return {action, score, prior: 0, breakdown, reasonCodes: reasons.length ? reasons : ['legal-pressure']};
}

export class HeuristicPolicy implements PolicyPrior {
  async evaluate(context: DecisionContext, actions: readonly LegalSideAction[]): Promise<readonly ActionEvaluation[]> {
    const evaluated = actions.map(action => scoreAction(context, action)).sort((a, b) => b.score - a.score || a.action.id.localeCompare(b.action.id));
    const max = evaluated[0]?.score ?? 0;
    const weights = evaluated.map(item => Math.exp(item.score - max));
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    return evaluated.map((item, index) => ({...item, prior: (weights[index] ?? 0) / total}));
  }
}
