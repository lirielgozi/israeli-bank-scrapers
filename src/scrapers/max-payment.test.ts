import MaxScraper, { getMaxCardPayment } from './max';
import * as fetchHelper from '../helpers/fetch';
import { CompanyTypes } from '../definitions';

// Synthetic values only. Field names and currency placement match the
// observed homepage response; the next debit differs from both other sums.
const card = (amount: number | null = 1200) => ({
  Last4Digits: '1111',
  CreditLimit: 10000,
  OpenToBuy: 2000,
  FixedDebit: 1500,
  CycleSummary: [
    { Date: '2026-12-10T00:00:00', Currency: 840, CurrencySymbol: '$', ActualDebitSum: 99, IsFinnal: false },
    {
      Date: '2026-12-10T00:00:00',
      Currency: 376,
      CurrencySymbol: ' ₪',
      ActualDebitSum: amount,
      TotalDebitSum: 7000,
      IsFinnal: false,
    },
  ],
});
const observedAt = '2026-11-07T15:00:00.000Z';

describe('MAX issuer repayment', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the ILS actual debit, independently of the fixed setting, cycle total and used credit', () => {
    expect(getMaxCardPayment(card(), observedAt)).toEqual({
      scope: 'card',
      source: 'max-homepage',
      sourceAsOf: observedAt,
      status: 'reported',
      currency: 'ILS',
      nextPayment: 1200,
      nextPaymentDate: '2026-12-10',
      isFinal: false,
      configuredMonthlyPayment: 1500,
    });
  });

  it('preserves a reported zero and finality', () => {
    const fixture = card(0);
    fixture.CycleSummary[1].IsFinnal = true;
    expect(getMaxCardPayment(fixture, observedAt)).toMatchObject({ nextPayment: 0, status: 'reported', isFinal: true });
  });

  it.each([null, NaN, Infinity, -1])('does not replace an invalid actual debit (%s) with another sum', amount => {
    expect(getMaxCardPayment(card(amount), observedAt)).toMatchObject({
      nextPayment: null,
      nextPaymentDate: null,
      status: 'unavailable',
    });
  });

  it('rejects missing, foreign-only, duplicate ILS and invalid-date observations', () => {
    const missing = card();
    missing.CycleSummary = [];
    const foreign = card();
    foreign.CycleSummary = foreign.CycleSummary.slice(0, 1);
    const duplicate = card();
    duplicate.CycleSummary.push(duplicate.CycleSummary[1]);
    const badDate = card();
    badDate.CycleSummary[1].Date = 'invalid';
    for (const fixture of [undefined, missing, foreign, duplicate, badDate]) {
      expect(getMaxCardPayment(fixture, observedAt)).toMatchObject({ status: 'unavailable', nextPayment: null });
    }
  });

  it('fetches fresh homepage metadata on each sync, including cards without transaction rows', async () => {
    let fixture = card(1200);
    const fetch = jest.spyOn(fetchHelper, 'fetchGetWithinPage').mockImplementation((_page, url) => {
      if (url.includes('getHomePageData'))
        return Promise.resolve({ Result: { UserCards: { Cards: [fixture] } } }) as never;
      if (url.includes('getCategories')) return Promise.resolve({ result: [] }) as never;
      return Promise.resolve({ result: { transactions: [] } }) as never;
    });
    const scraper = new MaxScraper({ companyId: CompanyTypes.max, startDate: new Date(), futureMonthsToScrape: 0 });
    const first = await scraper.fetchData();
    fixture = card(2100);
    fixture.CycleSummary[1].Date = '2027-01-10T00:00:00';
    const second = await scraper.fetchData();
    fixture = card(null);
    const unavailable = await scraper.fetchData();
    expect(first.accounts[0].maxCardPayment).toMatchObject({ nextPayment: 1200, nextPaymentDate: '2026-12-10' });
    expect(second.accounts[0].maxCardPayment).toMatchObject({ nextPayment: 2100, nextPaymentDate: '2027-01-10' });
    expect(unavailable.accounts[0].maxCardPayment).toMatchObject({ nextPayment: null, status: 'unavailable' });
    expect(second.accounts[0].txns).toEqual([]);
    expect(fetch.mock.calls.filter(([, url]) => url.includes('getHomePageData'))).toHaveLength(3);
  });
});
