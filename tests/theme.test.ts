/** Dark / light mode polish (PRD 10.8): every text-on-background pair meets WCAG AA in both themes, and the override rules exist. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../apps/web/src/styles.css'), 'utf8');

/** Custom properties declared in the first rule matching `selectorStart`. */
function tokens(selectorStart: string): Record<string, string> {
  const i = css.indexOf(selectorStart);
  if (i < 0) throw new Error(`selector not found: ${selectorStart}`);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
}

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground token, background token]: text that actually appears on that background
const TEXT_PAIRS: [string, string][] = [
  ['text', 'bg'], ['text', 'surface'], ['text', 'surface-2'],
  ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'],
  ['accent', 'surface'], ['accent', 'surface-2'], ['accent-text', 'accent'],
  ['ok', 'ok-bg'], ['warn', 'warn-bg'], ['fail', 'fail-bg'], ['pending', 'pending-bg'],
  ['ok', 'surface'], ['warn', 'surface'], ['fail', 'surface'],
  ['muted', 'warn-bg'], // text in the attention bar
];

const THEMES: Record<string, Record<string, string>> = {
  light: tokens(':root {'),
  'dark (follows the system)': tokens(":root:not([data-theme='light']) {"),
  'dark (chosen with the Theme button)': tokens(":root[data-theme='dark'] {"),
};

describe('contrast (WCAG AA, 4.5:1 for text)', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    it(`${name}: every token is defined`, () => {
      for (const [fg, bg] of TEXT_PAIRS) {
        expect(t[fg], fg).toMatch(/^#/);
        expect(t[bg], bg).toMatch(/^#/);
      }
    });
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${name}: ${fg} on ${bg}`, () => {
        expect(ratio(t[fg], t[bg]), `${t[fg]} on ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('theme switching', () => {
  it('the two dark rules (system and chosen) carry the same colours', () => {
    expect(THEMES['dark (follows the system)']).toEqual(THEMES['dark (chosen with the Theme button)']);
  });
  it('a chosen light theme beats a dark operating system', () => {
    expect(css).toMatch(/:root:not\(\[data-theme='light'\]\)/);
    expect(css).toMatch(/:root\[data-theme='light'\]\s*{\s*color-scheme: light;/);
  });
  it('dark mode defines the freshness colours too, so they stay visible on a dark surface', () => {
    const dark = THEMES['dark (chosen with the Theme button)'];
    for (const k of ['green', 'yellow', 'orange', 'red']) expect(dark[k], k).toMatch(/^#/);
  });
  it('freshness colours differ clearly from one another (a border, always paired with text)', () => {
    for (const t of [THEMES.light, THEMES['dark (chosen with the Theme button)']]) {
      const cols = ['green', 'yellow', 'orange', 'red'].map((k) => t[k]);
      expect(new Set(cols).size).toBe(4);
    }
  });
  it('index.html applies a saved theme before first paint', () => {
    const html = readFileSync(resolve(__dirname, '../apps/web/index.html'), 'utf8');
    expect(html).toContain('zoning-auditor:theme');
    expect(html.indexOf('data-theme')).toBeLessThan(html.indexOf('<div id="root">'));
  });
});
