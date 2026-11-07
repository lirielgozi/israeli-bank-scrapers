import type { Page } from 'puppeteer';
import type { MizrahiDeposits, MizrahiMortgage, MizrahiProducts } from '../mizrahi-products';

const clean = (s: string) => s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
const numeric = '(?:\\d+|\\d{1,3}(?:,\\d{3})+)(?:\\.\\d{1,2})?';
function money(raw: string | undefined): number | null {
  const s = clean(raw ?? '');
  if (!new RegExp(`^(?:₪\\s*${numeric}|${numeric}\\s*₪)$`).test(s)) return null;
  const n = Number(s.replace(/[₪,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function rate(raw: string | undefined): number | null {
  const s = clean(raw ?? '');
  return /^\d+(?:\.\d+)?%$/.test(s) && Number(s.slice(0, -1)) <= 100 ? Number(s.slice(0, -1)) : null;
}
function date(raw: string | undefined): string | null {
  const m = clean(raw ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const n = Date.parse(iso);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === iso ? iso : null;
}
export function parseMizrahiMortgage(headers: string[], rows: string[][]): MizrahiMortgage | null {
  const keys = headers.map(clean);
  const labels = ['שם המסלול', 'יתרת המסלול', 'ריבית בפועל'];
  if (labels.some(label => keys.filter(k => k === label).length !== 1) || rows.length === 0 || rows.length > 100)
    return null;
  const [nameIndex, balanceIndex, rateIndex] = labels.map(label => keys.indexOf(label));
  const tracks: MizrahiMortgage['tracks'] = [];
  for (const row of rows) {
    const name = clean(row[nameIndex] ?? '');
    const balance = money(row[balanceIndex]);
    if (!name || name.length > 200 || balance === null) return null;
    tracks.push({ name, balance, currency: 'ILS', actualInterestRatePercent: rate(row[rateIndex]) });
  }
  return { source: 'mizrahi-mortgage-composition', accountBinding: null, bankAsOf: null, headerTotal: null, tracks };
}
export function parseMizrahiDeposits(
  activeFilter: string,
  fields: Array<Record<string, string>>,
): MizrahiDeposits | null {
  const count = clean(activeFilter).match(/^הכל\s*\((\d+)\)$/);
  // An empty source/template is unavailable, not evidence that deposits closed.
  if (!count || Number(count[1]) !== fields.length || !fields.length || fields.length > 100) return null;
  const records: MizrahiDeposits['records'] = [];
  for (const f of fields) {
    const accumulated = money(f['צברת עד כה']);
    const valuation = money(f['שיערוך ליום עסקים נוכחי']);
    if (accumulated === null || valuation === null) return null;
    records.push({
      accumulated,
      valuation,
      currency: 'ILS',
      interestRatePercent: rate(f['שיעור ריבית']),
      firstDepositDate: date(f['מועד הפקדה ראשונה']),
      maturityDate: date(f['מועד פירעון']),
    });
  }
  return {
    source: 'mizrahi-deposit-cards',
    accountBinding: null,
    bankAsOf: null,
    total: null,
    totalLabel: 'סה"כ פיקדונות כולל רווחים (ללא ניכוי מס)',
    records,
  };
}

// Exact read-only menu destinations from the source handoff. Run once, AFTER
// all checking accounts, so portal navigation cannot change their scrape scope.
async function navigate(page: Page, deposits: boolean): Promise<boolean> {
  const candidates = [];
  for (const h of await page.$$('a')) {
    if (
      await h.evaluate((e, isDeposit) => {
        const el = e as HTMLElement;
        if (!el.getBoundingClientRect().width || !el.getBoundingClientRect().height) return false;
        if (isDeposit)
          return (
            el.id === 'mainMenu' &&
            el.innerText.trim() === 'פיקדונות וחסכונות' &&
            e.getAttribute('href') === '/OnlineApp/hs/legacy/root-main-hs-myDeposits'
          );
        return el.innerText.trim() === 'הלוואות ומשכנתאות';
      }, deposits)
    )
      candidates.push(h);
  }
  if (candidates.length !== 1) return false;
  await candidates[0].click();
  return true;
}
async function readComponent(page: Page, deposits: boolean): Promise<MizrahiMortgage | MizrahiDeposits | null> {
  if (!(await navigate(page, deposits))) return null;
  const deadline = Date.now() + 8000;
  do {
    const values: Array<MizrahiMortgage | MizrahiDeposits> = [];
    for (const frame of page.frames()) {
      const raw = await frame
        .evaluate(isDeposit => {
          const visible = (e: Element) =>
            !!e.getBoundingClientRect().width &&
            !!e.getBoundingClientRect().height &&
            getComputedStyle(e).visibility !== 'hidden';
          const text = (e: Element) => (e as HTMLElement).innerText.trim();
          if (!isDeposit) {
            const tables = [...document.querySelectorAll('.sky-maslolim table')].filter(
              t =>
                visible(t) &&
                ['שם המסלול', 'יתרת המסלול', 'ריבית בפועל'].every(label =>
                  [...t.querySelectorAll('th')].some(h => text(h) === label),
                ),
            );
            if (tables.length !== 1 || ![...document.querySelectorAll('.sky-mash-header')].some(visible)) return null;
            return {
              headers: [...tables[0].querySelectorAll('th')].map(text),
              rows: [...tables[0].querySelectorAll('tr[role="button"]')]
                .filter(visible)
                .map(r => [...r.querySelectorAll('td')].map(text)),
            };
          }
          const components = [...document.querySelectorAll('.sky-my-deposits')].filter(visible);
          if (components.length !== 1) return null;
          const root = components[0];
          const filters = [...root.querySelectorAll('li.active')].filter(visible);
          if (filters.length !== 1) return null;
          const labels = ['צברת עד כה', 'שיעור ריבית', 'מועד הפקדה ראשונה', 'מועד פירעון', 'שיערוך ליום עסקים נוכחי'];
          const fields = [...root.querySelectorAll('li.deposit-cube')].filter(visible).map(card => {
            const result: Record<string, string> = {};
            const lines = [...card.querySelectorAll('.sky-deposit-details')].filter(visible).flatMap(e =>
              text(e)
                .split(/\r?\n/)
                .map(s => s.trim())
                .filter(Boolean),
            );
            for (const label of labels) {
              const matches = lines.map((s, i) => (s === label ? i : -1)).filter(i => i >= 0);
              if (matches.length === 1 && lines[matches[0] + 1] && !labels.includes(lines[matches[0] + 1]))
                result[label] = lines[matches[0] + 1];
            }
            return result;
          });
          return { activeFilter: text(filters[0]), fields };
        }, deposits)
        .catch(() => null);
      if (!raw) continue;
      const value =
        'headers' in raw && raw.headers && raw.rows
          ? parseMizrahiMortgage(raw.headers, raw.rows)
          : 'fields' in raw && raw.fields && raw.activeFilter
            ? parseMizrahiDeposits(raw.activeFilter, raw.fields)
            : null;
      if (value) values.push(value);
    }
    if (values.length === 1) return values[0];
    if (values.length > 1) return null;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return null;
}
export async function readMizrahiProducts(page: Page): Promise<MizrahiProducts> {
  const mortgage = await readComponent(page, false).catch(() => null);
  const deposits = await readComponent(page, true).catch(() => null);
  return {
    scope: 'connection',
    mortgage: mortgage?.source === 'mizrahi-mortgage-composition' ? mortgage : null,
    deposits: deposits?.source === 'mizrahi-deposit-cards' ? deposits : null,
  };
}
