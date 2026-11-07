// Synthetic values only; syntheticId is never a source product identity.
export default {
  synthetic: true,
  mortgage: {
    headerSelector: '.sky-mash-header',
    componentSelector: '.sky-maslolim',
    accountBinding: null,
    bankAsOf: null,
    headerTotal: null,
    headers: ['', 'שם המסלול', 'יתרת המסלול', 'ריבית בפועל'],
    rows: [
      ['', 'מסלול בדיקה א', '20,501.11 ₪', '3.125%'],
      ['', 'מסלול בדיקה ב', '31,602.22 ₪', '4.375%'],
      ['', 'מסלול בדיקה ג', '42,703.33 ₪', '2.875%'],
      ['', 'מסלול בדיקה ג', '53,804.44 ₪', '3.625%'],
      ['', 'מסלול בדיקה ג', '64,905.55 ₪', '4.125%'],
      ['', 'מסלול בדיקה ג', '75,106.66 ₪', '2.625%'],
    ],
    trackIdentity: 'unverified-do-not-use-row-position',
  },
  deposits: {
    selector: '.sky-my-deposits li.deposit-cube',
    fieldSelector: '.sky-deposit-details',
    accountBinding: null,
    activeFilter: 'הכל (2)',
    totalLabel: 'סה"כ פיקדונות כולל רווחים (ללא ניכוי מס)',
    records: [
      {
        syntheticId: 'test-deposit-a',
        fields: {
          'צברת עד כה': '‪₪12,345',
          'שיעור ריבית': '‪2.13%',
          'מועד הפקדה ראשונה': '03/04/2028',
          'מועד פירעון': '03/04/2029',
          'שיערוך ליום עסקים נוכחי': '‪₪12,356.78',
        },
      },
      {
        syntheticId: 'test-deposit-b',
        fields: {
          'צברת עד כה': '‪₪23,456',
          'שיעור ריבית': '‪3.88%',
          'מועד הפקדה ראשונה': '05/06/2028',
          'מועד פירעון': '05/06/2029',
          'שיערוך ליום עסקים נוכחי': '‪₪23,489.12',
        },
      },
    ],
    recordIdentity: 'synthetic-only-real-source-identity-not-yet-verified',
  },
};
