import { calCardDetails } from './visa-cal-metadata';
import moment from 'moment';
import { type HTTPRequest, type Frame, type Page } from 'puppeteer';
import { getDebug } from '../helpers/debug';
import { clickButton, elementPresentOnPage, pageEval, waitUntilElementFound } from '../helpers/elements-interactions';
import { fetchPost } from '../helpers/fetch';
import { getCurrentUrl, waitForNavigation } from '../helpers/navigation';
import { getFromSessionStorage } from '../helpers/storage';
import { filterOldTransactions, getRawTransaction } from '../helpers/transactions';
import { ScraperErrorTypes } from './errors';
import { waitUntil } from '../helpers/waiting';
import {
  CardType,
  TransactionStatuses,
  TransactionTypes,
  type CalCardDetails,
  type Transaction,
  type TransactionsAccount,
} from '../transactions';
import { BaseScraperWithBrowser, LoginResults, type LoginOptions } from './base-scraper-with-browser';
import { type ScraperScrapingResult, type ScraperOptions } from './interface';

const apiHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  Origin: 'https://digital-web.cal-online.co.il',
  Referer: 'https://digital-web.cal-online.co.il',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Fetch-Site': 'same-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
};
const LOGIN_URL = 'https://www.cal-online.co.il/';
const TRANSACTIONS_REQUEST_ENDPOINT =
  'https://api.cal-online.co.il/Transactions/api/transactionsDetails/getCardTransactionsDetails';
const FRAMES_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Frames/api/Frames/GetFrameStatus';
const BIG_NUMBERS_REQUEST_ENDPOINT =
  'https://api.cal-online.co.il/Transactions/api/financeDashboard/getBigNumberAndDetails';
const CARD_INTERESTS_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Cards/api/interests/GetCardsInterests';
const PENDING_TRANSACTIONS_REQUEST_ENDPOINT =
  'https://api.cal-online.co.il/Transactions/api/approvals/getClearanceRequests';
const SSO_AUTHORIZATION_REQUEST_ENDPOINT = 'https://connect.cal-online.co.il/col-rest/calconnect/authentication/SSO';

// Both bodies below are captured from the live site. getBigNumberAndDetails is scoped
// to a bank account and answers for every card on it, so its response is matched by
// card id. GetCardsInterests is scoped to a single card and its response carries no
// card id at all, so it is card-scoped by its request rather than by any field.
const bigNumbersRequestBody = (bankAccountUniqueId: string) => ({ bankAccountUniqueId });
const cardInterestsRequestBody = (cardUniqueId: string) => ({ cardUniqueId });

// The revolving credit row. Only this row may feed the revolving rate, because a
// rate taken from any other row would silently corrupt a payoff plan.
const REVOLVING_INTEREST_NAME = 'א.מתגלגל';

const InvalidPasswordMessage = 'שם המשתמש או הסיסמה שהוזנו שגויים';
const ChangePasswordMessage = 'להחליף סיסמה';
const ChangePasswordSubtitle = 'הגיע הזמן לסיסמה חדשה';
const ChangePasswordUrl = '/change-password';
// The username/password tab of the login iframe. The legacy #regular-login id is kept as a fallback.
const PasswordLoginTabSelector = '[role="tab"][alt="כניסה עם שם משתמש"], #regular-login';

const debug = getDebug('visa-cal');

enum TrnTypeCode {
  regular = '5',
  credit = '6',
  installments = '8',
  standingOrder = '9',
}

interface ScrapedTransaction {
  amtBeforeConvAndIndex: number;
  branchCodeDesc: string;
  cashAccManagerName: null;
  cashAccountManager: null;
  cashAccountTrnAmt: number;
  chargeExternalToCardComment: string;
  comments: [];
  curPaymentNum: number;
  debCrdCurrencySymbol: CurrencySymbol;
  debCrdDate: string;
  debitSpreadInd: boolean;
  discountAmount: unknown;
  discountReason: unknown;
  immediateComments: [];
  isImmediateCommentInd: boolean;
  isImmediateHHKInd: boolean;
  isMargarita: boolean;
  isSpreadPaymenstAbroad: boolean;
  linkedComments: [];
  merchantAddress: string;
  merchantName: string;
  merchantPhoneNo: string;
  numOfPayments: number;
  onGoingTransactionsComment: string;
  refundInd: boolean;
  roundingAmount: unknown;
  roundingReason: unknown;
  tokenInd: 0;
  tokenNumberPart4: '';
  transCardPresentInd: boolean;
  transTypeCommentDetails: [];
  trnAmt: number;
  trnCurrencySymbol: CurrencySymbol;
  trnExacWay: number;
  trnIntId: string;
  trnNumaretor: number;
  trnPurchaseDate: string;
  trnType: string;
  trnTypeCode: TrnTypeCode;
  walletProviderCode: 0;
  walletProviderDesc: '';
  earlyPaymentInd: boolean;
}
interface ScrapedPendingTransaction {
  merchantID: string;
  merchantName: string;
  trnPurchaseDate: string;
  walletTranInd: number;
  transactionsOrigin: number;
  trnAmt: number;
  tpaApprovalAmount: unknown;
  trnCurrencySymbol: CurrencySymbol;
  trnTypeCode: TrnTypeCode;
  trnType: string;
  branchCodeDesc: string;
  transCardPresentInd: boolean;
  j5Indicator: string;
  numberOfPayments: number;
  firstPaymentAmount: number;
  transTypeCommentDetails: [];
}
interface InitResponse {
  result: {
    cards: {
      cardUniqueId: string;
      last4Digits: string;
      [key: string]: unknown;
    }[];
  };
}
type CurrencySymbol = string;
interface CardTransactionDetailsError {
  title: string;
  statusCode: number;
}
interface CardTransactionDetails extends CardTransactionDetailsError {
  result: {
    bankAccounts: {
      bankAccountNum: string;
      bankName: string;
      choiceExternalTransactions: any;
      currentBankAccountInd: boolean;
      debitDates: {
        basketAmountComment: unknown;
        choiceHHKDebit: number;
        date: string;
        debitReason: unknown;
        fixDebitAmount: number;
        fromPurchaseDate: string;
        isChoiceRepaiment: boolean;
        toPurchaseDate: string;
        totalBasketAmount: number;
        totalDebits: {
          currencySymbol: CurrencySymbol;
          amount: number;
        }[];
        transactions: ScrapedTransaction[];
      }[];
      immidiateDebits: { totalDebits: []; debitDays: [] };
    }[];
    blockedCardInd: boolean;
  };
  statusCode: 1;
  statusDescription: string;
  statusTitle: string;
}
interface CardPendingTransactionDetails extends CardTransactionDetailsError {
  result: {
    cardsList: {
      cardUniqueID: string;
      authDetalisList: ScrapedPendingTransaction[];
    }[];
  };
  statusCode: 1;
  statusDescription: string;
  statusTitle: string;
}

interface CardLevelFrame {
  cardUniqueId: string;
  nextTotalDebit?: number | null;
  nextDebitDate?: string | null;
}

interface IssuedCardsGroup {
  nextTotalDebitForAccount?: number;
  nextTotalDebitDateForAccount?: string | null;
  frameLimitForCardAmount?: number;
  fictiveMaxAccAmt?: number;
  cardLevelFrames?: CardLevelFrame[] | null;
}

interface FramesResponse {
  statusCode?: number;
  result?: {
    calIssuedCards?: IssuedCardsGroup | null;
    bankIssuedCards?: IssuedCardsGroup | null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidFramesResponse(value: unknown): value is FramesResponse {
  if (!isRecord(value) || (value.statusCode !== undefined && value.statusCode !== 1) || !isRecord(value.result)) {
    return false;
  }

  const { result } = value;
  return ['calIssuedCards', 'bankIssuedCards'].every(key => {
    const group = result[key];
    if (group == null) return true;
    if (!isRecord(group)) return false;
    if (group.cardLevelFrames == null) return true;
    return (
      Array.isArray(group.cardLevelFrames) &&
      group.cardLevelFrames.every(
        frame =>
          isRecord(frame) &&
          typeof frame.cardUniqueId === 'string' &&
          frame.cardUniqueId.trim().length > 0 &&
          (frame.nextTotalDebit == null ||
            (typeof frame.nextTotalDebit === 'number' && Number.isFinite(frame.nextTotalDebit))) &&
          (frame.nextDebitDate == null || typeof frame.nextDebitDate === 'string'),
      )
    );
  });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// CAL keys the card as cardUniqueId on some responses and cardUniqueID on others,
// so accept either spelling of that one key name.
function matchesCard(entry: Record<string, unknown>, cardUniqueId: string): boolean {
  return Object.keys(entry).some(key => key.toLowerCase() === 'carduniqueid' && entry[key] === cardUniqueId);
}

function isSuccessResult(response: unknown): Record<string, unknown> | undefined {
  return isRecord(response) && response.statusCode === 1 && isRecord(response.result) ? response.result : undefined;
}

type CardBigNumbers = Pick<CalCardDetails, 'revolvingBalance' | 'cycleSpend' | 'fixedDebit'>;

// Any shape other than the expected one leaves every figure absent rather than throwing.
function parseBigNumbers(response: unknown, cardUniqueId: string): CardBigNumbers {
  const groups = isSuccessResult(response)?.bigNumbers;
  if (!Array.isArray(groups)) return {};
  for (const group of groups) {
    const cards = isRecord(group) && Array.isArray(group.cards) ? group.cards : [];
    for (const entry of cards) {
      if (!isRecord(entry) || !matchesCard(entry, cardUniqueId) || !isRecord(entry.additionalInfo)) continue;
      const info = entry.additionalInfo;
      const figures: CardBigNumbers = {};
      const revolvingBalance = finiteNumber(info.totalBasketAmount);
      if (revolvingBalance !== undefined) figures.revolvingBalance = revolvingBalance;
      const cycleSpend = finiteNumber(info.totalCycleTransactions);
      if (cycleSpend !== undefined) figures.cycleSpend = cycleSpend;
      // fixedDebitAmount is an object on a card with no fixed debit, so anything
      // that is not a finite number counts as absent.
      const fixedDebit = finiteNumber(info.fixedDebitAmount);
      if (fixedDebit !== undefined) figures.fixedDebit = fixedDebit;
      return figures;
    }
  }
  return {};
}

function isRevolvingRow(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.interestName === REVOLVING_INTEREST_NAME;
}

// Whether the object carries a card id key at all, in either spelling.
function namesACard(entry: Record<string, unknown>): boolean {
  return Object.keys(entry).some(key => key.toLowerCase() === 'carduniqueid');
}

// The interests response is one card's credit types, so the rows carry no card id and
// are trusted because the request named a single card. A card id is honoured only
// where a response actually carries one, on the row or on a parent holding the rows,
// so a future account-wide shape cannot hand this card another card's rate.
function revolvingRowsForCard(entries: unknown[], cardUniqueId: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (isRevolvingRow(entry)) {
      if (!namesACard(entry) || matchesCard(entry, cardUniqueId)) rows.push(entry);
      continue;
    }
    if (namesACard(entry) && !matchesCard(entry, cardUniqueId)) continue;
    for (const value of Object.values(entry)) {
      if (!Array.isArray(value)) continue;
      for (const nested of value)
        if (isRevolvingRow(nested) && (!namesACard(nested) || matchesCard(nested, cardUniqueId))) rows.push(nested);
    }
  }
  return rows;
}

// Only the revolving row is read. Without it the rate stays absent, so the caller
// can ask for it by hand instead of being handed another row's rate.
function parseCardInterest(response: unknown, cardUniqueId: string): CalCardDetails['interest'] {
  const entries = isSuccessResult(response)?.cardInterests;
  if (!Array.isArray(entries)) return undefined;
  const candidates = revolvingRowsForCard(entries, cardUniqueId);
  // One card has one revolving row. Several of them is the signal that CAL moved to
  // an account-wide shape, and then no row can be attributed to this card.
  if (candidates.length > 1) {
    debug('the card interests response looked account wide, so the revolving rate was dropped');
    return undefined;
  }
  const row = candidates[0];
  if (!isRecord(row)) return undefined;
  const nominal = finiteNumber(row.nominalInterestRate),
    effective = finiteNumber(row.effectiveInterestRate),
    gapFromPrime = finiteNumber(row.gapFromPrime);
  if (nominal === undefined || effective === undefined || gapFromPrime === undefined) return undefined;
  const interest: NonNullable<CalCardDetails['interest']> = { nominal, effective, gapFromPrime, kind: 'revolving' };
  const validDate = row.interestValidDate;
  if (
    typeof validDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(validDate) &&
    Number.isFinite(Date.parse(validDate))
  )
    interest.validDate = validDate;
  return interest;
}

// The init payload reports the bank account id as either a string or a number. A card
// with anything else has no account to ask about, so it gets no request at all.
function bankAccountKey(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

// An optional detail request must never fail the scrape, so a rejected request
// degrades to an absent body and from there to absent fields. The label only names
// the scope of the request for the debug line and must never be an account id.
async function fetchOptionalCardDetail(
  endpoint: string,
  body: Record<string, unknown>,
  label: string,
  Authorization: string,
  xSiteId: string,
): Promise<unknown> {
  return fetchPost<unknown>(endpoint, body, {
    Authorization,
    'X-Site-Id': xSiteId,
    'Content-Type': 'application/json',
    ...apiHeaders,
  }).catch(() => {
    debug('optional detail request failed for %s', label);
    return undefined;
  });
}

interface AuthModule {
  auth: {
    calConnectToken: string | null;
  };
}

function isAuthModule(result: any): result is AuthModule {
  return Boolean(result?.auth?.calConnectToken && String(result.auth.calConnectToken).trim());
}

function authModuleOrUndefined(result: any): AuthModule | undefined {
  return isAuthModule(result) ? result : undefined;
}

function isPending(
  transaction: ScrapedTransaction | ScrapedPendingTransaction,
): transaction is ScrapedPendingTransaction {
  return (transaction as ScrapedTransaction).debCrdDate === undefined; // an arbitrary field that only appears in a completed transaction
}

function isCardTransactionDetails(
  result: CardTransactionDetails | CardTransactionDetailsError,
): result is CardTransactionDetails {
  return (result as CardTransactionDetails).result !== undefined;
}

function isCardPendingTransactionDetails(
  result: CardPendingTransactionDetails | CardTransactionDetailsError,
): result is CardPendingTransactionDetails {
  return (result as CardPendingTransactionDetails).result !== undefined;
}

async function getLoginFrame(page: Page) {
  let frame: Frame | null = null;
  debug('wait until login frame found');
  await waitUntil(
    () => {
      frame = page.frames().find(f => f.url().includes('connect')) || null;
      return Promise.resolve(!!frame);
    },
    'wait for iframe with login form',
    10000,
    1000,
  );

  if (!frame) {
    debug('failed to find login frame for 10 seconds');
    throw new Error('failed to extract login iframe');
  }

  return frame;
}

async function hasInvalidPasswordError(page: Page) {
  const frame = await getLoginFrame(page);
  const errorFound = await elementPresentOnPage(frame, 'div.general-error > div');
  const errorMessage = errorFound
    ? await pageEval(frame, 'div.general-error > div', '', item => {
        return (item as HTMLDivElement).innerText;
      })
    : '';
  return errorMessage === InvalidPasswordMessage;
}

async function hasChangePasswordForm(page: Page) {
  // Check if any frame navigated to the change-password route
  const changePasswordFrame = page.frames().find(f => {
    const url = f.url();
    return url.includes('connect.cal-online.co.il') && url.includes(ChangePasswordUrl);
  });
  if (changePasswordFrame) {
    return true;
  }

  try {
    const frame = await getLoginFrame(page);

    // Check for the change-password Angular component
    if (await elementPresentOnPage(frame, 'change-password')) {
      return true;
    }

    // Check for the change password title element
    if (await elementPresentOnPage(frame, '.change-password-title')) {
      return true;
    }

    // Check for the change password subtitle text
    if (await elementPresentOnPage(frame, '.change-password-subtitle')) {
      const subtitleText = await pageEval(frame, '.change-password-subtitle', '', item => {
        return (item as HTMLElement).innerText.trim();
      });
      if (subtitleText.includes(ChangePasswordSubtitle)) {
        return true;
      }
    }

    // Legacy: check for the old .err-desc based change password message
    const errorFound = await elementPresentOnPage(frame, '.err-desc');
    if (errorFound) {
      const errText = await pageEval(frame, '.err-desc', '', item => {
        return (item as HTMLElement).innerText.trim();
      });
      return errText.includes(ChangePasswordMessage);
    }
  } catch (e) {
    debug('failed to check change password form in login frame: %s', (e as Error).message);
  }
  return false;
}

function getPossibleLoginResults() {
  debug('return possible login results');
  const urls: LoginOptions['possibleResults'] = {
    [LoginResults.Success]: [/dashboard/i],
    [LoginResults.InvalidPassword]: [
      async (options?: { page?: Page }) => {
        const page = options?.page;
        if (!page) {
          return false;
        }
        return hasInvalidPasswordError(page);
      },
    ],
    // [LoginResults.AccountBlocked]: [], // TODO add when reaching this scenario
    [LoginResults.ChangePassword]: [
      async (options?: { page?: Page }) => {
        const page = options?.page;
        if (!page) {
          return false;
        }
        return hasChangePasswordForm(page);
      },
    ],
  };
  return urls;
}

function createLoginFields(credentials: ScraperSpecificCredentials) {
  debug('create login fields for username and password');
  return [
    { selector: '[formcontrolname="userName"]', value: credentials.username },
    { selector: '[formcontrolname="password"]', value: credentials.password },
  ];
}

function convertParsedDataToTransactions(
  data: CardTransactionDetails[],
  pendingData?: CardPendingTransactionDetails | null,
  options?: ScraperOptions,
): Transaction[] {
  const pendingTransactions = pendingData?.result
    ? pendingData.result.cardsList.flatMap(card => card.authDetalisList)
    : [];

  const bankAccounts = data.flatMap(monthData => monthData.result.bankAccounts);
  const regularDebitDays = bankAccounts.flatMap(accounts => accounts.debitDates);
  const immediateDebitDays = bankAccounts.flatMap(accounts => accounts.immidiateDebits.debitDays);
  const completedTransactions = [...regularDebitDays, ...immediateDebitDays].flatMap(
    debitDate => debitDate.transactions,
  );

  const all: (ScrapedTransaction | ScrapedPendingTransaction)[] = [...pendingTransactions, ...completedTransactions];

  return all.map(transaction => {
    const numOfPayments = isPending(transaction) ? transaction.numberOfPayments : transaction.numOfPayments;
    const installments = numOfPayments
      ? {
          number: isPending(transaction) ? 1 : transaction.curPaymentNum,
          total: numOfPayments,
        }
      : undefined;

    const date = moment(transaction.trnPurchaseDate);

    const chargedAmount = (isPending(transaction) ? transaction.trnAmt : transaction.amtBeforeConvAndIndex) * -1;
    const originalAmount = transaction.trnAmt * (transaction.trnTypeCode === TrnTypeCode.credit ? 1 : -1);

    const result: Transaction = {
      identifier: !isPending(transaction) ? transaction.trnIntId : undefined,
      type: [TrnTypeCode.regular, TrnTypeCode.standingOrder].includes(transaction.trnTypeCode)
        ? TransactionTypes.Normal
        : TransactionTypes.Installments,
      status: isPending(transaction) ? TransactionStatuses.Pending : TransactionStatuses.Completed,
      date: installments ? date.add(installments.number - 1, 'month').toISOString() : date.toISOString(),
      processedDate: isPending(transaction) ? date.toISOString() : new Date(transaction.debCrdDate).toISOString(),
      originalAmount,
      originalCurrency: transaction.trnCurrencySymbol,
      chargedAmount,
      chargedCurrency: !isPending(transaction) ? transaction.debCrdCurrencySymbol : undefined,
      description: transaction.merchantName,
      memo: transaction.transTypeCommentDetails.toString(),
      category: transaction.branchCodeDesc,
    };

    if (installments) {
      result.installments = installments;
    }

    if (options?.includeRawTransaction) {
      result.rawTransaction = getRawTransaction(transaction);
    }

    return result;
  });
}

type ScraperSpecificCredentials = { username: string; password: string };

class VisaCalScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  private authorization: string | undefined = undefined;

  private authRequestPromise: Promise<HTTPRequest | undefined> | undefined;

  openLoginPopup = async () => {
    debug('open login popup, wait until login button available');
    await waitUntilElementFound(this.page, '#ccLoginDesktopBtn', true);
    debug('click on the login button');
    await clickButton(this.page, '#ccLoginDesktopBtn');
    debug('get the frame that holds the login');
    const frame = await getLoginFrame(this.page);
    debug('wait until the password login tab header is available');
    await waitUntilElementFound(frame, PasswordLoginTabSelector);
    // Clicking the tab navigates the iframe, and a click that lands before its app is ready is ignored.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      debug(`navigate to the password login tab, attempt ${attempt}`);
      const tabFrame = await getLoginFrame(this.page);
      await clickButton(tabFrame, PasswordLoginTabSelector).catch(() => debug('password login tab not clickable'));
      let loginFrame = null as Frame | null;
      try {
        await waitUntil(
          async () => {
            const current: Frame = await getLoginFrame(this.page);
            const userName = await current.$('[formcontrolname="userName"]').catch(() => null);
            loginFrame = userName && (await userName.isVisible().catch(() => false)) ? current : null;
            return !!loginFrame;
          },
          'wait until the password login form is visible',
          5000,
          250,
        );
      } catch {
        debug('password login form did not open');
      }
      if (loginFrame) {
        return loginFrame;
      }
    }
    throw new Error('failed to open the password login tab');
  };

  async getCards(): Promise<InitResponse['result']['cards']> {
    const initData = await waitUntil(
      () => getFromSessionStorage<InitResponse>(this.page, 'init'),
      'get init data in session storage',
      10000,
      1000,
    );
    if (!initData) {
      throw new Error('could not find "init" data in session storage');
    }
    return initData?.result.cards.map(
      ({ cardUniqueId, last4Digits, isDebitCard, currentDebitDay, bankAccountUniqueId }) => ({
        cardUniqueId,
        last4Digits,
        isDebitCard,
        currentDebitDay,
        bankAccountUniqueId,
      }),
    );
  }

  async getAuthorizationHeader() {
    if (!this.authorization) {
      debug('fetching authorization header');
      const authModule = await waitUntil(
        async () => authModuleOrUndefined(await getFromSessionStorage<AuthModule>(this.page, 'auth-module')),
        'get authorization header with valid token in session storage',
        10_000,
        50,
      );
      return `CALAuthScheme ${authModule.auth.calConnectToken}`;
    }
    return this.authorization;
  }

  async getXSiteId() {
    /*
      I don't know if the constant below will change in the feature.
      If so, use the next code:

      return this.page.evaluate(() => new Ut().xSiteId);

      To get the classname search for 'xSiteId' in the page source
      class Ut {
        constructor(_e, on, yn) {
            this.store = _e,
            this.config = on,
            this.eventBusService = yn,
            this.xSiteId = "09031987-273E-2311-906C-8AF85B17C8D9",
    */
    return Promise.resolve('09031987-273E-2311-906C-8AF85B17C8D9');
  }

  getLoginOptions(credentials: ScraperSpecificCredentials): LoginOptions {
    this.authRequestPromise = this.page
      .waitForRequest(SSO_AUTHORIZATION_REQUEST_ENDPOINT, { timeout: 10_000 })
      .catch(e => {
        debug('error while waiting for the token request', e);
        return undefined;
      });
    return {
      loginUrl: `${LOGIN_URL}`,
      fields: createLoginFields(credentials),
      submitButtonSelector: 'button[type="submit"]',
      possibleResults: getPossibleLoginResults(),
      checkReadiness: async () => waitUntilElementFound(this.page, '#ccLoginDesktopBtn'),
      preAction: this.openLoginPopup,
      postAction: async () => {
        try {
          await waitForNavigation(this.page);
          const currentUrl = await getCurrentUrl(this.page);
          if (currentUrl.endsWith('site-tutorial')) {
            await clickButton(this.page, 'button.btn-close');
          }
          const request = await this.authRequestPromise;
          this.authorization = String(request?.headers().authorization || '').trim();
        } catch (e) {
          const currentUrl = await getCurrentUrl(this.page);
          if (currentUrl.endsWith('dashboard')) return;
          const requiresChangePassword = await hasChangePasswordForm(this.page);
          if (requiresChangePassword) return;
          throw e;
        }
      },
      userAgent: apiHeaders['User-Agent'],
    };
  }

  private async fetchCardData(
    card: { cardUniqueId: string; last4Digits: string; [key: string]: unknown },
    bigNumbersResponse: unknown,
    startMoment: moment.Moment,
    startDate: Date,
    futureMonthsToScrape: number,
    Authorization: string,
    xSiteId: string,
  ): Promise<TransactionsAccount> {
    debug('fetch frames (misgarot) for card %s', card.cardUniqueId);
    const frameResponse = await fetchPost<unknown>(
      FRAMES_REQUEST_ENDPOINT,
      { cardsForFrameData: [{ cardUniqueId: card.cardUniqueId }] },
      {
        Authorization,
        'X-Site-Id': xSiteId,
        'Content-Type': 'application/json',
        ...apiHeaders,
      },
    ).catch(() => {
      throw new Error('CAL card metadata retrieval failed');
    });

    // Observed provider response for a card without available frame data.
    // It must not abort transaction collection or masquerade as confirmed absence.
    const metadataUnavailable =
      isRecord(frameResponse) && typeof frameResponse.statusCode === 'number' && frameResponse.statusCode !== 1;
    const frames = metadataUnavailable ? { result: {} } : frameResponse;
    if (!isValidFramesResponse(frames)) {
      throw new Error('CAL card metadata response is invalid');
    }

    // Look for card-level frame in both calIssuedCards and bankIssuedCards
    const bankIssuedFrame = frames.result?.bankIssuedCards?.cardLevelFrames?.find(
      (f: CardLevelFrame) => f.cardUniqueId === card.cardUniqueId,
    );

    const calIssuedFrame = frames.result?.calIssuedCards?.cardLevelFrames?.find(
      (f: CardLevelFrame) => f.cardUniqueId === card.cardUniqueId,
    );

    let frame: CardLevelFrame | undefined;
    let cardType: CardType | undefined;

    if (bankIssuedFrame) {
      frame = bankIssuedFrame;
      cardType = CardType.BankIssued;
    } else if (calIssuedFrame) {
      frame = calIssuedFrame;
      cardType = CardType.CompanyIssued;
    }

    debug('searching for frame for card %s, found: %O', card.cardUniqueId, frame);
    debug('card type for card %s: %s', card.cardUniqueId, cardType);

    const balanceDate: string | null | undefined = frame?.nextDebitDate;

    // An optional request that can fail without touching the account-wide figures
    // passed in, the transactions below, or the rest of the card metadata.
    const cardInterestsPromise = fetchOptionalCardDetail(
      CARD_INTERESTS_REQUEST_ENDPOINT,
      cardInterestsRequestBody(card.cardUniqueId),
      card.cardUniqueId,
      Authorization,
      xSiteId,
    );

    const finalMonthToFetchMoment = moment().add(futureMonthsToScrape, 'month').startOf('month');
    const months = finalMonthToFetchMoment.diff(startMoment.clone().startOf('month'), 'months');
    const allMonthsData: CardTransactionDetails[] = [];

    debug(`fetch pending transactions for card ${card.cardUniqueId}`);
    let pendingData = await fetchPost(
      PENDING_TRANSACTIONS_REQUEST_ENDPOINT,
      { cardUniqueIDArray: [card.cardUniqueId] },
      {
        Authorization,
        'X-Site-Id': xSiteId,
        'Content-Type': 'application/json',
        ...apiHeaders,
      },
    );

    debug(`fetch completed transactions for card ${card.cardUniqueId}`);
    for (let i = 0; i <= months; i++) {
      const month = finalMonthToFetchMoment.clone().subtract(i, 'months');
      const monthData = await fetchPost(
        TRANSACTIONS_REQUEST_ENDPOINT,
        { cardUniqueId: card.cardUniqueId, month: month.format('M'), year: month.format('YYYY') },
        {
          Authorization,
          'X-Site-Id': xSiteId,
          'Content-Type': 'application/json',
          ...apiHeaders,
        },
      );

      if (monthData?.statusCode !== 1)
        throw new Error(
          `failed to fetch transactions for card ${card.last4Digits}. Message: ${monthData?.title || ''}`,
        );

      if (!isCardTransactionDetails(monthData)) {
        throw new Error('monthData is not of type CardTransactionDetails');
      }

      allMonthsData.push(monthData);
    }

    if (pendingData?.statusCode !== 1 && pendingData?.statusCode !== 96) {
      debug(`failed to fetch pending transactions for card ${card.last4Digits}. Message: ${pendingData?.title || ''}`);
      pendingData = null;
    } else if (!isCardPendingTransactionDetails(pendingData)) {
      debug('pendingData is not of type CardTransactionDetails');
      pendingData = null;
    }

    const transactions = convertParsedDataToTransactions(allMonthsData, pendingData, this.options);

    debug('filter out old transactions');
    const txns =
      (this.options.outputData?.enableTransactionsFilterByDate ?? true)
        ? filterOldTransactions(transactions, moment(startDate), this.options.combineInstallments || false)
        : transactions;

    const calCard = calCardDetails(card, frameResponse);
    const cardInterestsResponse = await cardInterestsPromise;
    Object.assign(calCard, parseBigNumbers(bigNumbersResponse, card.cardUniqueId));
    const interest = parseCardInterest(cardInterestsResponse, card.cardUniqueId);
    if (interest !== undefined) calCard.interest = interest;

    const balanceAmount = frame?.nextTotalDebit;
    // Cards sharing one credit frame have no card-level frame, so their only
    // reported debt is the per-card frame usage. Negated like the primary value.
    const debitAmount = balanceAmount != null ? balanceAmount : calCard.frameUsage;

    const result: TransactionsAccount = {
      txns,
      balance: debitAmount != null ? -debitAmount : undefined,
      balanceDate: balanceDate != null ? balanceDate : undefined,
      accountNumber: card.last4Digits,
      cardType,
      calCard,
      cardMetadataStatus: metadataUnavailable ? 'unavailable' : 'available',
      // Group limits can be shared; no card-specific limit is established by this response.
    };

    return result;
  }

  async fetchData(): Promise<ScraperScrapingResult> {
    const defaultStartMoment = moment().subtract(1, 'years').subtract(6, 'months').add(1, 'day').startOf('day');
    const startDate = moment(this.options.startDate || defaultStartMoment)
      .startOf('day')
      .toDate();
    const startMoment = moment.max(defaultStartMoment, moment(startDate));
    debug(`fetch transactions starting ${startMoment.format()}`);

    const [cards, xSiteId, Authorization] = await Promise.all([
      this.getCards(),
      this.getXSiteId(),
      this.getAuthorizationHeader(),
    ]);

    if (new Set(cards.map(card => card.last4Digits)).size !== cards.length) {
      throw new Error('CAL card suffixes are ambiguous');
    }

    const futureMonthsToScrape = this.options.futureMonthsToScrape ?? 1;

    // One big-numbers response covers every card on the bank account, so ask once per
    // distinct account rather than once per card. A failed account leaves only its own
    // cards' figures absent, because the request degrades to an absent body.
    const accountIds = [
      ...new Set(
        cards.map(card => bankAccountKey(card.bankAccountUniqueId)).filter((id): id is string => id !== undefined),
      ),
    ];
    const bigNumbersByAccount = new Map<string, unknown>();
    await Promise.all(
      accountIds.map(async accountId => {
        bigNumbersByAccount.set(
          accountId,
          await fetchOptionalCardDetail(
            BIG_NUMBERS_REQUEST_ENDPOINT,
            bigNumbersRequestBody(accountId),
            'a bank account',
            Authorization,
            xSiteId,
          ),
        );
      }),
    );

    const warnings: NonNullable<ScraperScrapingResult['warnings']> = [];
    const collected = await Promise.all(
      cards.map(async card => {
        const accountId = bankAccountKey(card.bankAccountUniqueId);
        try {
          const account = await this.fetchCardData(
            card,
            accountId === undefined ? undefined : bigNumbersByAccount.get(accountId),
            startMoment,
            startDate,
            futureMonthsToScrape,
            Authorization,
            xSiteId,
          );
          if (account.cardMetadataStatus === 'unavailable')
            warnings.push({ accountNumber: card.last4Digits, code: 'metadata-unavailable' });
          return account;
        } catch {
          // Empty failed accounts would incorrectly reconcile away transactions.
          warnings.push({ accountNumber: card.last4Digits, code: 'card-fetch-failed' });
          return undefined;
        }
      }),
    );
    const accounts = collected.filter((account): account is TransactionsAccount => account !== undefined);
    if (cards.length > 0 && accounts.length === 0)
      return { success: false, errorType: ScraperErrorTypes.General, warnings };

    debug('return the scraped accounts');

    debug(JSON.stringify(accounts, null, 2));
    return {
      success: true,
      accounts,
      warnings,
    };
  }
}

export default VisaCalScraper;
