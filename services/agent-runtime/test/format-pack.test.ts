import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import path from 'node:path';
import {FORMAT_PACKS, showdownFormat} from '@pokemonai/engine';

const require = createRequire(import.meta.url);
const {Dex} = require(path.resolve('vendor/pokemon-showdown/dist/sim/index.js')) as {
  Dex: {
    formats: {
      get(format: string, trusted?: boolean): {id: string; gameType: string};
      getRuleTable(format: unknown): {pickedTeamSize: number | null; maxTeamSize: number; adjustLevel: number; has(rule: string): boolean};
    };
  };
};

test('locked Showdown resolves all closed-team Format Packs exactly', () => {
  for (const pack of Object.values(FORMAT_PACKS)) {
    const format = Dex.formats.get(showdownFormat(pack), true);
    const rules = Dex.formats.getRuleTable(format);
    assert.equal(format.gameType, pack.gameType);
    assert.equal(rules.maxTeamSize, 6);
    assert.equal(rules.pickedTeamSize ?? 6, pack.bringSize);
    assert.equal(rules.has('openteamsheets'), false);
    assert.equal(rules.adjustLevel, 50);
  }
});
