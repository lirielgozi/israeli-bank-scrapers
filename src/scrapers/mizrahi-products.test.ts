import fixture from './fixtures/mizrahi-products';
import { parseMizrahiDeposits, parseMizrahiMortgage } from './mizrahi-products';

describe('Mizrahi verified source composition', () => {
  test('one mortgage parent preserves six tracks, repeated labels and unknown binding/date/total', () => {
    const m = parseMizrahiMortgage(fixture.mortgage.headers, fixture.mortgage.rows)!;
    expect(m.tracks).toHaveLength(6);
    expect(m.tracks.filter(t => t.name === 'מסלול בדיקה ג')).toHaveLength(4);
    expect(m.tracks[0]).toEqual({
      name: 'מסלול בדיקה א',
      balance: 20501.11,
      currency: 'ILS',
      actualInterestRatePercent: 3.125,
    });
    expect([m.accountBinding, m.bankAsOf, m.headerTotal]).toEqual([null, null, null]);
    expect(m.tracks.every(t => !('id' in t))).toBe(true);
  });
  test('ambiguous headers, empty rows and non-ILS amounts are unavailable', () => {
    expect(parseMizrahiMortgage([...fixture.mortgage.headers, 'יתרת המסלול'], fixture.mortgage.rows)).toBeNull();
    expect(parseMizrahiMortgage(fixture.mortgage.headers, [])).toBeNull();
    for (const amount of ['20,501.11 USD', '20,501.11', '20,50 ₪', '-50 ₪']) {
      expect(parseMizrahiMortgage(fixture.mortgage.headers, [['', 'מסלול', amount, '3%']])).toBeNull();
    }
  });
  test('deposit valuation retains decimals separately from rounded accumulation; unknown date is not collection date', () => {
    const d = parseMizrahiDeposits(
      fixture.deposits.activeFilter,
      fixture.deposits.records.map(r => r.fields),
    )!;
    expect(d.records).toHaveLength(2);
    expect(d.records[0]).toEqual({
      accumulated: 12345,
      valuation: 12356.78,
      currency: 'ILS',
      interestRatePercent: 2.13,
      firstDepositDate: '2028-04-03',
      maturityDate: '2029-04-03',
    });
    expect([d.total, d.bankAsOf, d.accountBinding]).toEqual([null, null, null]);
    expect(d.records.every(r => !('syntheticId' in r))).toBe(true);
  });
  test('filter completeness and verified currency required; unavailable optional dates/rates stay null', () => {
    const fields = fixture.deposits.records.map(r => ({ ...r.fields }));
    expect(parseMizrahiDeposits('הכל (3)', fields)).toBeNull();
    expect(parseMizrahiDeposits('הכל (0)', [])).toBeNull();
    fields[0]['מועד פירעון'] = '31/02/2029';
    fields[0]['שיעור ריבית'] = 'לא ידוע';
    const d = parseMizrahiDeposits('הכל (2)', fields)!;
    expect(d.records[0].maturityDate).toBeNull();
    expect(d.records[0].interestRatePercent).toBeNull();
    fields[0]['שיערוך ליום עסקים נוכחי'] = '$12356.78';
    expect(parseMizrahiDeposits('הכל (2)', fields)).toBeNull();
  });
});
