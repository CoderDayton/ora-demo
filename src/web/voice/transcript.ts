// Speech recognition turns coughs, keyboard clicks and the room into stray words ("One.", "on.", "Random."). A single
// word is only kept when it is something a person says on its own to a voice assistant.
const ALONE = new Set([
  'yes',
  'no',
  'yeah',
  'yep',
  'nope',
  'ok',
  'okay',
  'stop',
  'cancel',
  'continue',
  'next',
  'more',
  'again',
  'repeat',
  'thanks',
  'hello',
  'hi',
  'hey',
  'allow',
  'deny',
  'sure',
  'please',
  'summarize',
  'explain',
  'why',
  'how',
  'what',
  'go',
]);

// Common function words of the languages the recognizer drifts into on noise; none of them is an English word.
const FOREIGN = new Set([
  'non',
  'che',
  'vuoi',
  'il',
  'di',
  'una',
  'sono',
  'el',
  'los',
  'las',
  'que',
  'una',
  'les',
  'des',
  'une',
  'ich',
  'nicht',
  'und',
  'das',
  'ist',
]);

// Accented words that are ordinary English, so they do not count as another language.
const LOANWORDS = new Set([
  'café',
  'cafés',
  'résumé',
  'résumés',
  'naïve',
  'cliché',
  'clichés',
  'fiancé',
  'fiancée',
  'jalapeño',
  'piñata',
  'crème',
  'brûlée',
  'soufflé',
  'sauté',
  'entrée',
  'touché',
  'protégé',
  'façade',
  'señor',
  'déjà',
  'pokémon',
]);

// Words a finished sentence does not end on: a pause in the middle of a thought cuts the utterance after one of them.
const DANGLING = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'or',
  'but',
  'so',
  'for',
  'with',
  'in',
  'on',
  'at',
  'about',
  'that',
  'is',
  'are',
  'was',
  'my',
  'your',
  'this',
  "what's",
]);

// An utterance the recognizer heard cut off: it trails off, or stops on a word that needs another after it.
export function isIncomplete(text: string): boolean {
  const t = text.trim();
  if (/(\.{2,}|…)$/.test(t)) return true;
  const last = t.toLowerCase().match(/[a-z0-9'-]+(?=[^a-z0-9'-]*$)/);
  return !!last && DANGLING.has(last[0]) && !/[.!?]$/.test(t);
}

// The held fragment and the words that follow it, as one utterance.
export function joinHeld(held: string, text: string): string {
  const head = held.replace(/(\.{2,}|…)+\s*$/, '').trim();
  return head ? `${head} ${text}` : text;
}

// `language` is the one the recognizer was asked for; with English, a transcript that reads as another language is noise.
export function isNoise(text: string, language = ''): boolean {
  const clean = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').toLowerCase();
  const words = clean.match(/[a-z0-9'-]*[a-z0-9]+/g);
  if (!words) return true;
  if (language === 'English') {
    const all = (clean.match(/[\p{L}\p{N}'-]+/gu) ?? []).filter(w => !LOANWORDS.has(w));
    const accented = all.filter(w => /[^\p{ASCII}]/u.test(w)).length;
    if (accented * 3 >= all.length || words.filter(w => FOREIGN.has(w)).length >= 2) return true;
  }
  return words.length === 1 && !ALONE.has(words[0] as string);
}
