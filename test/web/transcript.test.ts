import assert from 'node:assert';
import { test } from 'node:test';
import { isNoise } from '../../src/web/voice/transcript.ts';

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
