'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const spell = require('../modules/document-editor/spell');

describe('spell (puente del corrector)', () => {
  test('el aviso del editor vale por una ventana corta', () => {
    spell.reset();
    assert.equal(spell.isRecent(1000), false);
    spell.mark(1000);
    assert.equal(spell.isRecent(1000 + spell.WINDOW_MS), true);
    assert.equal(spell.isRecent(1000 + spell.WINDOW_MS + 1), false);
  });
  test('claimsEvent espera un instante si el aviso llega justo despues', async () => {
    spell.reset();
    setTimeout(() => spell.mark(), 10);
    assert.equal(await spell.claimsEvent(60), true);
    spell.reset();
    assert.equal(await spell.claimsEvent(5), false);
  });
  test('payloadFromParams limpia palabra y sugerencias', () => {
    assert.deepEqual(spell.payloadFromParams({ misspelledWord: 'mundoo', dictionarySuggestions: ['mundo', '', null, 'mundos'] }), { word: 'mundoo', suggestions: ['mundo', 'mundos'] });
    assert.deepEqual(spell.payloadFromParams(null), { word: '', suggestions: [] });
    assert.equal(spell.payloadFromParams({ dictionarySuggestions: Array(20).fill('a') }).suggestions.length, 6);
  });
});
