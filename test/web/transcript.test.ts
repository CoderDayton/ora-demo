import assert from 'node:assert';
import { test } from 'node:test';
import { isIncomplete, isNoise, joinHeld } from '../../src/web/voice/transcript.ts';

test('empty, punctuation-only and stray one-word transcripts are noise', () => {
  for (const s of ['', '  ', '...', '.', 'on.', 'One.', 'Random.', 'Uh.', 'the', 'Mm-hmm.', '[BLANK_AUDIO]', '(silence)']) {
    assert.equal(isNoise(s), true, s);
  }
});

test('with English expected, a transcript in another language is noise', () => {
  assert.equal(isNoise('provò a escele.', 'English'), true);
  assert.equal(isNoise('Non ho capito, vuoi che provo?', 'English'), true);
  assert.equal(isNoise('provò a escele.', ''), false);
  assert.equal(isNoise('What is the price of the café?', 'English'), false);
});

test('English loanwords with accents do not make an English sentence look foreign', () => {
  for (const s of ['Is it café', 'Update my résumé', 'That is a naïve cliché', 'Order a jalapeño crème brûlée']) {
    assert.equal(isNoise(s, 'English'), false, s);
  }
  assert.equal(isNoise('provò a escele.', 'English'), true);
  assert.equal(isNoise('café provò', 'English'), true);
});

test('a transcript that trails off or ends on a dangling word is incomplete', () => {
  for (const s of ["What's the...", 'So what is the…', 'Can you tell me about the', 'and', 'I want to', "What's the price of"]) {
    assert.equal(isIncomplete(s), true, s);
  }
  for (const s of [
    'What is the price?',
    'Okay.',
    'Thanks!',
    'Search the web for the price of LTC',
    'Tell me a joke',
    'USD value though in one coin.',
  ]) {
    assert.equal(isIncomplete(s), false, s);
  }
});

test('a held fragment is joined to the next utterance without its trailing dots', () => {
  assert.equal(joinHeld("What's the...", 'USD value in one coin.'), "What's the USD value in one coin.");
  assert.equal(joinHeld('', 'hello'), 'hello');
});

test('real sentences and short commands are kept', () => {
  for (const s of [
    'Okay, good. So.',
    'Part one, part one.',
    'Yes.',
    'no',
    'Stop',
    'Continue.',
    'Thanks!',
    'Hello',
    'Allow it',
    'What time is it?',
    'Go ahead',
  ]) {
    assert.equal(isNoise(s), false, s);
  }
});
