// Offline only: no browser launch, configuration file, bank request or secrets.
import { runInNewContext } from 'node:vm';
import { type Page } from 'puppeteer';
import { CompanyTypes } from '../../definitions';
import { LoginResults } from '../base-scraper-with-browser';
import LeumiScraper from './leumi';

function renderer<T, A>(fn: (prefix: A) => T, prefix: A, bodyText?: string): T {
  // A detached renderer context ensures the callback is self-contained and
  // only returns a boolean, not a reference to the page's text or Node state.
  return runInNewContext(`(${fn.toString()})(prefix)`, {
    document: { body: bodyText === undefined ? null : { innerText: bodyText } },
    prefix,
  }) as T;
}

class FixtureScraper extends LeumiScraper {
  setPage(page: Page) {
    this.page = page;
  }
}

function fixture(bodyText?: string) {
  const evaluate = jest.fn((fn: (prefix: string) => boolean, prefix: string) =>
    Promise.resolve(renderer(fn, prefix, bodyText)),
  );
  const waitForFunction = jest.fn(
    (fn: (prefix: string[]) => boolean, options: { timeout: number }, prefix: string[]) => {
      expect(options.timeout).toBe(60000);
      if (prefix === undefined) return new Promise<boolean>(() => {});
      if (!renderer(fn, prefix, bodyText)) return Promise.reject(new Error('fixture: no known login state'));
      return Promise.resolve(true);
    },
  );
  // Other post-login branches remain pending. No icon, XPath, form input or
  // page text is ever returned by this mocked Puppeteer surface.
  const waitForSelector = jest.fn<Promise<unknown>, [string, unknown?]>(() => new Promise(() => {}));
  const scraper = new FixtureScraper({ companyId: CompanyTypes.leumi, startDate: new Date('2026-01-01') });
  scraper.setPage({ evaluate, waitForFunction, waitForSelector } as unknown as Page);
  const login = scraper.getLoginOptions({ username: 'fixture-only', password: 'fixture-only' });
  const invalid = login.possibleResults[LoginResults.InvalidPassword]?.[0];
  if (typeof invalid !== 'function') throw new Error('missing invalid-password predicate');
  const classify = () => invalid({ page: { evaluate } as unknown as Page });
  const blocked = login.possibleResults[LoginResults.AccountBlocked]?.[0];
  if (typeof blocked !== 'function') throw new Error('missing blocked predicate');
  const classifyBlocked = () => blocked({ page: { evaluate } as unknown as Page });
  return { login, classify, classifyBlocked, evaluate, waitForFunction, waitForSelector };
}

describe('Leumi invalid-password result (offline)', () => {
  test.each([
    'אחד או יותר מפרטי ההזדהות שמסרת שגויים. ניתן לנסות שוב',
    'אחד או יותר מפרטי ההזדהות שהוקלדו שגויים. ניתן לנסות שוב',
  ])('recognizes the notice without the removed SVG: %s', async message => {
    const f = fixture(`Login heading\n${message}\nfixture private data`);
    await expect(f.login.postAction()).resolves.toBeUndefined();
    await expect(f.classify()).resolves.toBe(true);
    expect(f.waitForFunction).toHaveBeenCalledTimes(2);
    expect(f.waitForSelector.mock.calls.every(call => !String(call[0]).includes('xpath'))).toBe(true);
    expect(await f.evaluate.mock.results[0].value).toBe(true);
  });

  test.each(['', 'שם משתמש סיסמה', 'A different login failure', undefined])(
    'does not label absent or unrelated content as wrong credentials: %s',
    async message => {
      const f = fixture(message);
      await expect(f.classify()).resolves.toBe(false);
      await expect(f.login.postAction()).rejects.toThrow('fixture: no known login state');
    },
  );
});

test('blocked notice resolves the wait without .errHeader and is distinct from invalid credentials', async () => {
  const f = fixture('המנוי חסום. פנה לבנק.');
  await expect(f.login.postAction()).resolves.toBeUndefined();
  await expect(f.classifyBlocked()).resolves.toBe(true);
  await expect(f.classify()).resolves.toBe(false);
  expect(Object.keys(f.login.possibleResults).indexOf(LoginResults.AccountBlocked)).toBeLessThan(
    Object.keys(f.login.possibleResults).indexOf(LoginResults.InvalidPassword),
  );
});
