/**
 * Datalog source with its values bound as parameters.
 *
 *   const code = new Datalog().add`user(${userId});`.add`check if time($t), $t < ${expiry};`;
 *   Biscuit.build(root.secretKey, code.source, { params: code.params });
 *
 * `add` is a tagged template: every `${value}` becomes a `{pN}` parameter, bound
 * as a TERM by the parser. A value is never spliced into the source text, so no
 * string — `"); role("admin` included — can change the program's shape.
 */
import type { ParamValue } from "./parser.js";

export class Datalog {
  private readonly lines: string[] = [];
  private readonly bound: Record<string, ParamValue> = {};
  private next = 0;

  /** Append source. Every `${value}` becomes a `{pN}` parameter — a term, never text. */
  add(strings: TemplateStringsArray, ...values: ParamValue[]): this {
    let line = strings[0] ?? "";
    values.forEach((value, i) => {
      const name = `p${this.next++}`;
      this.bound[name] = value;
      line += `{${name}}${strings[i + 1] ?? ""}`;
    });
    this.lines.push(line);
    return this;
  }

  /**
   * Append source that interpolates nothing. Only for text you wrote yourself:
   * a `{name}` in it must not collide with the `{pN}` names `add` generates.
   */
  raw(source: string): this {
    this.lines.push(source);
    return this;
  }

  /** the source, one `add`/`raw` call per line */
  get source(): string {
    return this.lines.join("\n");
  }

  /** the values the source's `{pN}` parameters are bound to */
  get params(): Readonly<Record<string, ParamValue>> {
    return this.bound;
  }
}

/** `datalog\`user(${id});\`` — a new `Datalog` holding one parameterised line. */
export function datalog(strings: TemplateStringsArray, ...values: ParamValue[]): Datalog {
  return new Datalog().add(strings, ...values);
}
