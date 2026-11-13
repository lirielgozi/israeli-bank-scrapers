import moment from 'moment';
import { CompanyTypes } from '../definitions';
import { fetchPost } from '../helpers/fetch';
import { CardType, TransactionStatuses } from '../transactions';
import VisaCalScraper from './visa-cal';

jest.mock('../helpers/fetch', () => ({ fetchPost: jest.fn() }));

const post = jest.mocked(fetchPost);

class OfflineVisaCalScraper extends VisaCalScraper {
  initialize() {
    return Promise.resolve();
  }

  login() {
    return Promise.resolve({ success: true });
  }

  terminate() {
    return Promise.resolve();
  }
}
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

// The frames response reports its own success, as the live endpoint does, so these
// bodies exercise the frame reading rather than the unavailable metadata path.
function mockResponses(frames = {}, bankAccounts = [bankAccount()]) {
  post.mockImplementation(endpoint => {
    if (endpoint.includes('GetFrameStatus')) return Promise.resolve({ statusCode: 1, result: frames });
    if (endpoint.includes('getClearanceRequests')) return Promise.resolve({ statusCode: 96 });
    return Promise.resolve({ statusCode: 1, result: { bankAccounts } });
  });
}

function scraper(start: string, selectedCards = cards, futureMonthsToScrape = 0) {
  const instance = new OfflineVisaCalScraper({
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

  test.each([
    undefined,
    [],
    [{ cardUniqueId: 'synthetic-a' }],
    [{ cardUniqueId: 'synthetic-a', nextTotalDebit: null, nextDebitDate: null }],
  ])('does not substitute shared values for absent card debit fields (%j)', async cardLevelFrames => {
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
  });

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
      if (endpoint.includes('GetFrameStatus')) return Promise.resolve({ result: {} });
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

  test('collects every declared transaction array and retains the requested first calendar day', async () => {
    mockResponses({}, [
      bankAccount(
        [transaction('before', '2026-01-30T23:59:59'), transaction('regular', '2026-01-31T08:00:00')],
        [transaction('immediate')],
      ),
      {
        ...bankAccount(),
        debitDates: [{ transactions: [transaction('second-account')] }, { transactions: [transaction('second-date')] }],
      },
    ]);
    // Keep one response month so this assertion measures arrays, without assuming cross-month deduplication.
    jest.setSystemTime(new Date('2026-01-31T12:00:00Z'));
    const { accounts } = await scraper('2026-01-31T15:00:00', [cards[0]]).fetchData();
    expect(accounts?.[0].txns.map(txn => txn.identifier)).toEqual([
      'regular',
      'second-account',
      'second-date',
      'immediate',
    ]);
  });

  // A body that reports success and then carries a broken shape is malformed. A body
  // with no status at all is unavailable metadata instead, covered further down.
  test.each([
    undefined,
    null,
    { statusCode: 1 },
    { statusCode: 1, result: null },
    { statusCode: 1, result: [] },
    { statusCode: 1, result: 'invalid' },
    { statusCode: 1, result: { bankIssuedCards: [] } },
    { statusCode: 1, result: { calIssuedCards: { cardLevelFrames: {} } } },
    { statusCode: 1, result: { bankIssuedCards: { cardLevelFrames: [null] } } },
    {
      statusCode: 1,
      result: { bankIssuedCards: { cardLevelFrames: [{ cardUniqueId: 'synthetic-a', nextTotalDebit: '12' }] } },
    },
  ])('isolates malformed metadata without returning an empty successful card (%j)', async response => {
    post.mockResolvedValue(response);
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.success).toBe(false);
    expect(result.accounts).toBeUndefined();
    expect(result.warnings).toEqual([{ accountNumber: cards[0].last4Digits, code: 'card-fetch-failed' }]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test.each([
    { calIssuedCards: null },
    { bankIssuedCards: null },
    { calIssuedCards: null, bankIssuedCards: null },
    { calIssuedCards: { cardLevelFrames: null } },
    { bankIssuedCards: { cardLevelFrames: null } },
    { calIssuedCards: { cardLevelFrames: null }, bankIssuedCards: { cardLevelFrames: null } },
  ])('accepts null optional groups or frame lists as absent (%j)', async frames => {
    mockResponses(frames);
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.success).toBe(true);
    expect(result.accounts?.[0]).toMatchObject({ balance: undefined, balanceDate: undefined, cardType: undefined });
    expect(result.accounts?.[0].cardFrame).toBeUndefined();
  });

  test('sanitizes metadata retrieval errors', async () => {
    post.mockRejectedValue(new Error('Synthetic private payload details'));
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.success).toBe(false);
    expect(result.warnings).toEqual([{ accountNumber: cards[0].last4Digits, code: 'card-fetch-failed' }]);
    expect(JSON.stringify(result)).not.toContain('private payload');
  });

  test('observed status87/null frame envelope preserves transaction collection for all cards', async () => {
    // Envelope observed from the live endpoint; all card IDs and amounts are synthetic.
    const unavailableFrame = { statusCode: 87, result: null };
    post.mockImplementation((endpoint, body) => {
      if (endpoint.includes('GetFrameStatus'))
        return Promise.resolve(
          body.cardsForFrameData[0].cardUniqueId === cards[1].cardUniqueId
            ? unavailableFrame
            : {
                statusCode: 1,
                result: {
                  bankIssuedCards: { cardLevelFrames: [{ cardUniqueId: cards[0].cardUniqueId, nextTotalDebit: 25 }] },
                },
              },
        );
      if (endpoint.includes('getClearanceRequests')) return Promise.resolve({ statusCode: 96 });
      return Promise.resolve({ statusCode: 1, result: { bankAccounts: [] } });
    });
    const result = await scraper('2026-02-01').scrape({ username: 'synthetic', password: 'synthetic' });
    expect(result.success).toBe(true);
    expect(result.accounts).toHaveLength(cards.length);
    expect(result.accounts?.[0]).toMatchObject({ balance: -25, cardMetadataStatus: 'available' });
    expect(result.accounts?.[1]).toMatchObject({ cardMetadataStatus: 'unavailable', txns: [] });
    expect(result.accounts?.[1].balance).toBeUndefined();
    expect(result.accounts?.[1].cardFrame).toBeUndefined();
    expect(result.warnings).toEqual([{ accountNumber: cards[1].last4Digits, code: 'metadata-unavailable' }]);
    expect(
      post.mock.calls.some(
        ([endpoint, body]) =>
          endpoint.includes('getCardTransactionsDetails') && body.cardUniqueId === cards[1].cardUniqueId,
      ),
    ).toBe(true);
  });

  test('keeps other cards when one metadata response is malformed', async () => {
    post.mockImplementation((endpoint, body) => {
      if (endpoint.includes('GetFrameStatus')) {
        return Promise.resolve(
          body.cardsForFrameData[0].cardUniqueId === cards[1].cardUniqueId
            ? { statusCode: 1, result: null }
            : { statusCode: 1, result: {} },
        );
      }
      if (endpoint.includes('getClearanceRequests')) return Promise.resolve({ statusCode: 96 });
      return Promise.resolve({ statusCode: 1, result: { bankAccounts: [] } });
    });
    const result = await scraper('2026-02-01').scrape({ username: 'synthetic', password: 'synthetic' });
    expect(result.success).toBe(true);
    expect(result.accounts).toHaveLength(cards.length - 1);
    expect(result.accounts?.some(a => a.accountNumber === cards[1].last4Digits)).toBe(false);
    expect(result.warnings).toEqual([{ accountNumber: cards[1].last4Digits, code: 'card-fetch-failed' }]);
  });

  test.each([0, 96])(
    'explicit non-success metadata status %i is unavailable, not a transaction failure',
    async statusCode => {
      post.mockImplementation(endpoint =>
        Promise.resolve(
          endpoint.includes('GetFrameStatus')
            ? { statusCode, result: null }
            : endpoint.includes('getClearanceRequests')
              ? { statusCode: 96 }
              : { statusCode: 1, result: { bankAccounts: [] } },
        ),
      );
      const result = await scraper('2026-02-01', [cards[0]]).fetchData();
      expect(result.success).toBe(true);
      expect(result.accounts?.[0].cardMetadataStatus).toBe('unavailable');
      expect(result.warnings?.[0].code).toBe('metadata-unavailable');
    },
  );

  test('a frames body with no status code is unavailable metadata, not a reported blank', async () => {
    post.mockImplementation(endpoint =>
      Promise.resolve(
        endpoint.includes('GetFrameStatus')
          ? {
              result: {
                bankIssuedCards: { cardLevelFrames: [{ cardUniqueId: cards[0].cardUniqueId, nextTotalDebit: 25 }] },
              },
            }
          : endpoint.includes('getClearanceRequests')
            ? { statusCode: 96 }
            : { statusCode: 1, result: { bankAccounts: [bankAccount([transaction('synthetic-txn', '2026-02-03')])] } },
      ),
    );
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.success).toBe(true);
    expect(result.accounts?.[0].cardMetadataStatus).toBe('unavailable');
    expect(result.warnings).toEqual([{ accountNumber: cards[0].last4Digits, code: 'metadata-unavailable' }]);
    // Nothing from such a body is reported as a figure, and the transactions still are.
    expect(result.accounts?.[0].balance).toBeUndefined();
    expect(result.accounts?.[0].balanceDate).toBeUndefined();
    expect(result.accounts?.[0].txns.map(txn => txn.identifier)).toEqual(['synthetic-txn']);
  });

  test('a failed transaction request omits only that card instead of returning empty rows', async () => {
    post.mockImplementation((endpoint, body) =>
      Promise.resolve(
        endpoint.includes('GetFrameStatus')
          ? { statusCode: 1, result: {} }
          : endpoint.includes('getClearanceRequests')
            ? { statusCode: 96 }
            : body.cardUniqueId === cards[1].cardUniqueId
              ? { statusCode: 0 }
              : { statusCode: 1, result: { bankAccounts: [] } },
      ),
    );
    const result = await scraper('2026-02-01').fetchData();
    expect(result.success).toBe(true);
    expect(result.accounts).toHaveLength(cards.length - 1);
    expect(result.accounts?.some(a => a.accountNumber === cards[1].last4Digits)).toBe(false);
    expect(result.warnings).toEqual([{ accountNumber: cards[1].last4Digits, code: 'card-fetch-failed' }]);
  });

  test('accepts a successful metadata response with no matching card', async () => {
    post.mockImplementation(endpoint => {
      if (endpoint.includes('GetFrameStatus')) {
        return Promise.resolve({
          statusCode: 1,
          result: { bankIssuedCards: { cardLevelFrames: [{ cardUniqueId: 'synthetic-other', nextTotalDebit: 10 }] } },
        });
      }
      if (endpoint.includes('getClearanceRequests')) return Promise.resolve({ statusCode: 96 });
      return Promise.resolve({ statusCode: 1, result: { bankAccounts: [] } });
    });
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.success).toBe(true);
    expect(result.accounts?.[0]).toMatchObject({ balance: undefined, balanceDate: undefined, cardType: undefined });
  });

  test('rejects duplicate suffixes for different card IDs before collecting data', async () => {
    const duplicateCards = [cards[0], { cardUniqueId: 'synthetic-other', last4Digits: cards[0].last4Digits }];
    await expect(scraper('2026-02-01', duplicateCards).fetchData()).rejects.toThrow(
      /^CAL card suffixes are ambiguous$/,
    );
    expect(post).not.toHaveBeenCalled();
  });

  test.each([
    ['2026-02-01T15:00:00', '2026-01-31T23:59:59', '2026-02-01T00:01:00'],
    ['2026-01-01T15:00:00', '2025-12-31T23:59:59', '2026-01-01T08:00:00'],
  ])('filters by the requested calendar day across month/year boundaries (%s)', async (start, before, sameDay) => {
    jest.setSystemTime(moment(start).toDate());
    mockResponses({}, [bankAccount([transaction('before', before), transaction('first-day', sameDay)])]);
    const { accounts } = await scraper(start, [cards[0]]).fetchData();
    expect(accounts?.[0].txns.map(txn => txn.identifier)).toEqual(['first-day']);
  });
});

// Per-card figures CAL reports for cards that share a single credit frame. Every
// amount, rate and identifier below is invented.
describe('CAL per-card credit figures', () => {
  const REVOLVING = 'א.מתגלגל';
  const invented = {
    frameUsage: 1234.5,
    otherUsage: 777.25,
    revolvingBalance: 2345.67,
    cycleSpend: 345.21,
    fixedDebit: 400,
    nominal: 11.111111,
    effective: 12.345678,
    gapFromPrime: 5.0505,
    validDate: '2026-01-15T00:00:00',
    decoy: 99.99,
  };

  const accountFrames = (usageByCard: Record<string, number>) =>
    Object.entries(usageByCard).map(([cardUniqueId, frameTotalOblForCardAmount]) => ({
      cardUniqueId,
      frameTotalOblForCardAmount,
    }));

  const additionalInfo = (fixedDebitAmount: unknown = invented.fixedDebit) => ({
    totalBasketAmount: invented.revolvingBalance,
    totalCycleTransactions: invented.cycleSpend,
    fixedDebitAmount,
  });

  const decoyInfo = { totalBasketAmount: invented.decoy, totalCycleTransactions: invented.decoy, fixedDebitAmount: 1 };

  const bigNumbersBody = (
    cardKey: 'cardUniqueId' | 'cardUniqueID' = 'cardUniqueId',
    cardUniqueId: string = cards[0].cardUniqueId,
    info: unknown = additionalInfo(),
  ) => ({
    statusCode: 1,
    result: {
      bigNumbers: [
        { cards: [{ cardUniqueId: 'synthetic-unrelated', additionalInfo: decoyInfo }] },
        { cards: [{ [cardKey]: cardUniqueId, additionalInfo: info }] },
      ],
    },
  });

  // Rows other than the revolving one carry a decoy rate, so picking the wrong row shows up.
  const interestRow = (interestName: string) => {
    const revolving = interestName === REVOLVING;
    return {
      interestName,
      nominalInterestRate: revolving ? invented.nominal : invented.decoy,
      effectiveInterestRate: revolving ? invented.effective : invented.decoy,
      gapFromPrime: revolving ? invented.gapFromPrime : invented.decoy,
      interestValidDate: invented.validDate,
    };
  };

  const interestsBody = (names: string[] = ['קרדיט', REVOLVING, '+30']) => ({
    statusCode: 1,
    result: { cardInterests: names.map(interestRow) },
  });

  // The shared cards carry no bank account, so the big number tests use copies that do.
  const accountIds = { first: 'synthetic-account-one', second: 'synthetic-account-two' };
  const onAccount = (card: (typeof cards)[number], bankAccountUniqueId: unknown) => ({
    ...card,
    bankAccountUniqueId,
  });
  const accountCards = cards.map(card => onAccount(card, accountIds.first));

  // The account-wide body CAL returns: every card on the bank account in one response.
  const accountWideBody = (infoByCard: Record<string, unknown>) => ({
    statusCode: 1,
    result: {
      bigNumbers: [
        { cards: [{ cardUniqueId: 'synthetic-unrelated', additionalInfo: decoyInfo }] },
        {
          cards: Object.entries(infoByCard).map(([cardUniqueId, additionalInfo]) => ({
            cardUniqueId,
            additionalInfo,
          })),
        },
      ],
    },
  });

  const bigNumbersCalls = () =>
    post.mock.calls
      .filter(([endpoint]) => endpoint.includes('getBigNumberAndDetails'))
      .map(([, body]) => body as Record<string, unknown>);

  const reply = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));

  // A big numbers override is either one body for every account, or a function of the
  // bank account id in the request body so each account can answer differently.
  function mockPerCardResponses(
    overrides: {
      frames?: unknown;
      bigNumbers?: unknown;
      interests?: unknown;
      omitFramesStatus?: boolean;
    } = {},
  ): void {
    const { frames = {}, bigNumbers = null, interests = null, omitFramesStatus = false } = overrides;
    post.mockImplementation((endpoint, body) => {
      if (endpoint.includes('GetFrameStatus'))
        return Promise.resolve(omitFramesStatus ? { result: frames } : { statusCode: 1, result: frames });
      if (endpoint.includes('getBigNumberAndDetails'))
        return reply(
          typeof bigNumbers === 'function'
            ? (bigNumbers as (id: unknown) => unknown)((body as Record<string, unknown>).bankAccountUniqueId)
            : bigNumbers,
        );
      if (endpoint.includes('GetCardsInterests')) return reply(interests);
      if (endpoint.includes('getClearanceRequests')) return Promise.resolve({ statusCode: 96 });
      return Promise.resolve({
        statusCode: 1,
        result: { bankAccounts: [bankAccount([transaction('synthetic-txn', '2026-02-03')])] },
      });
    });
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-02-05T12:00:00Z'));
    post.mockReset();
    mockPerCardResponses();
  });

  afterEach(() => jest.useRealTimers());

  test.each(['bankIssuedCards', 'calIssuedCards'])(
    'reads the per-card frame usage from %s and falls back to it for the balance',
    async issuerGroup => {
      mockPerCardResponses({
        frames: {
          [issuerGroup]: {
            frameLimitForCardAmount: 9000,
            cardLevelFrames: [],
            accountLevelFrames: accountFrames({
              [cards[0].cardUniqueId]: invented.frameUsage,
              [cards[1].cardUniqueId]: invented.otherUsage,
            }),
          },
        },
      });
      const { accounts } = await scraper('2026-02-01').fetchData();
      expect(accounts?.[0].calCard?.frameUsage).toBe(invented.frameUsage);
      expect(accounts?.[0].balance).toBe(-invented.frameUsage);
      expect(accounts?.[1].calCard?.frameUsage).toBe(invented.otherUsage);
      expect(accounts?.[1].balance).toBe(-invented.otherUsage);
      expect(accounts?.[2].calCard).not.toHaveProperty('frameUsage');
      expect(accounts?.[2].balance).toBeUndefined();
    },
  );

  test('a card level frame still decides the balance when a frame usage is also reported', async () => {
    mockPerCardResponses({
      frames: {
        calIssuedCards: {
          cardLevelFrames: [
            { cardUniqueId: cards[0].cardUniqueId, nextTotalDebit: 50, nextDebitDate: '2026-02-10' },
            { cardUniqueId: cards[1].cardUniqueId, nextTotalDebit: 0 },
          ],
          accountLevelFrames: accountFrames({
            [cards[0].cardUniqueId]: invented.frameUsage,
            [cards[1].cardUniqueId]: invented.otherUsage,
          }),
        },
      },
    });
    const { accounts } = await scraper('2026-02-01').fetchData();
    expect(accounts?.[0]).toMatchObject({ balance: -50, balanceDate: '2026-02-10' });
    expect(accounts?.[0].calCard?.frameUsage).toBe(invented.frameUsage);
    // A genuine zero debit is not replaced by the frame usage.
    expect(accounts?.[1].balance).toBe(-0);
  });

  test('keeps the frame usage for a debit card the shared facility gating skips', async () => {
    const debitCard = {
      cardUniqueId: 'synthetic-debit',
      last4Digits: '4444',
      isDebitCard: true,
      bankAccountUniqueId: 'synthetic-bank',
      currentDebitDay: 10,
    };
    mockPerCardResponses({
      frames: {
        calIssuedCards: {
          frameLimitForCardAmount: 9000,
          fictiveMaxAccAmt: 500.5,
          cardLevelFrames: [],
          accountLevelFrames: accountFrames({ 'synthetic-debit': invented.frameUsage }),
        },
      },
    });
    const { accounts } = await scraper('2026-02-01', [debitCard]).fetchData();
    expect(accounts?.[0].calCard?.sharedFacility).toBeNull();
    expect(accounts?.[0].calCard?.isDebit).toBe(true);
    expect(accounts?.[0].calCard?.frameUsage).toBe(invented.frameUsage);
    expect(accounts?.[0].balance).toBe(-invented.frameUsage);
  });

  test('reports no frame usage for a card listed in both issuer groups with different values', async () => {
    const card = {
      cardUniqueId: 'synthetic-both',
      last4Digits: '5555',
      isDebitCard: false,
      bankAccountUniqueId: 'synthetic-bank',
      currentDebitDay: 10,
    };
    const group = (frameTotalOblForCardAmount: number) => ({
      frameLimitForCardAmount: 9000,
      cardLevelFrames: [],
      accountLevelFrames: accountFrames({ 'synthetic-both': frameTotalOblForCardAmount }),
    });
    mockPerCardResponses({
      frames: { bankIssuedCards: group(invented.frameUsage), calIssuedCards: group(invented.otherUsage) },
    });
    const { accounts } = await scraper('2026-02-01', [card]).fetchData();
    expect(accounts?.[0].calCard?.sharedFacility).toBeNull();
    // Ambiguous between the two groups, so neither the figure nor the balance fallback.
    expect(accounts?.[0].calCard).not.toHaveProperty('frameUsage');
    expect(accounts?.[0].balance).toBeUndefined();
  });

  test('reports no frame usage when the frames body carries no status code', async () => {
    mockPerCardResponses({
      omitFramesStatus: true,
      frames: {
        calIssuedCards: {
          frameLimitForCardAmount: 9000,
          cardLevelFrames: [],
          accountLevelFrames: accountFrames({ [cards[0].cardUniqueId]: invented.frameUsage }),
        },
      },
    });
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.accounts?.[0].calCard).not.toHaveProperty('frameUsage');
    expect(result.accounts?.[0].balance).toBeUndefined();
    // The blank is reported as unavailable metadata rather than as an issuer figure.
    expect(result.accounts?.[0].cardMetadataStatus).toBe('unavailable');
    expect(result.warnings).toEqual([{ accountNumber: cards[0].last4Digits, code: 'metadata-unavailable' }]);
  });

  test('leaves the shared facility unchanged for a card the gating accepts', async () => {
    const card = {
      cardUniqueId: 'synthetic-shared',
      last4Digits: '6666',
      isDebitCard: false,
      bankAccountUniqueId: 'synthetic-bank',
      currentDebitDay: 10,
    };
    mockPerCardResponses({
      frames: {
        calIssuedCards: {
          frameLimitForCardAmount: 9000,
          fictiveMaxAccAmt: 500.5,
          nextTotalDebitForAccount: 1500,
          nextTotalDebitDateForAccount: '2026-02-28',
          cardLevelFrames: [],
          accountLevelFrames: accountFrames({ 'synthetic-shared': invented.frameUsage }),
        },
      },
    });
    const { accounts } = await scraper('2026-02-01', [card]).fetchData();
    expect(accounts?.[0].calCard?.sharedFacility).toMatchObject({
      issuerGroup: 'calIssuedCards',
      limit: 9000,
      available: 500.5,
      nextPayment: 1500,
      nextPaymentDate: '2026-02-28',
      source: 'cal-frame-status',
    });
    expect(accounts?.[0].calCard?.frameUsage).toBe(invented.frameUsage);
  });

  test.each(['cardUniqueId', 'cardUniqueID'] as const)(
    'reads the revolving balance, cycle spend and fixed debit matched by %s',
    async cardKey => {
      mockPerCardResponses({ bigNumbers: bigNumbersBody(cardKey) });
      const { accounts } = await scraper('2026-02-01', [accountCards[0]]).fetchData();
      expect(accounts?.[0].calCard).toMatchObject({
        revolvingBalance: invented.revolvingBalance,
        cycleSpend: invented.cycleSpend,
        fixedDebit: invented.fixedDebit,
      });
    },
  );

  test('omits the big number figures for a card missing from the response', async () => {
    mockPerCardResponses({ bigNumbers: bigNumbersBody('cardUniqueId', 'synthetic-other') });
    const { accounts } = await scraper('2026-02-01', [accountCards[0]]).fetchData();
    expect(accounts?.[0].calCard).not.toHaveProperty('revolvingBalance');
    expect(accounts?.[0].calCard).not.toHaveProperty('cycleSpend');
    expect(accounts?.[0].calCard).not.toHaveProperty('fixedDebit');
  });

  test.each([{ someFlag: true }, {}, [], null, 'none'])(
    'treats a non numeric fixedDebitAmount (%j) as absent without losing the other figures',
    async fixedDebitAmount => {
      mockPerCardResponses({
        bigNumbers: bigNumbersBody('cardUniqueId', cards[0].cardUniqueId, additionalInfo(fixedDebitAmount)),
      });
      const { accounts } = await scraper('2026-02-01', [accountCards[0]]).fetchData();
      expect(accounts?.[0].calCard).not.toHaveProperty('fixedDebit');
      expect(accounts?.[0].calCard).toMatchObject({
        revolvingBalance: invented.revolvingBalance,
        cycleSpend: invented.cycleSpend,
      });
    },
  );

  test('picks the revolving row out of the other interest rows and carries the rates unrounded', async () => {
    mockPerCardResponses({ interests: interestsBody() });
    const { accounts } = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(accounts?.[0].calCard?.interest).toEqual({
      nominal: invented.nominal,
      effective: invented.effective,
      gapFromPrime: invented.gapFromPrime,
      validDate: invented.validDate,
      kind: 'revolving',
    });
  });

  test('leaves the interest undefined when the revolving row is absent', async () => {
    mockPerCardResponses({ interests: interestsBody(['קרדיט', '+30']) });
    const { accounts } = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(accounts?.[0].calCard).not.toHaveProperty('interest');
  });

  test.each([
    ['nominalInterestRate', undefined],
    ['effectiveInterestRate', 'invalid'],
    ['gapFromPrime', null],
  ])('leaves the interest undefined when %s is not a number', async (field, value) => {
    const rows = [{ ...interestRow(REVOLVING), [field]: value }];
    mockPerCardResponses({ interests: { statusCode: 1, result: { cardInterests: rows } } });
    const { accounts } = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(accounts?.[0].calCard).not.toHaveProperty('interest');
  });

  test('omits only an implausible valid date and keeps the rates', async () => {
    const rows = [{ ...interestRow(REVOLVING), interestValidDate: 'not a date' }];
    mockPerCardResponses({ interests: { statusCode: 1, result: { cardInterests: rows } } });
    const { accounts } = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(accounts?.[0].calCard?.interest).toEqual({
      nominal: invented.nominal,
      effective: invented.effective,
      gapFromPrime: invented.gapFromPrime,
      kind: 'revolving',
    });
  });

  const failures: [string, unknown][] = [
    ['a rejected request', new Error('synthetic transport failure')],
    ['a non success status', { statusCode: 0, result: null }],
    ['a garbage body', 'garbage'],
    ['an absent body', undefined],
    ['an unexpected body', { statusCode: 1, result: { bigNumbers: 'nope', cardInterests: 7 } }],
  ];

  test.each(failures)('%s from the big number call leaves only its own fields absent', async (_label, bigNumbers) => {
    mockPerCardResponses({ bigNumbers, interests: interestsBody() });
    const result = await scraper('2026-02-01', [accountCards[0]]).fetchData();
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.accounts?.[0].calCard).not.toHaveProperty('revolvingBalance');
    expect(result.accounts?.[0].calCard).not.toHaveProperty('cycleSpend');
    expect(result.accounts?.[0].calCard).not.toHaveProperty('fixedDebit');
    // The independent interest call and the transactions are untouched.
    expect(result.accounts?.[0].calCard?.interest?.nominal).toBe(invented.nominal);
    expect(result.accounts?.[0].txns.map(txn => txn.identifier)).toEqual(['synthetic-txn']);
  });

  test.each(failures)('%s from the interest call leaves only the interest absent', async (_label, interests) => {
    mockPerCardResponses({ bigNumbers: bigNumbersBody(), interests });
    const result = await scraper('2026-02-01', [accountCards[0]]).fetchData();
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.accounts?.[0].calCard).not.toHaveProperty('interest');
    expect(result.accounts?.[0].calCard).toMatchObject({
      revolvingBalance: invented.revolvingBalance,
      cycleSpend: invented.cycleSpend,
      fixedDebit: invented.fixedDebit,
    });
    expect(result.accounts?.[0].txns.map(txn => txn.identifier)).toEqual(['synthetic-txn']);
  });

  test('both new calls failing together still returns the card and its transactions', async () => {
    mockPerCardResponses({ bigNumbers: new Error('synthetic one'), interests: new Error('synthetic two') });
    const result = await scraper('2026-02-01', [accountCards[0]]).fetchData();
    expect(result.success).toBe(true);
    expect(result.accounts?.[0].calCard).toEqual({ isDebit: null, billingDay: null, sharedFacility: null });
    expect(result.accounts?.[0].txns).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('synthetic one');
  });

  test('requests the interests once per card and the big numbers once per bank account', async () => {
    await scraper('2026-02-01', accountCards).fetchData();
    const interestCalls = post.mock.calls.filter(([url]) => url.includes('GetCardsInterests'));
    expect(interestCalls.map(([, body]) => (body as { cardUniqueId: string }).cardUniqueId).sort()).toEqual(
      cards.map(card => card.cardUniqueId).sort(),
    );
    // One account-wide response answers for all three cards, so one request serves them.
    expect(bigNumbersCalls()).toEqual([{ bankAccountUniqueId: accountIds.first }]);
  });

  test('sends the bank account id to the big numbers call and the card id to the interests call', async () => {
    mockPerCardResponses({ bigNumbers: bigNumbersBody(), interests: interestsBody() });
    await scraper('2026-02-01', [accountCards[0]]).fetchData();
    expect(bigNumbersCalls()).toEqual([{ bankAccountUniqueId: accountIds.first }]);
    const interestCalls = post.mock.calls.filter(([url]) => url.includes('GetCardsInterests'));
    expect(interestCalls.map(([, body]) => body)).toEqual([{ cardUniqueId: cards[0].cardUniqueId }]);
  });

  test('two cards on one bank account share a single request and each keeps its own figures', async () => {
    const otherInfo = { totalBasketAmount: 11.11, totalCycleTransactions: 22.22, fixedDebitAmount: 33.33 };
    mockPerCardResponses({
      bigNumbers: accountWideBody({
        [cards[0].cardUniqueId]: additionalInfo(),
        [cards[1].cardUniqueId]: otherInfo,
      }),
    });
    const { accounts } = await scraper('2026-02-01', [accountCards[0], accountCards[1]]).fetchData();
    expect(bigNumbersCalls()).toEqual([{ bankAccountUniqueId: accountIds.first }]);
    expect(accounts?.[0].calCard).toMatchObject({
      revolvingBalance: invented.revolvingBalance,
      cycleSpend: invented.cycleSpend,
      fixedDebit: invented.fixedDebit,
    });
    expect(accounts?.[1].calCard).toMatchObject({
      revolvingBalance: otherInfo.totalBasketAmount,
      cycleSpend: otherInfo.totalCycleTransactions,
      fixedDebit: otherInfo.fixedDebitAmount,
    });
  });

  test('two cards on different bank accounts each get their own request and figures', async () => {
    const secondInfo = { totalBasketAmount: 44.44, totalCycleTransactions: 55.55, fixedDebitAmount: 66.66 };
    const byAccount: Record<string, unknown> = {
      [accountIds.first]: accountWideBody({ [cards[0].cardUniqueId]: additionalInfo() }),
      [accountIds.second]: accountWideBody({ [cards[1].cardUniqueId]: secondInfo }),
    };
    mockPerCardResponses({ bigNumbers: (id: unknown) => byAccount[String(id)] ?? null });
    const { accounts } = await scraper('2026-02-01', [
      accountCards[0],
      onAccount(cards[1], accountIds.second),
    ]).fetchData();
    expect(
      bigNumbersCalls()
        .map(body => body.bankAccountUniqueId)
        .sort(),
    ).toEqual([accountIds.first, accountIds.second].sort());
    expect(accounts?.[0].calCard).toMatchObject({ revolvingBalance: invented.revolvingBalance });
    expect(accounts?.[1].calCard).toMatchObject({
      revolvingBalance: secondInfo.totalBasketAmount,
      cycleSpend: secondInfo.totalCycleTransactions,
      fixedDebit: secondInfo.fixedDebitAmount,
    });
  });

  test('a card absent from the account wide response leaves its own figures absent only', async () => {
    mockPerCardResponses({ bigNumbers: accountWideBody({ [cards[1].cardUniqueId]: additionalInfo() }) });
    const { accounts } = await scraper('2026-02-01', [accountCards[0], accountCards[1]]).fetchData();
    expect(bigNumbersCalls()).toHaveLength(1);
    expect(accounts?.[0].calCard).not.toHaveProperty('revolvingBalance');
    expect(accounts?.[0].calCard).not.toHaveProperty('cycleSpend');
    expect(accounts?.[0].calCard).not.toHaveProperty('fixedDebit');
    expect(accounts?.[1].calCard).toMatchObject({
      revolvingBalance: invented.revolvingBalance,
      cycleSpend: invented.cycleSpend,
      fixedDebit: invented.fixedDebit,
    });
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['neither a string nor a finite number', { nested: true }],
  ])('a card whose bank account id is %s triggers no big numbers request', async (_label, bankAccountUniqueId) => {
    mockPerCardResponses({ bigNumbers: accountWideBody({ [cards[1].cardUniqueId]: additionalInfo() }) });
    const { accounts } = await scraper('2026-02-01', [
      onAccount(cards[0], bankAccountUniqueId),
      accountCards[1],
    ]).fetchData();
    expect(bigNumbersCalls()).toEqual([{ bankAccountUniqueId: accountIds.first }]);
    expect(accounts?.[0].calCard).not.toHaveProperty('revolvingBalance');
    expect(accounts?.[0].calCard).not.toHaveProperty('cycleSpend');
    expect(accounts?.[0].calCard).not.toHaveProperty('fixedDebit');
    expect(accounts?.[1].calCard).toMatchObject({ revolvingBalance: invented.revolvingBalance });
  });

  test('a numeric bank account id is normalised to a string and still keyed', async () => {
    const numericId = 4242;
    mockPerCardResponses({
      bigNumbers: (id: unknown) =>
        id === String(numericId) ? accountWideBody({ [cards[0].cardUniqueId]: additionalInfo() }) : null,
    });
    const { accounts } = await scraper('2026-02-01', [
      onAccount(cards[0], numericId),
      onAccount(cards[1], numericId),
    ]).fetchData();
    expect(bigNumbersCalls()).toEqual([{ bankAccountUniqueId: String(numericId) }]);
    expect(accounts?.[0].calCard).toMatchObject({ revolvingBalance: invented.revolvingBalance });
    expect(accounts?.[1].calCard).not.toHaveProperty('revolvingBalance');
  });

  // The account wide response returns several groups, so one card can be listed twice.
  const twoGroupsBody = (first: unknown, second: unknown) => ({
    statusCode: 1,
    result: {
      bigNumbers: [
        { cards: [{ cardUniqueId: 'synthetic-unrelated', additionalInfo: decoyInfo }] },
        { cards: [{ cardUniqueId: cards[0].cardUniqueId, additionalInfo: first }] },
        { cards: [{ cardUniqueId: cards[0].cardUniqueId, additionalInfo: second }] },
      ],
    },
  });

  test('the same card in two groups with identical figures keeps every figure', async () => {
    mockPerCardResponses({ bigNumbers: twoGroupsBody(additionalInfo(), additionalInfo()) });
    const { accounts } = await scraper('2026-02-01', [accountCards[0]]).fetchData();
    expect(accounts?.[0].calCard).toMatchObject({
      revolvingBalance: invented.revolvingBalance,
      cycleSpend: invented.cycleSpend,
      fixedDebit: invented.fixedDebit,
    });
  });

  test.each([
    ['totalBasketAmount', 'revolvingBalance'],
    ['totalCycleTransactions', 'cycleSpend'],
    ['fixedDebitAmount', 'fixedDebit'],
  ] as const)('a divergent %s omits only %s and keeps the figures the groups agree on', async (field, omitted) => {
    mockPerCardResponses({
      bigNumbers: twoGroupsBody(additionalInfo(), { ...additionalInfo(), [field]: 1.5 }),
    });
    const { accounts } = await scraper('2026-02-01', [accountCards[0]]).fetchData();
    const calCard = accounts?.[0].calCard;
    expect(calCard).not.toHaveProperty(omitted);
    const agreeing = {
      revolvingBalance: invented.revolvingBalance,
      cycleSpend: invented.cycleSpend,
      fixedDebit: invented.fixedDebit,
    };
    for (const [name, value] of Object.entries(agreeing))
      if (name !== omitted) expect(calCard).toHaveProperty(name, value);
  });

  test.each(failures)(
    '%s from one bank account leaves only that account cards figures absent',
    async (_label, failed) => {
      const good = accountWideBody({ [cards[1].cardUniqueId]: additionalInfo() });
      mockPerCardResponses({
        bigNumbers: (id: unknown) => (id === accountIds.first ? failed : good),
        interests: interestsBody(),
      });
      const result = await scraper('2026-02-01', [accountCards[0], onAccount(cards[1], accountIds.second)]).fetchData();
      expect(result.success).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.accounts?.[0].calCard).not.toHaveProperty('revolvingBalance');
      expect(result.accounts?.[0].calCard).not.toHaveProperty('cycleSpend');
      expect(result.accounts?.[0].calCard).not.toHaveProperty('fixedDebit');
      // The interest call and the transactions of the failed account are untouched.
      expect(result.accounts?.[0].calCard?.interest?.nominal).toBe(invented.nominal);
      expect(result.accounts?.[0].txns.map(txn => txn.identifier)).toEqual(['synthetic-txn']);
      // The other bank account is unaffected.
      expect(result.accounts?.[1].calCard).toMatchObject({
        revolvingBalance: invented.revolvingBalance,
        cycleSpend: invented.cycleSpend,
        fixedDebit: invented.fixedDebit,
      });
    },
  );

  test('drops the revolving rate and warns when the interests response carries several revolving rows', async () => {
    const rows = [interestRow('קרדיט'), interestRow(REVOLVING), { ...interestRow(REVOLVING), gapFromPrime: 1.25 }];
    mockPerCardResponses({ interests: { statusCode: 1, result: { cardInterests: rows } } });
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.accounts?.[0].calCard).not.toHaveProperty('interest');
    // The drop reaches a person rather than only the debug log.
    expect(result.warnings).toEqual([{ accountNumber: cards[0].last4Digits, code: 'interest-rate-ambiguous' }]);
  });

  test('a response with no revolving row at all is a normal absence and warns about nothing', async () => {
    mockPerCardResponses({ interests: interestsBody(['קרדיט', '+30']) });
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.accounts?.[0].calCard).not.toHaveProperty('interest');
    expect(result.warnings).toEqual([]);
  });

  test('keeps the rate when only other credit types sit beside one revolving row', async () => {
    mockPerCardResponses({ interests: interestsBody(['קרדיט', '+30', REVOLVING]) });
    const { accounts } = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(accounts?.[0].calCard?.interest?.nominal).toBe(invented.nominal);
  });

  // A card id key is only an id when it carries a usable one, so a blank or numeric
  // value leaves the row card scoped instead of silently mismatching the real card.
  test.each([
    ['this card', cards[0].cardUniqueId],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['blank space', '   '],
    ['the number zero', 0],
    ['a number', 12],
  ])('keeps the revolving rate when the row card id is %s', async (_label, cardUniqueId) => {
    const rows = [{ ...interestRow(REVOLVING), cardUniqueId }];
    mockPerCardResponses({ interests: { statusCode: 1, result: { cardInterests: rows } } });
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.accounts?.[0].calCard?.interest?.nominal).toBe(invented.nominal);
    expect(result.warnings).toEqual([]);
  });

  test.each(['cardUniqueId', 'cardUniqueID'] as const)(
    'excludes a revolving row whose %s names a different card',
    async cardKey => {
      const rows = [{ ...interestRow(REVOLVING), [cardKey]: 'synthetic-other' }];
      mockPerCardResponses({ interests: { statusCode: 1, result: { cardInterests: rows } } });
      const result = await scraper('2026-02-01', [cards[0]]).fetchData();
      expect(result.accounts?.[0].calCard).not.toHaveProperty('interest');
      expect(result.warnings).toEqual([]);
    },
  );

  // The rows can arrive nested under a parent object instead of at the top level.
  test.each([
    ['names this card', cards[0].cardUniqueId],
    ['names no card', undefined],
  ])('reads revolving rows nested under a parent that %s', async (_label, cardUniqueId) => {
    const parent: Record<string, unknown> = { interests: [interestRow('קרדיט'), interestRow(REVOLVING)] };
    if (cardUniqueId !== undefined) parent.cardUniqueId = cardUniqueId;
    mockPerCardResponses({ interests: { statusCode: 1, result: { cardInterests: [parent] } } });
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.accounts?.[0].calCard?.interest?.nominal).toBe(invented.nominal);
    expect(result.warnings).toEqual([]);
  });

  test('ignores revolving rows nested under a parent that names a different card', async () => {
    const parent = { cardUniqueId: 'synthetic-other', interests: [interestRow(REVOLVING)] };
    mockPerCardResponses({ interests: { statusCode: 1, result: { cardInterests: [parent] } } });
    const result = await scraper('2026-02-01', [cards[0]]).fetchData();
    expect(result.accounts?.[0].calCard).not.toHaveProperty('interest');
    expect(result.warnings).toEqual([]);
  });
});
