import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHallucinations, isHallucination } from '../.test-build/transcription/hallucination-filter.js';

test('flags bracketed and phantom outputs', () => {
  assert.equal(isHallucination('[Music]'), true);
  assert.equal(isHallucination('(applause)'), true);
  assert.equal(isHallucination('Thank you.'), true);
  assert.equal(isHallucination('Thanks for watching!'), true);
});

test('flags repetition collapse', () => {
  assert.equal(isHallucination('no no no no'), true);
  assert.equal(isHallucination('the cat the cat the cat sat down'), true);
});

test('keeps normal speech', () => {
  assert.equal(isHallucination('The quick brown fox jumps over the lazy dog.'), false);
  assert.equal(isHallucination('We are going to talk about compilers today.'), false);
});

test('cleanHallucinations trims and blanks phantoms', () => {
  assert.equal(cleanHallucinations('  Hello world  '), 'Hello world');
  assert.equal(cleanHallucinations(' thank you '), '');
});
