import assert from 'node:assert/strict';
import test from 'node:test';
import {enumerateLegalActions, getFormatPack, type ShowdownRequest} from '../src/index.js';

const doublesRequest: ShowdownRequest = {
  rqid: 3,
  active: [
    {moves: [{id: 'thunderbolt', move: 'Thunderbolt', target: 'normal', basePower: 90, category: 'Special'}], canTerastallize: 'Electric'},
    {moves: [{id: 'helpinghand', move: 'Helping Hand', target: 'adjacentAlly', category: 'Status'}]},
  ],
  side: {pokemon: [
    {ident: 'p1a: A', details: 'A', condition: '100/100', active: true},
    {ident: 'p1b: B', details: 'B', condition: '100/100', active: true},
    {ident: 'p1: C', details: 'C', condition: '100/100', active: false},
    {ident: 'p1: D', details: 'D', condition: '100/100', active: false},
  ]},
};

test('doubles actions are complete side actions without resource or switch conflicts', () => {
  const actions = enumerateLegalActions(doublesRequest, getFormatPack('champions-ranked-doubles'));
  assert.ok(actions.length > 0);
  for (const action of actions) {
    assert.equal(action.commands.length, 2);
    assert.ok(action.commands.filter(command => command.kind === 'move' && command.tera).length <= 1);
    const switches = action.commands.filter(command => command.kind === 'switch').map(command => command.slot);
    assert.equal(new Set(switches).size, switches.length);
  }
  assert.ok(actions.some(action => action.showdown.includes('move 1 1')));
  assert.ok(actions.some(action => action.showdown.includes('move 1 -1')));
  assert.ok(!actions.some(action => action.showdown.endsWith('move 1 -2')));
});

test('team preview honors bring size and active slots', () => {
  const request: ShowdownRequest = {
    teamPreview: true,
    side: {pokemon: Array.from({length: 6}, (_, index) => ({ident: `p1: ${index}`, details: `${index}`, condition: '100/100', active: false}))},
  };
  const doubles = enumerateLegalActions(request, getFormatPack('champions-ranked-doubles'));
  const rankedSingles = enumerateLegalActions(request, getFormatPack('champions-ranked-singles'));
  const ou = enumerateLegalActions(request, getFormatPack('champions-ou'));
  assert.equal(doubles.length, 180);
  assert.ok(doubles.every(action => /^team \d{4}$/.test(action.showdown)));
  assert.ok(rankedSingles.every(action => /^team \d{3}$/.test(action.showdown)));
  assert.ok(ou.every(action => /^team \d{6}$/.test(action.showdown)));
});

test('a surviving doubles slot passes during a partial forced switch', () => {
  const request: ShowdownRequest = {
    forceSwitch: [true, false],
    side: {
      pokemon: [
        {ident: 'p1: A', details: 'A', condition: '0 fnt', active: true, fainted: true},
        {ident: 'p1: B', details: 'B', condition: '100/100', active: true, fainted: false},
        {ident: 'p1: C', details: 'C', condition: '100/100', active: false, fainted: false},
        {ident: 'p1: D', details: 'D', condition: '100/100', active: false, fainted: false},
      ],
    },
  };
  const actions = enumerateLegalActions(request, getFormatPack('champions-ranked-doubles'));
  assert.deepEqual(actions.map(action => action.showdown), ['switch 3, pass', 'switch 4, pass']);
});

test('forced switch actions use one pass when only one replacement remains', () => {
  const request: ShowdownRequest = {
    forceSwitch: [true, true],
    side: {
      pokemon: [
        {ident: 'p1: A', details: 'A', condition: '0 fnt', active: true, fainted: true},
        {ident: 'p1: B', details: 'B', condition: '0 fnt', active: true, fainted: true},
        {ident: 'p1: C', details: 'C', condition: '100/100', active: false, fainted: false},
        {ident: 'p1: D', details: 'D', condition: '0 fnt', active: false, fainted: true},
      ],
    },
  };
  const actions = enumerateLegalActions(request, getFormatPack('champions-ranked-doubles'));
  assert.deepEqual(actions.map(action => action.showdown), ['switch 3, pass', 'pass, switch 3']);
});

test('a fainted doubles position passes when no replacement remains', () => {
  const request: ShowdownRequest = {
    active: [
      {moves: [{id: 'tackle', move: 'Tackle', target: 'normal'}]},
      {moves: [{id: 'tackle', move: 'Tackle', target: 'normal'}]},
    ],
    side: {
      pokemon: [
        {ident: 'p1: A', details: 'A', condition: '50/100', active: true, fainted: false},
        {ident: 'p1: B', details: 'B', condition: '0 fnt', active: true, fainted: true},
        {ident: 'p1: C', details: 'C', condition: '0 fnt', active: false, fainted: true},
        {ident: 'p1: D', details: 'D', condition: '0 fnt', active: false, fainted: true},
      ],
    },
  };
  const actions = enumerateLegalActions(request, getFormatPack('champions-ranked-doubles'));
  assert.ok(actions.length > 0);
  assert.ok(actions.every(action => action.commands[1]?.kind === 'pass'));
});
