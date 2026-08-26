import {appendFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {DecisionTrace} from '@pokemonai/engine';

export class TraceWriter {
  constructor(private readonly directory: string, private readonly agentId: string) {}

  async write(trace: DecisionTrace): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    const record = {
      schema: 'pokemonai-decision-trace',
      recordedAt: new Date().toISOString(),
      ...trace,
    };
    await appendFile(path.join(this.directory, `${this.agentId}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
  }
}
