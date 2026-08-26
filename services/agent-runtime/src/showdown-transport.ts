import {setTimeout as delay} from 'node:timers/promises';
import type {RuntimeConfig, RuntimeTeam} from './config.js';
import type {TurnSimulator} from '@pokemonai/engine';
import {BattleSession, type BattleSender} from './session.js';
import {loadMeta} from './meta.js';
import {TraceWriter} from './trace.js';

interface ChallengeUpdate {
  readonly challengesFrom?: Readonly<Record<string, string>>;
}

interface ClaimedBattlePreset {
  readonly presetId: string;
  readonly mode: string;
  readonly seed: number;
  readonly team: RuntimeTeam;
}

function unpackFrame(value: string): string[] {
  if (value === 'o' || value === 'h') return [];
  if (value.startsWith('a[')) {
    try {
      return JSON.parse(value.slice(1)) as string[];
    } catch {
      return [];
    }
  }
  return [value];
}

export function splitProtocolPayload(value: string): string[] {
  if (value.startsWith('>')) return [value];
  return value.split('\n').filter(Boolean);
}

export function parseChallengeMessage(value: string, recipient: string): {user: string; format: string} | undefined {
  const fields = value.split('|');
  if (fields[1] !== 'pm' || normalizeUser(fields[3] ?? '') !== normalizeUser(recipient)) return undefined;
  const command = fields[4] ?? '';
  if (!command.startsWith('/challenge ')) return undefined;
  const format = fields[5] || command.slice('/challenge '.length);
  const user = fields[2]?.trim();
  return user && format ? {user, format} : undefined;
}

export function parseBattleChallenger(lines: readonly string[], ownUsername: string): string | undefined {
  const ownId = normalizeUser(ownUsername);
  for (const line of lines) {
    const fields = line.split('|');
    if (fields[1] !== 'player' || !['p1', 'p2'].includes(fields[2] ?? '')) continue;
    const username = fields[3]?.trim();
    if (username && normalizeUser(username) !== ownId) return username;
  }
  return undefined;
}

export class ShowdownTransport implements BattleSender {
  private socket?: WebSocket;
  private assertion = '';
  private readonly sessions = new Map<string, BattleSession>();
  private readonly acceptedPresets = new Map<string, ClaimedBattlePreset>();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly simulator: TurnSimulator,
    private readonly traceWriter: TraceWriter,
    private readonly onReady: () => Promise<void> = async () => undefined,
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal?.aborted) {
      try {
        await this.connect(signal);
        failures = 0;
      } catch (error) {
        if (signal?.aborted) return;
        failures += 1;
        console.error('Showdown connection failed', error);
        await delay(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)), undefined, {signal}).catch(() => undefined);
      }
    }
  }

  send(roomId: string, command: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Showdown socket is not open');
    this.socket.send(`${roomId}|${command}`);
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    const socket = new WebSocket(this.config.showdown);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), {once: true});
      socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {once: true});
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('Aborted')), {once: true});
    });
    let processing = Promise.resolve();
    await new Promise<void>((_resolve, reject) => {
      socket.addEventListener('message', event => {
        processing = processing.then(async () => {
          for (const frame of unpackFrame(String(event.data))) {
            for (const payload of splitProtocolPayload(frame)) await this.handleFrame(payload);
          }
        });
        void processing.catch(reject);
      });
      socket.addEventListener('close', () => reject(new Error('WebSocket closed')));
      socket.addEventListener('error', () => reject(new Error('WebSocket error')));
      signal?.addEventListener('abort', () => {
        socket.close();
        reject(signal.reason ?? new Error('Aborted'));
      }, {once: true});
    });
  }

  private async handleFrame(frame: string): Promise<void> {
    if (frame.startsWith('|challstr|')) {
      const [, , keyId, challenge] = frame.split('|');
      await this.login(`${keyId}|${challenge}`);
      return;
    }
    if (frame.startsWith('|updateuser|')) {
      const [, , name, named] = frame.split('|');
      if (name && named === '1' && normalizeUser(name) === normalizeUser(this.config.username)) {
        if (this.assertion !== 'ready') await this.onReady();
        this.assertion = 'ready';
      }
      return;
    }
    const challenge = parseChallengeMessage(frame, this.config.username);
    if (challenge) {
      if (this.acceptedFormat(challenge.format)) await this.accept(challenge.user);
      return;
    }
    if (frame.startsWith('|updatechallenges|')) {
      const update = JSON.parse(frame.slice('|updatechallenges|'.length)) as ChallengeUpdate;
      for (const [user, format] of Object.entries(update.challengesFrom ?? {})) {
        if (this.acceptedFormat(format)) await this.accept(user);
      }
      return;
    }
    if (frame.startsWith('>')) {
      const newline = frame.indexOf('\n');
      const roomId = frame.slice(1, newline < 0 ? undefined : newline);
      const lines = (newline < 0 ? '' : frame.slice(newline + 1)).split('\n').filter(Boolean);
      let session = this.sessions.get(roomId);
      if (!session && roomId.startsWith('battle-')) {
        const challenger = parseBattleChallenger(lines, this.config.username);
        let preset = challenger ? this.acceptedPresets.get(normalizeUser(challenger)) : undefined;
        if (!preset && this.acceptedPresets.size === 1) preset = this.acceptedPresets.values().next().value;
        if (!preset) return;
        for (const [username, candidate] of this.acceptedPresets) {
          if (candidate === preset) this.acceptedPresets.delete(username);
        }
        const meta = await loadMeta(this.config.projectRoot, this.config.formatId);
        session = new BattleSession(roomId, this.config, preset.team, meta, this, this.simulator, this.traceWriter);
        this.sessions.set(roomId, session);
      }
      session?.ingest(lines);
      if (lines.some(line => line.startsWith('|win|') || line === '|tie|')) this.sessions.delete(roomId);
    }
  }

  private async login(challstr: string): Promise<void> {
    const showdownHost = new URL(this.config.showdown).hostname;
    if (this.config.authentication === 'none' || ['127.0.0.1', 'localhost', '::1'].includes(showdownHost)) {
      this.send('', `/trn ${this.config.username},0,`);
      return;
    }
    const body = new URLSearchParams({act: 'getassertion', userid: normalizeUser(this.config.username), challstr});
    const response = await fetch(this.config.authentication, {method: 'POST', body, signal: AbortSignal.timeout(10_000)});
    if (!response.ok) throw new Error(`Assertion request failed: HTTP ${response.status}`);
    const assertion = await response.text();
    if (!assertion || assertion.startsWith(';')) throw new Error(`Login rejected: ${assertion.slice(0, 120)}`);
    this.send('', `/trn ${this.config.username},0,${assertion}`);
  }

  private async accept(username: string): Promise<void> {
    const challengerId = normalizeUser(username);
    if (!challengerId || this.acceptedPresets.has(challengerId)) return;
    if (this.sessions.size + this.acceptedPresets.size >= this.config.maxConcurrentBattles) return;
    const preset = await this.claimPreset(username);
    if (!preset) return;
    this.acceptedPresets.set(challengerId, preset);
    this.send('', `/utm ${preset.team.packed}`);
    this.send('', `/accept ${username}`);
    setTimeout(() => {
      if (this.acceptedPresets.get(challengerId) === preset) this.acceptedPresets.delete(challengerId);
    }, 60_000).unref();
  }

  private async claimPreset(challenger: string): Promise<ClaimedBattlePreset | undefined> {
    if (!this.config.control || !this.config.controlToken) {
      console.error(`Cannot accept ${challenger}: runtime control credentials are missing`);
      return undefined;
    }
    try {
      const response = await fetch(new URL('/internal/ai/battle-presets/claim', this.config.control), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PokemonAI-Internal': this.config.controlToken,
        },
        body: JSON.stringify({
          challenger,
          opponentId: this.config.id,
          formatId: this.config.formatId,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as ClaimedBattlePreset;
    } catch (error) {
      console.error(`Cannot claim battle preset for ${challenger}`, error);
      return undefined;
    }
  }

  private acceptedFormat(value: string): boolean {
    const normalize = (format: string) => format.toLowerCase().replace(/\s+/g, '');
    const base = normalize(this.config.format.split('@@@')[0] ?? '');
    return normalize(value) === normalize(this.config.format) || normalize(value) === base;
  }
}

function normalizeUser(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
