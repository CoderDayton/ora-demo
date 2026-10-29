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

export function isNoise(text: string): boolean {
  const words = text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .toLowerCase()
    .match(/[a-z0-9'-]*[a-z0-9]+/g);
  if (!words) return true;
  return words.length === 1 && !ALONE.has(words[0] as string);
}
