import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {enumerateLegalActions, getFormatPack, showdownFormat} from '../packages/pokemonai-engine/dist/src/index.js';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function protocolFrames(data) {
  const value = String(data);
  return value.startsWith('a[') ? JSON.parse(value.slice(1)) : [value];
}

async function main() {
  const root = path.resolve(option('--project-root', '.'));
  const formatId = option('--format-id');
  const opponent = option('--opponent');
  const opponentId = option('--opponent-id');
  const websocketUrl = option('--showdown', 'ws://127.0.0.1:8000/showdown/websocket');
  const controlUrl = option('--control', 'http://127.0.0.1:8080');
  const aiTeamMode = option('--ai-team-mode', 'popular-random');
  const fixedTeamId = option('--fixed-team-id', '');
  const timeoutMs = Number(option('--timeout-ms', '120000'));
  const maxRequests = Number(option('--max-requests', '0'));
  if (!formatId || !opponent || !opponentId) {
    throw new Error('Required: --format-id ID --opponent USERNAME --opponent-id ID');
  }

  const pack = getFormatPack(formatId);
  const index = JSON.parse(await fs.readFile(path.join(root, 'var', 'generated', 'team-library', 'index.json'), 'utf8'));
  const teams = index.teams.filter(item => item.format_id === formatId && !String(item.validation_status).startsWith('invalid'));
  const teamIndex = Number(option('--team-index', '0'));
  const team = teams[((teamIndex % teams.length) + teams.length) % teams.length];
  if (!team) throw new Error(`No valid integration team for ${formatId}`);

  const username = option('--username', `Verify${process.pid}`).slice(0, 18);
  const presetResponse = await fetch(new URL('/api/ai/battle-presets', controlUrl), {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-PokemonAI-Control': '1'},
    body: JSON.stringify({
      challenger: username,
      opponentId,
      formatId,
      playerTeamPacked: team.packed,
      mode: aiTeamMode,
      fixedTeamId,
      seed: Number(option('--seed', '7')),
    }),
  });
  if (!presetResponse.ok) {
    const error = await presetResponse.text();
    throw new Error(`Cannot create integration battle preset: HTTP ${presetResponse.status} ${error.slice(0, 300)}`);
  }
  const socket = new WebSocket(websocketUrl);
  let roomId = '';
  let challenged = false;
  let requests = 0;
  let turns = 0;
  let winner = '';
  let lastAction = '';
  let lastRequest = undefined;

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (roomId && socket.readyState === WebSocket.OPEN) socket.send(`${roomId}|/forfeit`);
      reject(new Error(`Integration battle timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = value => {
      clearTimeout(timer);
      resolve(value);
      socket.close();
    };
    socket.addEventListener('error', () => reject(new Error('Integration WebSocket failed')), {once: true});
    socket.addEventListener('message', event => {
      for (const frame of protocolFrames(event.data)) {
        const lines = frame.split('\n');
        if (lines[0]?.startsWith('>')) {
          roomId = lines.shift().slice(1);
        }
        for (const line of lines) {
          if (line.startsWith('|challstr|')) socket.send(`|/trn ${username},0,`);
          if (line.startsWith(`|updateuser| ${username}|1|`) && !challenged) {
            challenged = true;
            socket.send(`|/utm ${team.packed}`);
            socket.send(`|/challenge ${opponent}, ${showdownFormat(pack)}`);
          }
          if (line === '|init|battle' && roomId) socket.send(`${roomId}|/timer on`);
          if (line.startsWith('|turn|')) turns = Number(line.slice('|turn|'.length)) || turns;
          if (line.startsWith('|error|')) {
            clearTimeout(timer);
            if (roomId && socket.readyState === WebSocket.OPEN) socket.send(`${roomId}|/forfeit`);
            reject(new Error(
              `Showdown rejected integration action ${lastAction}: ${line.slice('|error|'.length)} ` +
              `(forceSwitch=${JSON.stringify(lastRequest?.forceSwitch ?? null)})`
            ));
            socket.close();
          }
          if (line.startsWith('|request|') && line !== '|request|null') {
            const request = JSON.parse(line.slice('|request|'.length));
            if (request.wait) continue;
            const actions = enumerateLegalActions(request, pack);
            const action = actions.find(candidate =>
              candidate.commands.length > 0 &&
              candidate.commands.every(command => command.kind !== 'switch') &&
              !candidate.tags.includes('protect') &&
              !candidate.tags.includes('status-move')
            ) ?? actions[0];
            if (!action) throw new Error('Integration client received a request without a legal action');
            requests += 1;
            lastAction = action.showdown;
            lastRequest = request;
            socket.send(`${roomId}|/choose ${action.showdown}|${request.rqid ?? 0}`);
            if (maxRequests > 0 && requests >= maxRequests) socket.send(`${roomId}|/forfeit`);
          }
          if (line.startsWith('|win|')) {
            winner = line.slice('|win|'.length);
            finish({formatId, roomId, winner, requests, turns});
          } else if (line === '|tie|') {
            finish({formatId, roomId, winner: 'tie', requests, turns});
          }
        }
      }
    });
  });
  console.log(JSON.stringify(result));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
