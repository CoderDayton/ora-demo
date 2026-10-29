export interface TextCall {
  id: string;
  name: string;
  args: string;
}

const OPEN = '<tool_call>';

// True while `text` could still turn out to be a tool call written out as text, so it must not be shown yet.
export function startsToolMarkup(text: string): boolean {
  const t = text.trimStart();
  return t.length > 0 && (t.startsWith(OPEN) || OPEN.startsWith(t));
}

// The calls in `<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>` markup, which the
// model sometimes writes as plain text instead of calling through the tool channel. Incomplete calls are skipped.
export function textToolCalls(text: string): TextCall[] {
  const calls: TextCall[] = [];
  let at = text.indexOf(OPEN);
  while (at >= 0) {
    const end = text.indexOf('</tool_call>', at);
    if (end < 0) break;
    const body = text.slice(at + OPEN.length, end);
    const f = body.indexOf('<function=');
    const close = f < 0 ? -1 : body.indexOf('>', f);
    if (f >= 0 && close > f) {
      const name = body.slice(f + 10, close).trim();
      const args: Record<string, string> = {};
      let p = body.indexOf('<parameter=', close);
      while (p >= 0) {
        const pc = body.indexOf('>', p);
        const pe = body.indexOf('</parameter>', p);
        if (pc < 0 || pe < pc) break;
        args[body.slice(p + 11, pc).trim()] = body.slice(pc + 1, pe).trim();
        p = body.indexOf('<parameter=', pe);
      }
      if (name) calls.push({ id: '', name: name, args: JSON.stringify(args) });
    }
    at = text.indexOf(OPEN, end);
  }
  return calls;
}
