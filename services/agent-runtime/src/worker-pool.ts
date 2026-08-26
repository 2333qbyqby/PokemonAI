import path from 'node:path';
import {Worker} from 'node:worker_threads';
import type {DecisionContext, LegalSideAction, TurnSimulationResult, TurnSimulator, WorldParticle} from '@pokemonai/engine';

interface Pending {
  readonly resolve: (value: TurnSimulationResult) => void;
  readonly reject: (error: Error) => void;
}

export class ShowdownWorkerPool implements TurnSimulator {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextWorker = 0;
  private nextTask = 1;

  constructor(showdownModule: string, size: number) {
    const workerFile = new URL('./showdown-worker.js', import.meta.url);
    for (let index = 0; index < Math.max(1, size); index += 1) {
      const worker = new Worker(workerFile, {workerData: {showdownModule: path.resolve(showdownModule)}});
      worker.on('message', (message: {id: number; value?: number; terminal?: boolean; nextState?: string; expandedNodes?: number; error?: string}) => {
        const task = this.pending.get(message.id);
        if (!task) return;
        this.pending.delete(message.id);
        if (message.error) task.reject(new Error(message.error));
        else task.resolve({
          value: message.value ?? 0,
          terminal: message.terminal ?? false,
          ...(message.nextState ? {nextState: message.nextState} : {}),
          ...(message.expandedNodes === undefined ? {} : {expandedNodes: message.expandedNodes}),
        });
      });
      worker.on('error', error => this.rejectWorkerTasks(error));
      this.workers.push(worker);
    }
  }

  async simulate(particle: WorldParticle, ownAction: LegalSideAction, opponentAction: LegalSideAction, context: DecisionContext): Promise<TurnSimulationResult> {
    if (!particle.simulatorState) return this.fallback(particle, ownAction, opponentAction);
    const worker = this.workers[this.nextWorker++ % this.workers.length]!;
    const id = this.nextTask++;
    return new Promise<TurnSimulationResult>((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      worker.postMessage({
        id, mode: 'turn', state: particle.simulatorState, perspective: context.observation.perspective,
        ownAction: ownAction.showdown, opponentAction: opponentAction.showdown,
      });
    });
  }

  async simulateContinuation(state: string, context: DecisionContext): Promise<TurnSimulationResult> {
    const worker = this.workers[this.nextWorker++ % this.workers.length]!;
    const id = this.nextTask++;
    return new Promise<TurnSimulationResult>((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      worker.postMessage({
        id, mode: 'continuation', state, perspective: context.observation.perspective,
        formatId: context.format.id,
      });
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map(worker => worker.terminate()));
  }

  private fallback(particle: WorldParticle, ownAction: LegalSideAction, opponentAction: LegalSideAction): TurnSimulationResult {
    const own = ownAction.tags.includes('move') ? 0.25 : ownAction.tags.includes('switch') ? 0.08 : 0.02;
    const opponent = opponentAction.tags.includes('move') ? 0.25 : 0.06;
    const noise = ((particle.seed ^ ownAction.id.length ^ opponentAction.id.length) % 97) / 1000;
    return {value: own - opponent + noise, terminal: false};
  }

  private rejectWorkerTasks(error: Error): void {
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }
}
