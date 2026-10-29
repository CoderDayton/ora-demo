import assert from 'node:assert';
import { test } from 'node:test';
import { parseApproval } from '../../src/web/chat/approval.ts';

test('plain yes and no answers, typed or transcribed', () => {
  for (const s of [
    'yes',
    'Yes.',
    'yeah',
    'yep',
    'sure',
    'ok',
    'Okay!',
    'allow',
    'Allow it',
    'approved',
    'go ahead',
    'Yes, go ahead!',
    'okay do it',
    'yes please',
  ]) {
    assert.equal(parseApproval(s), 'allow', s);
  }
  for (const s of [
    'no',
    'No.',
    'nope',
    'nah',
    'deny',
    "don't",
    'do not',
    'stop',
    'cancel',
    'never mind',
    "no, don't do that",
    'no thanks',
  ]) {
    assert.equal(parseApproval(s), 'deny', s);
  }
});

test('anything else, and anything ambiguous, is not an answer', () => {
  for (const s of [
    '',
    '   ',
    'what will it do',
    'yes and also delete everything',
    'no problem, go ahead',
    'maybe',
    'allow it but only the first file',
    'ok so what is the weather',
  ]) {
    assert.equal(parseApproval(s), null, s);
  }
});
