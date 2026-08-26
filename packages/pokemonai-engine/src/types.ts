export type FormatId =
  | 'champions-ranked-doubles'
  | 'champions-ranked-singles'
  | 'champions-ou';

export type GameType = 'singles' | 'doubles';
export type SideId = 'p1' | 'p2';

export interface SearchProfile {
  readonly decisionBudgetMs: number;
  readonly returnReserveMs: number;
  readonly maxNodes: number;
  readonly maxParticles: number;
  readonly maxWorkers: number;
  readonly ownActionLimit: number;
  readonly opponentActionLimit: number;
  readonly secondTurnBudgetRatio: number;
}

export interface FormatPack {
  readonly id: FormatId;
  readonly label: string;
  readonly mechanics: 'champions';
  readonly regulation: string;
  readonly baseShowdownFormat: string;
  readonly customRules: readonly string[];
  readonly gameType: GameType;
  readonly rosterSize: 6;
  readonly bringSize: 3 | 4 | 6;
  readonly activeSlots: 1 | 2;
  readonly teamPreview: true;
  readonly openTeamSheets: false;
  readonly levelRule: string;
  readonly metaBindings: readonly string[];
  readonly policyFamily: 'ranked-doubles' | 'ranked-singles' | 'ou-singles';
  readonly searchProfile: SearchProfile;
}

export interface PublicPokemonState {
  readonly ident: string;
  readonly species: string;
  readonly details?: string;
  readonly condition?: string;
  readonly active: boolean;
  readonly fainted: boolean;
  readonly revealedMoves: readonly string[];
  readonly revealedItem?: string;
  readonly itemConsumed: boolean;
  readonly revealedAbility?: string;
  readonly teraType?: string;
  readonly status?: string;
  readonly boosts: Readonly<Record<string, number>>;
}

export interface PublicSideState {
  readonly id: SideId;
  readonly name?: string;
  readonly pokemon: readonly PublicPokemonState[];
  readonly sideConditions: Readonly<Record<string, number>>;
  readonly teraUsed: boolean;
}

export interface BattleObservation {
  readonly battleId: string;
  readonly formatId: FormatId;
  readonly perspective: SideId;
  readonly turn: number;
  readonly requestId: number;
  readonly forceSwitch: boolean;
  readonly teamPreview: boolean;
  readonly weather?: string;
  readonly terrain?: string;
  readonly pseudoWeather: readonly string[];
  readonly sides: Readonly<Record<SideId, PublicSideState>>;
  readonly historyHash: string;
}

export type BattleEvent =
  | {readonly type: 'team-preview'; readonly side: SideId; readonly species: readonly string[]}
  | {readonly type: 'turn'; readonly turn: number}
  | {readonly type: 'move'; readonly side: SideId; readonly actor: string; readonly move: string; readonly target?: string}
  | {readonly type: 'switch'; readonly side: SideId; readonly actor: string; readonly details: string; readonly condition: string}
  | {
    readonly type: 'damage';
    readonly target: string;
    readonly condition: string;
    readonly source?: string;
    readonly previousCondition?: string;
    readonly fractionLost?: number;
  }
  | {readonly type: 'heal'; readonly target: string; readonly condition: string; readonly source?: string}
  | {readonly type: 'item'; readonly target: string; readonly item: string; readonly consumed: boolean}
  | {readonly type: 'ability'; readonly target: string; readonly ability: string}
  | {readonly type: 'tera'; readonly target: string; readonly teraType: string}
  | {readonly type: 'faint'; readonly target: string}
  | {readonly type: 'field'; readonly effect: string; readonly active: boolean}
  | {readonly type: 'speed-order'; readonly faster: string; readonly slower: string; readonly context: string};

export type SlotCommand =
  | {readonly kind: 'move'; readonly slot: number; readonly target?: number; readonly tera?: boolean}
  | {readonly kind: 'switch'; readonly slot: number}
  | {readonly kind: 'pass'};

export interface LegalSideAction {
  readonly id: string;
  readonly commands: readonly SlotCommand[];
  readonly showdown: string;
  readonly tags: readonly string[];
  readonly tactical?: {
    readonly damagePressure: number;
    readonly accuracyRisk: number;
    readonly superEffectiveHits: number;
    readonly immuneHits: number;
    readonly focusFire: boolean;
  };
}

export interface SetCandidate {
  readonly id: string;
  readonly species: string;
  readonly moves: readonly string[];
  readonly item?: string;
  readonly ability?: string;
  readonly teraType?: string;
  readonly nature?: string;
  readonly statPoints?: readonly [number, number, number, number, number, number];
  readonly speed?: number;
  readonly probability: number;
  readonly source: string;
  readonly unknownTail?: boolean;
}

export interface WeightedOption {
  readonly name: string;
  readonly probability: number;
}

export interface Association {
  readonly species: string;
  readonly probability: number | null;
  readonly rank: number | null;
}

export interface StatSpread {
  readonly values: readonly [number, number, number, number, number, number];
  readonly nature: string | null;
  readonly probability: number;
}

export interface SpeedPoint {
  readonly value: number;
  readonly probability: number;
  readonly basis: 'source-joint' | 'derived-independent-marginals';
}

export interface SpeciesMetaProfile {
  readonly species: string;
  readonly usage: {readonly probability: number | null; readonly rank: number};
  readonly moves: readonly WeightedOption[];
  readonly items: readonly WeightedOption[];
  readonly abilities: readonly WeightedOption[];
  readonly natures: readonly WeightedOption[];
  readonly statSpreads: readonly StatSpread[];
  readonly speedDistribution: readonly SpeedPoint[];
  readonly teammates: readonly Association[];
  readonly counters: readonly Association[];
}

export interface TeamMetaSet {
  readonly species: string;
  readonly moves: readonly string[];
  readonly item?: string;
  readonly ability?: string;
  readonly teraType?: string;
  readonly nature?: string;
  readonly statPoints?: readonly [number, number, number, number, number, number];
}

export interface TeamMetaRecord {
  readonly id: string;
  readonly name: string;
  readonly formatId: string;
  readonly sourceKind: string;
  readonly sourceLabel: string;
  readonly sourceUrl?: string;
  readonly observedAt: string;
  readonly completeness: 'full-set' | 'roster-only' | 'partial';
  readonly roster: readonly string[];
  readonly sets: readonly TeamMetaSet[];
  readonly validationStatus: string;
  readonly usage?: {
    readonly battles: number;
    readonly wins: number;
    readonly losses: number;
    readonly winRate: number;
    readonly avgRating: number;
    readonly maxRating: number;
  };
}

export interface TeamHypothesis {
  readonly id: string;
  readonly sets: readonly SetCandidate[];
  readonly archetype: string;
  readonly probability: number;
  readonly unknownTail: boolean;
}

export interface SpeedInterval {
  readonly min: number;
  readonly max: number;
}

export interface BeliefState {
  readonly hypotheses: readonly TeamHypothesis[];
  readonly speedIntervals: Readonly<Record<string, SpeedInterval>>;
  readonly revealedResources: Readonly<Record<string, readonly string[]>>;
  readonly unknownTailMass: number;
  readonly effectiveSampleSize: number;
  readonly recovered: boolean;
}

export interface WorldParticle {
  readonly particleId: string;
  readonly hypothesisId: string;
  readonly weight: number;
  readonly seed: number;
  readonly simulatorState?: string;
}

export interface TeamRole {
  readonly species: string;
  readonly roles: readonly string[];
  readonly speedTier: 'slow' | 'mid' | 'fast';
  readonly offensivePressure: number;
  readonly defensiveValue: number;
}

export interface TeamProfile {
  readonly archetypes: readonly string[];
  readonly members: readonly TeamRole[];
  readonly speedControl: readonly string[];
  readonly boardTools: readonly string[];
  readonly winConditions: readonly string[];
}

export interface GamePlan {
  readonly preferredLead: readonly string[];
  readonly threats: readonly string[];
  readonly preserve: readonly string[];
  readonly winConditions: readonly string[];
  readonly riskPosture: 'protect-lead' | 'balanced' | 'seek-variance';
}

export interface ScoreBreakdown {
  readonly survival: number;
  readonly damage: number;
  readonly knockout: number;
  readonly speed: number;
  readonly resources: number;
  readonly position: number;
  readonly information: number;
  readonly winCondition: number;
  readonly risk: number;
  readonly formatSpecific: number;
}

export interface ActionEvaluation {
  readonly action: LegalSideAction;
  readonly score: number;
  readonly prior: number;
  readonly breakdown: ScoreBreakdown;
  readonly reasonCodes: readonly string[];
}

export interface SearchEvaluation {
  readonly action: LegalSideAction;
  readonly expectedValue: number;
  readonly lowerTailValue: number;
  readonly worstResponseValue: number;
  readonly adjustedValue: number;
  readonly sampleCount: number;
  readonly confidence95: readonly [number, number];
  readonly completedDepth: number;
}

export interface BeliefSummary {
  readonly hypothesisCount: number;
  readonly unknownTailMass: number;
  readonly effectiveSampleSize: number;
  readonly topArchetypes: readonly {readonly name: string; readonly probability: number}[];
  readonly recovered: boolean;
}

export interface DecisionTrace {
  readonly battleId: string;
  readonly turn: number;
  readonly formatId: FormatId;
  readonly metaSourceUpdatedAt: string;
  readonly metaPublishedAt: string;
  readonly observationHash: string;
  readonly seed: number;
  readonly candidates: readonly ActionEvaluation[];
  readonly belief: BeliefSummary;
  readonly search: readonly SearchEvaluation[];
  readonly selectedActionId: string;
  readonly fallback?: 'heuristic' | 'highest-legal';
  readonly reasonCodes: readonly string[];
  readonly elapsedMs: number;
}

export interface DecisionContext {
  readonly observation: BattleObservation;
  readonly events: readonly BattleEvent[];
  readonly legalActions: readonly LegalSideAction[];
  readonly belief: BeliefState;
  readonly particles: readonly WorldParticle[];
  readonly teamProfile: TeamProfile;
  readonly gamePlan: GamePlan;
  readonly format: FormatPack;
  readonly metaSourceUpdatedAt: string;
  readonly metaPublishedAt: string;
  readonly seed: number;
  readonly deadlineMs: number;
}

export interface PolicyPrior {
  evaluate(context: DecisionContext, actions: readonly LegalSideAction[]): Promise<readonly ActionEvaluation[]>;
}

export interface OpponentModel {
  distribution(context: DecisionContext, actions: readonly LegalSideAction[]): Promise<ReadonlyMap<string, number>>;
}

export interface ValueEstimator {
  evaluate(context: DecisionContext, state: unknown): Promise<number>;
}

export interface SearchPolicy {
  decide(context: DecisionContext): Promise<{readonly action: LegalSideAction; readonly trace: DecisionTrace}>;
}

export interface TransportCapabilities {
  readonly localShowdown: boolean;
  readonly officialGame: boolean;
  readonly supportsTeamPreview: boolean;
  readonly supportsClosedSheets: boolean;
}

export interface BattleTransport {
  observe(): AsyncIterable<{readonly observation: BattleObservation; readonly events: readonly BattleEvent[]; readonly legalActions: readonly LegalSideAction[]}>;
  submit(action: LegalSideAction, requestId: number): Promise<void>;
  capabilities(): TransportCapabilities;
}

/** Contract boundary only. The current application does not automate a console client. */
export interface OfficialGameTransport extends BattleTransport {
  capabilities(): TransportCapabilities & {
    readonly localShowdown: false;
    readonly officialGame: true;
    readonly supportsTeamPreview: true;
    readonly supportsClosedSheets: true;
  };
}
