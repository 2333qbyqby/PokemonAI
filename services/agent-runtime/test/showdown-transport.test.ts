import assert from 'node:assert/strict';
import test from 'node:test';
import {parseBattleChallenger, parseChallengeMessage, splitProtocolPayload} from '../src/showdown-transport.js';

test('splits bundled global protocol messages so challenge updates are observed', () => {
  const payload = [
    '|pm| Challenger| PokemonAI Doubles|/challenge gen9championsvgc2026regmb',
    '|updatechallenges|{"challengesFrom":{"challenger":"gen9championsvgc2026regmb"}}',
  ].join('\n');
  assert.deepEqual(splitProtocolPayload(payload), payload.split('\n'));
});

test('keeps a battle room payload intact', () => {
  const payload = '>battle-test\n|player|p1|PokemonAI Doubles\n|request|{}';
  assert.deepEqual(splitProtocolPayload(payload), [payload]);
});

test('parses current Showdown PM challenge notifications', () => {
  const line = '|pm| Challenger| PokemonAI Doubles|/challenge gen9championsvgc2026regmb@@@!Open Team Sheets|gen9championsvgc2026regmb@@@!Open Team Sheets|||';
  assert.deepEqual(parseChallengeMessage(line, 'PokemonAI Doubles'), {
    user: 'Challenger',
    format: 'gen9championsvgc2026regmb@@@!Open Team Sheets',
  });
  assert.equal(parseChallengeMessage(line, 'PokemonAI Singles'), undefined);
});

test('finds the non-runtime player in a battle room frame', () => {
  const lines = [
    '|player|p1|Player One|1|',
    '|player|p2|PokemonAI Doubles|1|',
    '|teamsize|p1|6',
  ];
  assert.equal(parseBattleChallenger(lines, 'PokemonAI Doubles'), 'Player One');
});
