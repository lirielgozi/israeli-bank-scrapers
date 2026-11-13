import type { MizrahiProducts } from './mizrahi-products';

export type BankLoanDetails =
  | { status: 'unavailable'; source: 'leumi-loan-detail' }
  | {
      status: 'reported';
      source: 'leumi-loan-detail';
      detailSourceId: string;
      bankAsOf: string;
      principalBalance: number | null;
      remainingPayments: number | null;
      nextPaymentAmount: number | null;
      nextPaymentDate: string | null;
      interestRatePercent: number | null;
      interestRateText: string | null;
      indexation: string | null;
      bankStartDate: string | null;
      bankEndDate: string | null;
    };

export interface BankLoanSnapshot {
  status: 'reported' | 'unavailable';
  source: 'leumi-loan-summary';
  loans: Array<{
    sourceId: string;
    referenceLast4: string;
    originalAmount: number;
    revaluedBalance: number;
    bankAsOf: string;
    bankEndDate: string | null;
    sourceAccountRaw?: string;
    sourceAccountNumber?: string | null;
    details?: BankLoanDetails;
  }>;
}

export interface CalCardDetails {
  isDebit: boolean | null;
  billingDay: number | null;
  sharedFacility: {
    identity: string;
    issuerGroup: 'bankIssuedCards' | 'calIssuedCards';
    limit: number | null;
    available: number | null;
    nextPayment: number | null;
    nextPaymentDate: string | null;
    source: 'cal-frame-status';
  } | null;
  // Per-card figures CAL reports even when several cards share one credit frame,
  // which is the case where cardLevelFrames comes back empty. These are optional
  // and omitted when absent, unlike the members above, which carry null.
  frameUsage?: number;
  revolvingBalance?: number;
  cycleSpend?: number;
  fixedDebit?: number;
  // Rates exactly as CAL returns them, with no rounding or unit conversion.
  interest?: {
    nominal: number;
    effective: number;
    gapFromPrime: number;
    validDate?: string;
    kind: 'revolving';
  };
}
export interface BankCreditFacility {
  status: 'reported' | 'unavailable';
  limit: number | null;
  temporaryLimit: number | null;
  used: number | null;
  remainingCredit: number | null;
  asOf: string | null;
  source: 'mizrahi-credit-modal' | 'leumi-credit-table';
}

// MAX homepage metadata is scoped to this card, not a CAL shared facility.
export interface MaxCardPayment {
  scope: 'card';
  source: 'max-homepage';
  sourceAsOf: string;
  status: 'reported' | 'unavailable';
  currency: 'ILS';
  nextPayment: number | null;
  nextPaymentDate: string | null;
  isFinal: boolean | null;
  configuredMonthlyPayment: number | null;
}

export interface TransactionsAccount {
  // Carrier only: this payload is NOT bound to accountNumber.
  mizrahiProducts?: MizrahiProducts;
  bankLoans?: BankLoanSnapshot;
  maxCardPayment?: MaxCardPayment;
  calCard?: CalCardDetails;
  bankCreditFacility?: BankCreditFacility;
  accountNumber: string;
  balance?: number;
  balanceDate?: string;
  cardFrame?: number;
  cardMetadataStatus?: 'available' | 'unavailable';
  cardType?: CardType;
  currency?: string;
  savingsAccount?: boolean;
  txns: Transaction[];
}

export enum CardType {
  BankIssued = 'bankIssued',
  CompanyIssued = 'companyIssued',
}

export enum TransactionTypes {
  Normal = 'normal',
  Installments = 'installments',
}

export enum TransactionStatuses {
  Completed = 'completed',
  Pending = 'pending',
}

export interface TransactionInstallments {
  /**
   * the current installment number
   */
  number: number;

  /**
   * the total number of installments
   */
  total: number;
}

export interface Transaction {
  type: TransactionTypes;
  /**
   * sometimes called Asmachta
   */
  identifier?: string | number;
  /**
   * ISO date string
   */
  date: string;
  /**
   * ISO date string
   */
  processedDate: string;
  originalAmount: number;
  originalCurrency: string;
  chargedAmount: number;
  chargedCurrency?: string;
  description: string;
  memo?: string;
  status: TransactionStatuses;
  installments?: TransactionInstallments;
  category?: string;
  rawTransaction?: unknown;
}
