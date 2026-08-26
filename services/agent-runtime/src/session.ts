import {
  BeliefEngine,
  buildGamePlan,
  buildTeamProfile,
  enumerateLegalActions,
  getFormatPack,
  hashString,
  HeuristicPolicy,
  MetaOpponentModel,
  ObservationReducer,
  RobustSearchPolicy,
  validateAction,
  type BattleEvent,
  type BeliefState,
  type MetaEvidence,
  type ShowdownRequest,
  type SideId,
  type TurnSimulator,
} from '@pokemonai/engine';
import type {RuntimeConfig, RuntimeTeam} from './config.js';
import {TraceWriter} from './trace.js';
import {ShowdownData} from './showdown-data.js';
import {ShowdownParticleFactory} from './particle-factory.js';

export interface BattleSender {
  send(roomId: string, command: string): void;
}

export class BattleSession {
  private perspective?: SideId;
  private reducer?: ObservationReducer;
  private request?: ShowdownRequest;
  private belief?: BeliefState;
  private readonly pendingEvents: BattleEvent[] = [];
  private deciding = false;
  private readonly showdownData: ShowdownData;
  private readonly particleFactory: ShowdownParticleFactory;

  constructor(
    private readonly roomId: string,
    private readonly config: RuntimeConfig,
    private readonly team: RuntimeTeam,
    private readonly meta: MetaEvidence,
    private readonly sender: BattleSender,
    private readonly simulator: TurnSimulator,
    private readonly traceWriter: TraceWriter,
  ) {
    this.belief = undefined;
    this.showdownData = new ShowdownData(config.projectRoot);
    this.particleFactory = new ShowdownParticleFactory(config, team);
  }

  ingest(lines: readonly string[]): void {
    for (const line of lines) {
      if (line.startsWith('|error|')) {
        console.error(`[${this.roomId}] Showdown rejected a command: ${line.slice('|error|'.length)}`);
        continue;
      }
      if (line.startsWith('|player|')) {
        this.ingestPlayer(line);
        continue;
      }
      if (!this.reducer || line.startsWith('|request|')) continue;
      this.pendingEvents.push(...this.reducer.ingest(line));
    }
    const requestLine = [...lines].reverse().find(line => line.startsWith('|request|'));
    if (!requestLine || requestLine === '|request|null') return;
    try {
      this.request = this.showdownData.enrichRequest(JSON.parse(requestLine.slice('|request|'.length)) as ShowdownRequest);
      void this.decide();
    } catch (error) {
      console.error(`[${this.roomId}] invalid request`, error);
    }
  }

  private ingestPlayer(line: string): void {
    const [, , side, username] = line.split('|');
    if ((side === 'p1' || side === 'p2') && normalizeUser(username ?? '') === normalizeUser(this.config.username)) {
      this.perspective = side;
      this.reducer ??= new ObservationReducer(this.roomId, this.config.formatId, side);
    }
    if (this.reducer) this.pendingEvents.push(...this.reducer.ingest(line));
  }

  private async decide(): Promise<void> {
    if (this.deciding || !this.request || !this.reducer || !this.perspective || this.request.wait) return;
    this.deciding = true;
    const request = this.request;
    try {
      const format = getFormatPack(this.config.formatId);
      const enumerated = enumerateLegalActions(request, format);
      if (!enumerated.length) return;
      const observation = this.reducer.snapshot(
        request.rqid ?? 0,
        request.forceSwitch?.some(Boolean) ?? false,
        request.teamPreview ?? false,
      );
      const legalActions = this.showdownData.annotateActions(request, observation, enumerated);
      const beliefEngine = new BeliefEngine();
      this.belief = this.belief
        ? beliefEngine.update(this.belief, observation, this.pendingEvents, this.meta)
        : beliefEngine.initialize(observation, this.meta);
      const seed = hashString(`${this.config.seed}:${this.roomId}:${observation.historyHash}`);
      const teamProfile = buildTeamProfile(this.showdownData.enrichTeamProfile(this.team.profile), format);
      const gamePlan = buildGamePlan(teamProfile, observation, this.meta.speciesProfiles);
      const policy = new RobustSearchPolicy(new HeuristicPolicy(), new MetaOpponentModel(this.meta), undefined, this.simulator);
      const budget = format.searchProfile.decisionBudgetMs;
      const sampledParticles = beliefEngine.particles(this.belief, format.searchProfile.maxParticles, seed);
      const context = {
        observation,
        events: this.pendingEvents.splice(0),
        legalActions,
        belief: this.belief,
        particles: this.particleFactory.materialize(sampledParticles, this.belief, observation),
        teamProfile,
        gamePlan,
        format,
        metaSourceUpdatedAt: this.meta.sourceUpdatedAt,
        metaPublishedAt: this.meta.publishedAt,
        seed,
        deadlineMs: performance.now() + budget,
      };
      const {action, trace} = await policy.decide(context);
      if (this.request !== request) return;
      const selected = validateAction(action, request, format) ? action : legalActions[0]!;
      const finalTrace = selected === action ? trace : {
        ...trace,
        selectedActionId: selected.id,
        fallback: 'highest-legal' as const,
        reasonCodes: [...trace.reasonCodes, 'request-validation-fallback'],
      };
      this.sender.send(this.roomId, `/choose ${selected.showdown}|${request.rqid ?? 0}`);
      await this.traceWriter.write(finalTrace).catch(error => console.error(`[${this.roomId}] trace write failed`, error));
    } catch (error) {
      console.error(`[${this.roomId}] decision failed`, error);
      const format = getFormatPack(this.config.formatId);
      const legal = enumerateLegalActions(request, format);
      if (legal[0] && this.request === request) this.sender.send(this.roomId, `/choose ${legal[0].showdown}|${request.rqid ?? 0}`);
    } finally {
      this.deciding = false;
      if (this.request !== request) queueMicrotask(() => void this.decide());
    }
  }
}

function normalizeUser(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
