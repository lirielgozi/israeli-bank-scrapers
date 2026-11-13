import { createHash } from 'node:crypto';
import type { CalCardDetails } from '../transactions';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Figures are read only from a body that reports success outright. An absent
// statusCode is not success, matching the shared-facility gating below.
function reportsFailure(body: Record<string, unknown> | undefined): boolean {
  return body?.statusCode !== 1;
}

function framesFor(result: Record<string, unknown>, kind: string): unknown[] | undefined {
  const frames = record(result[kind])?.accountLevelFrames;
  return Array.isArray(frames) ? frames : undefined;
}

// On an account whose cards share one credit frame, cardLevelFrames is empty and
// each card's own share of the frame usage is reported in accountLevelFrames. A card
// listed in more than one issuer group has no unambiguous share, so it gets none,
// the same refusal the shared-facility gating below makes.
function accountFrameUsage(result: Record<string, unknown>, cardUniqueId: unknown): number | null {
  if (typeof cardUniqueId !== 'string' || cardUniqueId.length === 0) return null;
  const groups = (['bankIssuedCards', 'calIssuedCards'] as const).filter(kind =>
    framesFor(result, kind)?.some(member => record(member)?.cardUniqueId === cardUniqueId),
  );
  if (groups.length !== 1) return null;
  for (const member of framesFor(result, groups[0]) ?? []) {
    const entry = record(member);
    if (entry?.cardUniqueId !== cardUniqueId) continue;
    const usage = amount(entry.frameTotalOblForCardAmount);
    if (usage !== null) return usage;
  }
  return null;
}

// Observed CAL shape: accountLevelFrames contains the requested card, whereas
// the limit/available/next-payment fields belong to its issuer/account group.
export function calCardDetails(card: Record<string, unknown>, response: unknown): CalCardDetails {
  const debit = card.isDebitCard;
  const day = card.currentDebitDay;
  const details: CalCardDetails = {
    isDebit: debit === true || debit === 1 ? true : debit === false || debit === 0 ? false : null,
    billingDay: typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 31 ? day : null,
    sharedFacility: null,
  };
  const body = record(response),
    result = record(body?.result);
  // Independent of the shared-facility gating below, which skips a debit card and
  // a card that appears in more than one issuer group.
  const frameUsage = result && !reportsFailure(body) ? accountFrameUsage(result, card.cardUniqueId) : null;
  if (frameUsage !== null) details.frameUsage = frameUsage;
  const bankId = card.bankAccountUniqueId;
  if (
    body?.statusCode !== 1 ||
    !result ||
    !((typeof bankId === 'string' && bankId.length > 0) || (typeof bankId === 'number' && Number.isFinite(bankId)))
  )
    return details;
  const matches = (['bankIssuedCards', 'calIssuedCards'] as const).filter(kind => {
    const group = record(result[kind]);
    return (
      group !== undefined &&
      Array.isArray(group.accountLevelFrames) &&
      group.accountLevelFrames.some(member => record(member)?.cardUniqueId === card.cardUniqueId)
    );
  });
  if (matches.length !== 1 || details.isDebit === true) return details;
  const issuerGroup = matches[0];
  const group = record(result[issuerGroup])!;
  const date = group.nextTotalDebitDateForAccount;
  details.sharedFacility = {
    identity: createHash('sha256')
      .update(JSON.stringify([issuerGroup, bankId]))
      .digest('hex'),
    issuerGroup,
    limit: amount(group.frameLimitForCardAmount),
    available: amount(group.fictiveMaxAccAmt),
    nextPayment: amount(group.nextTotalDebitForAccount),
    nextPaymentDate:
      typeof date === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(date) && Number.isFinite(Date.parse(date))
        ? date
        : null,
    source: 'cal-frame-status',
  };
  return details;
}
