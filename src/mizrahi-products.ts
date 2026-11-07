// Connection-scoped observations. Source product identity and checking binding
// have not been verified; array position is never a persistent product ID.
export interface MizrahiMortgage {
  source: 'mizrahi-mortgage-composition';
  accountBinding: null;
  bankAsOf: null;
  headerTotal: null;
  tracks: Array<{ name: string; balance: number; currency: 'ILS'; actualInterestRatePercent: number | null }>;
}
export interface MizrahiDeposits {
  source: 'mizrahi-deposit-cards';
  accountBinding: null;
  bankAsOf: null;
  total: null;
  totalLabel: string;
  records: Array<{
    accumulated: number;
    valuation: number;
    currency: 'ILS';
    interestRatePercent: number | null;
    firstDepositDate: string | null;
    maturityDate: string | null;
  }>;
}
export interface MizrahiProducts {
  scope: 'connection';
  mortgage: MizrahiMortgage | null;
  deposits: MizrahiDeposits | null;
}
