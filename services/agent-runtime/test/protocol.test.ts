import assert from 'node:assert/strict';
import test from 'node:test';
import {ObservationReducer} from '@pokemonai/engine';

test('public reducer never exposes request-side hidden set fields', () => {
  const reducer = new ObservationReducer('battle-protocol', 'champions-ranked-doubles', 'p1');
  reducer.ingest('|poke|p2|Incineroar, L50');
  reducer.ingest('|switch|p2a: Incin|Incineroar, L50|100/100');
  reducer.ingest('|-ability|p2a: Incin|Intimidate');
  const value = JSON.stringify(reducer.snapshot(4, false, false));
  assert.match(value, /Intimidate/);
  assert.doesNotMatch(value, /Assault Vest|Fake Out|Flare Blitz/);
});
