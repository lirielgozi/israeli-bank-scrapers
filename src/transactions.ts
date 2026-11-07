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
