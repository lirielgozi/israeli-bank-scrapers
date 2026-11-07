import moment from 'moment-timezone';
import { type Page } from 'puppeteer';
import { type BankCreditFacility } from '../transactions';

export const unavailableFacility = (): BankCreditFacility => ({
  status: 'unavailable',
  limit: null,
  temporaryLimit: null,
  used: null,
  remainingCredit: null,
  asOf: null,
  source: 'mizrahi-credit-modal',
});

// Bank labels observed in the authenticated account facility modal, 2026-11-07.
// No transaction balance field is interpreted as a facility. Temporary credit is
// retained separately, never added to the current limit without bank semantics.
export function parseMizrahiFacility(text: string, accountNumber: string): BankCreditFacility {
  const lines = text
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  const valueAfter = (label: string): string | undefined => {
    const indices = lines.map((line, i) => (line === label ? i : -1)).filter(i => i >= 0);
    return indices.length === 1 ? lines[indices[0] + 1] : undefined;
  };
  if (lines.filter(line => line === 'מסגרת אשראי בחשבון').length !== 1) return unavailableFacility();
  const account = valueAfter('מספר חשבון');
  const digits = (v: string) => v.replace(/\D/g, '');
  if (
    !account ||
    !/^[\d -]+$/.test(account) ||
    digits(accountNumber).length < 5 ||
    digits(account) !== digits(accountNumber)
  )
    return unavailableFacility();
  const money = (s: string | undefined): number | null => {
    if (!s || !/^₪\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s)) return null;
    const n = Number(s.replace(/[₪,\s]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const limit = money(valueAfter('מסגרת נוכחית'));
  const temporaryLimit = money(valueAfter('מסגרת זמנית'));
  const rawDate = valueAfter('לתאריך');
  const date = rawDate ? moment.tz(rawDate, 'DD/MM/YYYY HH:mm', true, 'Asia/Jerusalem') : null;
  if (limit === null || !date?.isValid()) return unavailableFacility();
  return {
    status: 'reported',
    limit,
    temporaryLimit,
    used: null,
    remainingCredit: null,
    asOf: date.toISOString(),
    source: 'mizrahi-credit-modal',
  };
}

// Optional metadata: missing/changed UI must not prevent transaction collection.
// Use only a unique visible facility navigation control, never application/edit links.
export async function readMizrahiFacility(page: Page, accountNumber: string): Promise<BankCreditFacility> {
  let opened = false;
  try {
    const candidates = [];
    for (const handle of await page.$$('a,button,[role="button"],[role="link"]')) {
      const valid = await handle.evaluate(e => {
        const text = (e as HTMLElement).innerText || e.getAttribute('aria-label') || '';
        return (
          !!e.getBoundingClientRect().width &&
          !!e.getBoundingClientRect().height &&
          /מסגרת|מסגרות/.test(text) &&
          text.length < 100 &&
          !/בקשה|בקשת|שינוי|הגדל|עדכון|פירעון|פרעון|העברה|חדשה|חדש|הקמת|הצטרפות|הזמנת|הצעה|הצעות|newloan|new|apply|application|quote|repay/.test(
            text,
          ) &&
          !(e.tagName === 'BUTTON' && (e as HTMLButtonElement).type === 'submit' && e.closest('form'))
        );
      });
      if (valid) candidates.push(handle);
    }
    if (candidates.length !== 1) return unavailableFacility();
    await candidates[0].click();
    opened = true;
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.modal-content')].some(
          e => e.getBoundingClientRect().width && (e as HTMLElement).innerText.includes('מסגרת נוכחית'),
        ),
      { timeout: 8000 },
    );
    const text = await page.evaluate(() => {
      const modals = [...document.querySelectorAll('.modal-content')].filter(
        e => e.getBoundingClientRect().width && (e as HTMLElement).innerText.includes('מסגרת נוכחית'),
      );
      return modals.length === 1 ? (modals[0] as HTMLElement).innerText : '';
    });
    return parseMizrahiFacility(text, accountNumber);
  } catch {
    return unavailableFacility();
  } finally {
    if (opened) {
      // Dismiss UI only; never submit or save any form. No raw errors/values logged.
      const close = await page
        .$(
          '.modal-content [data-bs-dismiss="modal"], .modal-content [data-dismiss="modal"], .modal-content .btn-close, .modal-content button.close',
        )
        .catch(() => null);
      if (close) await close.click().catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
}
