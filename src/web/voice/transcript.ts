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
