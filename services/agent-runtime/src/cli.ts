import path from 'node:path';
import {getFormatPack, showdownFormat} from '@pokemonai/engine';
import {loadRuntimeConfig, loadTeams} from './config.js';
import {ShowdownTransport} from './showdown-transport.js';
import {writeStatus} from './status.js';
import {TraceWriter} from './trace.js';
import {ShowdownWorkerPool} from './worker-pool.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1]!;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!['doctor', 'serve'].includes(command ?? '')) throw new Error('Usage: cli.js <doctor|serve> --config FILE');
  const config = await loadRuntimeConfig(argument('--config'));
  const pack = getFormatPack(config.formatId);
  if (config.format !== showdownFormat(pack)) throw new Error(`Runtime format does not match Format Pack: ${config.format}`);
  const teams = await loadTeams(config);
  const showdownModule = path.join(config.projectRoot, 'vendor', 'pokemon-showdown', 'dist', 'sim', 'index.js');
  const workers = new ShowdownWorkerPool(showdownModule, Math.min(pack.searchProfile.maxWorkers, Math.max(1, navigator.hardwareConcurrency || 1)));
  if (command === 'doctor') {
    console.log(JSON.stringify({backend: 'agent-runtime/strong', status: 'ok', format: pack.id, teams: teams.length}));
    await workers.close();
    return;
  }
  const abort = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => abort.abort(new Error(event)));
  await writeStatus(config.status, 'starting');
  try {
    const transport = new ShowdownTransport(
      config,
      workers,
      new TraceWriter(config.logs, config.id),
      () => writeStatus(config.status, 'ready', 'connected'),
    );
    await transport.run(abort.signal);
  } catch (error) {
    await writeStatus(config.status, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await workers.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
