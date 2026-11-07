import { calCardDetails } from './visa-cal-metadata';
const card = (id: string, bank = 'synthetic-bank') => ({
  cardUniqueId: id,
  bankAccountUniqueId: bank,
  isDebitCard: false,
  currentDebitDay: 10,
});
const response = (id: string) => ({
  statusCode: 1,
  result: {
    bankIssuedCards: null,
    calIssuedCards: {
      frameLimitForCardAmount: 5000,
      fictiveMaxAccAmt: 750.25,
      nextTotalDebitForAccount: 200,
      nextTotalDebitDateForAccount: '2026-11-10T00:00:00',
      cardLevelFrames: [],
      accountLevelFrames: [{ cardUniqueId: id, nextTotalDebit: 200, nextDebitDate: '2026-11-10T00:00:00' }],
      accountExceptionalCards: [],
    },
  },
});
test('observed account-level membership uses issuer and bank identity, never coincident amounts', () => {
  const a = calCardDetails(card('a'), response('a'));
  const b = calCardDetails(card('b'), response('b'));
  expect(a.sharedFacility).toEqual(b.sharedFacility);
  expect(a.sharedFacility?.identity).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(a)).not.toContain('synthetic-bank');
  expect(calCardDetails(card('c', 'another-bank'), response('c')).sharedFacility?.identity).not.toEqual(
    a.sharedFacility?.identity,
  );
  expect(calCardDetails(card('a'), response('other')).sharedFacility).toBeNull();
  expect(a.sharedFacility?.available).toBe(750.25);
});
test('explicit debit is independent of missing frame and its nominal day is retained', () => {
  expect(
    calCardDetails({ ...card('a'), isDebitCard: true, currentDebitDay: 15 }, { statusCode: 87, result: null }),
  ).toEqual({ isDebit: true, billingDay: 15, sharedFacility: null });
  expect(calCardDetails({ cardUniqueId: 'a' }, { statusCode: 87, result: null }).isDebit).toBeNull();
});
test('unknown values stay null and real zero survives', () => {
  const r = response('a');
  const group = r.result.calIssuedCards;
  Object.assign(group, {
    frameLimitForCardAmount: undefined,
    fictiveMaxAccAmt: 0,
    nextTotalDebitForAccount: undefined,
  });
  const f = calCardDetails(card('a'), r).sharedFacility!;
  expect(f.limit).toBeNull();
  expect(f.available).toBe(0);
  expect(f.nextPayment).toBeNull();
});
