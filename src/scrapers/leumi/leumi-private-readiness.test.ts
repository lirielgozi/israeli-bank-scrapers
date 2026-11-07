// Pure renderer fixtures: no browser, network or account data.
import { runInNewContext } from 'node:vm';
import { isPrivateAccountReady } from './leumi';

type Fixture = {
  protocol?: string;
  host?: string;
  path?: string;
  picker?: boolean;
  visible?: boolean;
  loginForm?: boolean;
  notice?: string;
};

function ready(fixture: Fixture = {}): boolean {
  const element = { getClientRects: () => (fixture.visible === false ? [] : [{}]) };
  const value: unknown = runInNewContext(`(${isPrivateAccountReady.toString()})()`, {
    window: {
      location: {
        protocol: fixture.protocol ?? 'https:',
        hostname: fixture.host ?? 'hb2.bankleumi.co.il',
        pathname: fixture.path ?? '/eBanking/SO/SPA.aspx',
      },
      getComputedStyle: () => ({ visibility: fixture.visible === false ? 'hidden' : 'visible' }),
    },
    document: {
      body: { innerText: fixture.notice ?? '' },
      querySelector: (selector: string) =>
        selector.startsWith('input') ? (fixture.loginForm ? element : null) : fixture.picker ? element : null,
    },
  });
  expect(typeof value).toBe('boolean');
  return value as boolean;
}

test('private account picker confirms readiness without the legacy main-content wrapper', () => {
  expect(ready({ picker: true })).toBe(true);
});

test.each<Fixture>([
  {},
  { picker: true, host: 'hb2.bankleumi.co.il.evil.example' },
  { picker: true, host: 'sa.bankleumi.co.il' },
  { picker: true, protocol: 'http:' },
  { picker: true, path: '/authenticate/logon' },
  { picker: true, path: '/staticcontent/digitalfront/he/' },
  { picker: true, visible: false },
  { picker: true, loginForm: true },
  { picker: true, notice: 'אחד או יותר מפרטי ההזדהות שהוקלדו שגויים' },
  { picker: true, notice: 'המנוי חסום' },
])('bare routes, hidden markers and rejection/login pages are not ready: %j', fixture => {
  expect(ready(fixture)).toBe(false);
});
