import moment from 'moment';
import { CompanyTypes } from '../definitions';
import { fetchPost } from '../helpers/fetch';
import { CardType, TransactionStatuses } from '../transactions';
import VisaCalScraper from './visa-cal';

jest.mock('../helpers/fetch', () => ({ fetchPost: jest.fn() }));

const post = jest.mocked(fetchPost);
const cards = [
  { cardUniqueId: 'synthetic-a', last4Digits: '1111' },
  { cardUniqueId: 'synthetic-b', last4Digits: '2222' },
  { cardUniqueId: 'synthetic-missing', last4Digits: '3333' },
];

function transaction(id: string, date = '2026-01-31') {
  return {
    trnIntId: id,
    trnPurchaseDate: date,
    debCrdDate: date,
    trnTypeCode: '5',
    trnAmt: 12,
    amtBeforeConvAndIndex: 12,
    trnCurrencySymbol: 'ILS',
    debCrdCurrencySymbol: 'ILS',
    merchantName: 'Synthetic merchant',
    branchCodeDesc: 'Synthetic category',
    transTypeCommentDetails: [],
  };
}

function bankAccount(regular: unknown[] = [], immediate: unknown[] = []) {
  return {
    debitDates: [{ transactions: regular }],
    immidiateDebits: { debitDays: [{ transactions: immediate }] },
  };
}

function mockResponses(frames = {}, bankAccounts = [bankAccount()]) {
  post.mockImplementation(endpoint => {
    if (endpoint.includes('GetFrameStatus')) return Promise.resolve({ result: frames });
    if (endpoint.includes('getClearanceRequests')) return Promise.resolve({ statusCode: 96 });
    return Promise.resolve({ statusCode: 1, result: { bankAccounts } });
  });
}

function scraper(start: string, selectedCards = cards, futureMonthsToScrape = 0) {
  const instance = new VisaCalScraper({
    companyId: CompanyTypes.visaCal,
    startDate: moment(start).toDate(),
    futureMonthsToScrape,
  });
  jest.spyOn(instance, 'getCards').mockResolvedValue(selectedCards);
  jest.spyOn(instance, 'getAuthorizationHeader').mockResolvedValue('synthetic-token');
  jest.spyOn(instance, 'getXSiteId').mockResolvedValue('synthetic-site');
  return instance;
}

describe('CAL synthetic card data', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-02-05T12:00:00Z'));
    post.mockReset();
    mockResponses();
  });

  afterEach(() => jest.useRealTimers());

  test.each([
    ['2026-02-05', '2026-01-31', 0, ['2026-2', '2026-1']],
    ['2026-01-05', '2025-12-31', 0, ['2026-1', '2025-12']],
    ['2024-03-01', '2024-02-29', 0, ['2024-3', '2024-2']],
    ['2026-04-01', '2026-03-31', 0, ['2026-4', '2026-3']],
    ['2026-12-05', '2026-11-30', 1, ['2027-1', '2026-12', '2026-11']],
    ['2026-02-05', '2026-02-05', 0, ['2026-2']],
  ])('covers calendar months from %s back to %s', async (now, start, future, expected) => {
    jest.setSystemTime(new Date(`${now}T12:00:00Z`));
    await scraper(start, [cards[0]], future).fetchData();
    const months = post.mock.calls
      .filter(([endpoint]) => endpoint.includes('getCardTransactionsDetails'))
      .map(([, body]) => {
        const { year, month } = body as { year: string; month: string };
        return `${year}-${month}`;
      });
    expect(months).toEqual(expected);
  });

  test('matches each card by unique ID and preserves a genuine zero debit', async () => {
    mockResponses({
      bankIssuedCards: {
        nextTotalDebitForAccount: 900,
        nextTotalDebitDateForAccount: '2026-02-28',
        frameLimitForCardAmount: 5000,
        fictiveMaxAccAmt: 3000,
        cardLevelFrames: [{ cardUniqueId: 'synthetic-b', nextTotalDebit: 0, nextDebitDate: '2026-02-15' }],
      },
      calIssuedCards: {
        frameLimitForCardAmount: 0,
        cardLevelFrames: [{ cardUniqueId: 'synthetic-a', nextTotalDebit: 45, nextDebitDate: '2026-02-10' }],
      },
    });
    const { accounts } = await scraper('2026-02-01').fetchData();
    expect(accounts?.[0]).toMatchObject({ balance: -45, balanceDate: '2026-02-10', cardType: CardType.CompanyIssued });
    expect(accounts?.[1]).toMatchObject({ balance: -0, balanceDate: '2026-02-15', cardType: CardType.BankIssued });
    expect(accounts?.[2]).toMatchObject({ balance: undefined, balanceDate: undefined, cardType: undefined });
    accounts?.forEach(account => expect(account.cardFrame).toBeUndefined());
  });

  test.each([undefined, [], [{ cardUniqueId: 'synthetic-a' }]])(
    'does not substitute shared values for absent card debit fields (%j)',
    async cardLevelFrames => {
      mockResponses({
        bankIssuedCards: {
          nextTotalDebitForAccount: 900,
          nextTotalDebitDateForAccount: '2026-02-28',
          frameLimitForCardAmount: 5000,
          fictiveMaxAccAmt: 3000,
          cardLevelFrames,
        },
      });
      const { accounts } = await scraper('2026-02-01').fetchData();
      accounts?.forEach(account => {
        expect(account.balance).toBeUndefined();
        expect(account.balanceDate).toBeUndefined();
        expect(account.cardFrame).toBeUndefined();
      });
    },
  );

  test('selects the matching frame among multiple cards in the same group', async () => {
    mockResponses({
      bankIssuedCards: {
        nextTotalDebitForAccount: 999,
        cardLevelFrames: [
          { cardUniqueId: 'synthetic-b', nextTotalDebit: 20 },
          { cardUniqueId: 'synthetic-a', nextTotalDebit: 10 },
        ],
      },
    });
    const { accounts } = await scraper('2026-02-01').fetchData();
    expect(accounts?.map(account => account.balance)).toEqual([-10, -20, undefined]);
  });

  test('leaves metadata unknown when frame groups are absent', async () => {
    const { accounts } = await scraper('2026-02-01').fetchData();
    accounts?.forEach(account => {
      expect(account.balance).toBeUndefined();
      expect(account.balanceDate).toBeUndefined();
      expect(account.cardFrame).toBeUndefined();
      expect(account.cardType).toBeUndefined();
    });
  });

  test('collects pending transactions from all returned card arrays', async () => {
    const pending = (id: string) => {
      const { debCrdDate, ...txn } = transaction(id, '2026-02-01');
      return txn;
    };
    post.mockImplementation(endpoint => {
      if (endpoint.includes('GetFrameStatus')) return Promise.resolve({});
      if (endpoint.includes('getClearanceRequests')) {
        return Promise.resolve({
          statusCode: 1,
          result: {
            cardsList: [
              { cardUniqueID: 'synthetic-a', authDetalisList: [pending('pending-a')] },
              { cardUniqueID: 'synthetic-a', authDetalisList: [pending('pending-b')] },
            ],
          },
        });
      }
      return Promise.resolve({ statusCode: 1, result: { bankAccounts: [] } });
    });
    const { accounts } = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(accounts?.[0].txns).toHaveLength(2);
    expect(accounts?.[0].txns.every(txn => txn.status === TransactionStatuses.Pending)).toBe(true);
  });

  test('collects every declared transaction array and retains the exact start-date filter', async () => {
    mockResponses({}, [
      bankAccount([transaction('before', '2026-01-30'), transaction('regular')], [transaction('immediate')]),
      {
        ...bankAccount(),
        debitDates: [{ transactions: [transaction('second-account')] }, { transactions: [transaction('second-date')] }],
      },
    ]);
    // Keep one response month so this assertion measures arrays, without assuming cross-month deduplication.
    jest.setSystemTime(new Date('2026-01-31T12:00:00Z'));
    const { accounts } = await scraper('2026-01-31', [cards[0]]).fetchData();
    expect(accounts?.[0].txns.map(txn => txn.identifier)).toEqual([
      'regular',
      'second-account',
      'second-date',
      'immediate',
    ]);
  });
});
