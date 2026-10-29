// Small pure tools: the clock and a calculator.

export function currentTime(): string {
  const d = new Date();
  return `${d.toISOString()} (UTC). Local time: ${d.toString()}`;
}

// Arithmetic by recursive descent: + - * / % ^ (right to left), unary minus, parentheses, decimals. Nothing else is
// accepted, so the input never reaches eval.
class Calc {
  private s: string;
  private i = 0;

  constructor(s: string) {
    this.s = s;
  }

  run(): number {
    const v = this.sum();
    this.space();
    if (this.i < this.s.length) throw new Error('not a valid expression');
    return v;
  }

  private space(): void {
    while (this.i < this.s.length && this.s.charAt(this.i) === ' ') this.i++;
  }

  private peek(): string {
    this.space();
    return this.i < this.s.length ? this.s.charAt(this.i) : '';
  }

  private sum(): number {
    let v = this.product();
    for (let c = this.peek(); c === '+' || c === '-'; c = this.peek()) {
      this.i++;
      const r = this.product();
      v = c === '+' ? v + r : v - r;
    }
    return v;
  }

  private product(): number {
    let v = this.unary();
    for (let c = this.peek(); c === '*' || c === '/' || c === '%'; c = this.peek()) {
      this.i++;
      const r = this.unary();
      if (c === '*') v *= r;
      else {
        if (r === 0) throw new Error('division by zero');
        v = c === '/' ? v / r : v % r;
      }
    }
    return v;
  }

  private unary(): number {
    const c = this.peek();
    if (c === '-' || c === '+') {
      this.i++;
      const v = this.unary();
      return c === '-' ? -v : v;
    }
    return this.power();
  }

  private power(): number {
    const base = this.atom();
    if (this.peek() !== '^') return base;
    this.i++;
    return base ** this.unary();
  }

  private atom(): number {
    if (this.peek() === '(') {
      this.i++;
      const v = this.sum();
      if (this.peek() !== ')') throw new Error('not a valid expression');
      this.i++;
      return v;
    }
    const m = this.s.slice(this.i).match(/^\s*(\d+\.?\d*|\.\d+)/);
    if (!m) throw new Error('not a valid expression');
    this.i += m[0].length;
    return Number(m[1]);
  }
}

export function calculate(expression: string): string {
  if (!/^[\d\s.+\-*/%^()]+$/.test(expression)) throw new Error('not a valid expression');
  const v = new Calc(expression).run();
  if (!Number.isFinite(v)) throw new Error('the result is not a finite number');
  return String(v);
}
