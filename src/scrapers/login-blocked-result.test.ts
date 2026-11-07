// Exercise the real base login-result switch without a browser or credentials.
import { type Page } from 'puppeteer';
import { CompanyTypes } from '../definitions';
import { BaseScraperWithBrowser, LoginResults } from './base-scraper-with-browser';

class ResultFixture extends BaseScraperWithBrowser<{ username: string; password: string }> {
  constructor() {
    super({ companyId: CompanyTypes.leumi, startDate: new Date('2026-01-01') });
    this.page = { evaluate: () => Promise.resolve('about:blank') } as unknown as Page;
  }

  override getLoginOptions() {
    return {
      loginUrl: 'about:blank',
      fields: [],
      submitButtonSelector: () => Promise.resolve(),
      checkReadiness: () => Promise.resolve(),
      postAction: () => Promise.resolve(),
      possibleResults: { [LoginResults.AccountBlocked]: ['about:blank'] },
    };
  }

  override navigateTo() {
    return Promise.resolve();
  }
}

test('a blocked login returns ACCOUNT_BLOCKED instead of throwing an unexpected result', async () => {
  await expect(new ResultFixture().login({ username: 'fixture-only', password: 'fixture-only' })).resolves.toEqual({
    success: false,
    errorType: 'ACCOUNT_BLOCKED',
  });
});
