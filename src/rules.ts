import type { Action, Rule } from "./config.js";

export interface RuleMatch {
  action: Action;
  /** human-readable rule provenance, stored on the receipt */
  rule: string;
}

/** Swappable policy interface — a Cedar engine can replace YamlGlobEngine later. */
export interface RuleEngine {
  match(tool: string): RuleMatch;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/** Non-wildcard characters count; more literal = more specific. */
function specificity(pattern: string): number {
  return pattern.replace(/[*?]/g, "").length;
}

export class YamlGlobEngine implements RuleEngine {
  private compiled: Array<Rule & { re: RegExp; specificity: number; order: number }>;
  private defaults: Action;

  constructor(rules: Rule[], defaults: Action) {
    this.defaults = defaults;
    this.compiled = rules.map((r, order) => ({
      ...r,
      re: globToRegExp(r.pattern),
      specificity: specificity(r.pattern),
      order,
    }));
  }

  match(tool: string): RuleMatch {
    const hits = this.compiled.filter((r) => r.re.test(tool));
    if (hits.length === 0) return { action: this.defaults, rule: `defaults: ${this.defaults}` };
    // most-specific glob wins, then file order
    hits.sort((a, b) => b.specificity - a.specificity || a.order - b.order);
    const win = hits[0];
    return { action: win.action, rule: `${win.pattern}: ${win.action}` };
  }
}
