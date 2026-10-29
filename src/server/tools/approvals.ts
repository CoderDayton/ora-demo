// Tool calls that act on the machine wait here for the user's answer, given by button, typed word or voice.

import type { Cancel } from '../llm/llama.ts';

export type Decision = 'allow' | 'deny';

export class Approvals {
  private waiting = new Map<string, (d: Decision) => void>();

  // Resolves with the user's answer, or 'deny' if the turn is cancelled first.
  wait(id: string, cancel: Cancel): Promise<Decision> {
    return new Promise<Decision>(ok => {
      this.waiting.set(id, ok);
      cancel.on(() => {
        this.resolve(id, 'deny');
      });
    });
  }

  // False when no call with this id is waiting (already answered, or never asked).
  resolve(id: string, decision: Decision): boolean {
    const fn = this.waiting.get(id);
    if (!fn) return false;
    this.waiting.delete(id);
    fn(decision);
    return true;
  }

  pending(): string[] {
    return [...this.waiting.keys()];
  }
}
