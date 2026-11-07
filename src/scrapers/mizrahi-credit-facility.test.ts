import { parseMizrahiFacility } from './mizrahi-credit-facility';

// Synthetic fixture: observed labels/order, deliberately different amounts and account.
const fixture = `מסגרת אשראי בחשבון
999-123456
לתאריך
08/11/2026 10:15
מסגרת נוכחית
₪37,500.00
מסגרת זמנית
₪1,200.00
הריבית בגין ניצול מסגרת אשראי זמנית בחשבונך היא בשיעור של 5.12 %
שיעורי הריבית המחושבים לפי סכומי ניצול מסגרת אשראי (תתי המסגרות)
מ- 0 ש"ח עד 2600 ש"ח
3.25%`;

test('reads bank labels with bank as-of; does not invent used/available or add temporary facility', () => {
  expect(parseMizrahiFacility(fixture, '999-123456')).toEqual({
    status: 'reported',
    limit: 37500,
    temporaryLimit: 1200,
    used: null,
    remainingCredit: null,
    asOf: '2026-11-08T08:15:00.000Z',
    source: 'mizrahi-credit-modal',
  });
});
test('explicit zero is reported while missing, malformed, duplicate or wrong-account fields are unavailable', () => {
  expect(parseMizrahiFacility(fixture.replace('₪37,500.00', '₪0.00'), '999123456').limit).toBe(0);
  for (const text of [
    fixture.replace('₪37,500.00', '—'),
    fixture.replace('₪37,500.00', '₪37,50.00'),
    fixture.replace('08/11/2026', '31/02/2026'),
    `${fixture}\nמסגרת נוכחית\n₪12.00`,
  ]) {
    expect(parseMizrahiFacility(text, '999123456').status).toBe('unavailable');
  }
  expect(parseMizrahiFacility(fixture, '888123456').status).toBe('unavailable');
});
test('a zero temporary limit does not replace the current limit and rate tiers are not utilization', () => {
  const result = parseMizrahiFacility(fixture.replace('₪1,200.00', '₪0.00'), '999123456');
  expect(result.limit).toBe(37500);
  expect(result.temporaryLimit).toBe(0);
  expect(result.used).toBeNull();
});

import { readMizrahiFacility } from './mizrahi-credit-facility';
import { type Page } from 'puppeteer';

test('optional UI failure and modal cleanup failure return unavailable without aborting transactions', async () => {
  const handle = { evaluate: jest.fn().mockResolvedValue(true), click: jest.fn().mockResolvedValue(undefined) };
  const page = {
    $$: jest.fn().mockResolvedValue([handle]),
    waitForFunction: jest.fn().mockRejectedValue(new Error('fixture timeout')),
    $: jest.fn().mockRejectedValue(new Error('fixture closed page')),
    keyboard: { press: jest.fn().mockRejectedValue(new Error('fixture closed page')) },
  };
  await expect(readMizrahiFacility(page as unknown as Page, '999123456')).resolves.toMatchObject({
    status: 'unavailable',
  });
});

test('ambiguous facility controls never click', async () => {
  const handle = { evaluate: jest.fn().mockResolvedValue(true), click: jest.fn() };
  const page = { $$: jest.fn().mockResolvedValue([handle, handle]) };
  expect((await readMizrahiFacility(page as unknown as Page, '999123456')).status).toBe('unavailable');
  expect(handle.click).not.toHaveBeenCalled();
});
