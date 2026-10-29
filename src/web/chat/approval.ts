// Reads a typed or spoken reply to "allow this?". Strict on purpose: only short, plain answers count. Anything
// longer, mixed or unclear returns null and the question stays open, so a sentence that merely contains "yes"
// (or something the model's own voice leaked into the microphone) cannot approve an action.

const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'allow', 'approve', 'approved', 'proceed', 'go', 'ahead', 'fine']);
const NO = new Set(['no', 'nope', 'nah', 'deny', 'denied', "don't", 'dont', 'not', 'never', 'mind', 'cancel', 'stop', 'refuse']);
const FILLER = new Set(['please', 'it', 'that', 'do', 'thanks', 'thank', 'you', 'just']);

export function parseApproval(text: string): 'allow' | 'deny' | null {
  const words = text
    .toLowerCase()
    .replace(/[^a-z'\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w);
  if (!words.length || words.length > 6) return null;
  if (!words.every(w => YES.has(w) || NO.has(w) || FILLER.has(w))) return null;
  const yes = words.some(w => YES.has(w));
  const no = words.some(w => NO.has(w));
  if (yes === no) return null;
  return yes ? 'allow' : 'deny';
}
