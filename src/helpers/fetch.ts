import { type Page } from 'puppeteer';

const JSON_CONTENT_TYPE = 'application/json';

function getJsonHeaders() {
  return {
    Accept: JSON_CONTENT_TYPE,
    'Content-Type': JSON_CONTENT_TYPE,
  };
}

/**
 * Returns the URL without its query string or fragment, so it is safe to put in an error or a log.
 * Query strings can carry identifiers and tokens.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/**
 * Returns a JSON parse error message without the fragment of the response text that V8 quotes in it,
 * since the response can hold account data.
 */
function describeParseError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/"[\s\S]*"(\.\.\.)?/, '"<redacted>"');
}

function assertAutomationNotBlocked(status: number, responseText: string | null, url: string) {
  if (status === 429 || (responseText && /block automation|bot detection/i.test(responseText))) {
    throw new Error(
      `Automation detected and blocked by server. Status: ${status}, URL: ${redactUrl(url)}. The site is actively blocking automated access. Consider: 1) Using showBrowser:true, 2) Adding longer delays, 3) Using residential proxies, 4) Running at different times of day`,
    );
  }
}

export async function fetchGet<TResult>(url: string, extraHeaders: Record<string, any>): Promise<TResult> {
  let headers = getJsonHeaders();
  if (extraHeaders) {
    headers = Object.assign(headers, extraHeaders);
  }
  const request = {
    method: 'GET',
    headers,
  };
  const fetchResult = await fetch(url, request);

  if (fetchResult.status !== 200) {
    throw new Error(`sending a request to the institute server returned with status code ${fetchResult.status}`);
  }

  return fetchResult.json();
}

export async function fetchPost<TResult = any>(
  url: string,
  data: Record<string, any>,
  extraHeaders: Record<string, any> = {},
): Promise<TResult> {
  const request = {
    method: 'POST',
    headers: { ...getJsonHeaders(), ...extraHeaders },
    body: JSON.stringify(data),
  };
  const result = await fetch(url, request);
  return result.json();
}

export async function fetchGraphql<TResult>(
  url: string,
  query: string,
  variables: Record<string, unknown> = {},
  extraHeaders: Record<string, any> = {},
): Promise<TResult> {
  const result = await fetchPost(url, { operationName: null, query, variables }, extraHeaders);
  if (result.errors?.length) {
    throw new Error(result.errors[0].message);
  }
  return result.data as Promise<TResult>;
}

export async function fetchGetWithinPage<TResult>(
  page: Page,
  url: string,
  ignoreErrors = false,
): Promise<TResult | null> {
  const [result, status] = await page.evaluate(
    async (innerUrl: string, innerSafeUrl: string) => {
      let response: Response | undefined;
      try {
        response = await fetch(innerUrl, { credentials: 'include' });
        if (response.status === 204) {
          return [null, response.status] as const;
        }
        return [await response.text(), response.status] as const;
      } catch (e) {
        throw new Error(
          `fetchGetWithinPage error: ${e instanceof Error ? e.message : String(e)}, url: ${innerSafeUrl}, status: ${response?.status}`,
        );
      }
    },
    url,
    redactUrl(url),
  );

  if (!ignoreErrors) {
    assertAutomationNotBlocked(status, result, url);
  }

  if (result !== null) {
    try {
      return JSON.parse(result);
    } catch (e) {
      if (!ignoreErrors) {
        throw new Error(
          `fetchGetWithinPage parse error: ${describeParseError(e)}, url: ${redactUrl(url)}, status: ${status}`,
        );
      }
    }
  }
  return null;
}

export async function fetchPostWithinPage<TResult>(
  page: Page,
  url: string,
  data: Record<string, any>,
  extraHeaders: Record<string, any> = {},
  ignoreErrors = false,
): Promise<TResult | null> {
  const [resultText, status] = await page.evaluate(
    async (innerUrl: string, innerData: Record<string, any>, innerExtraHeaders: Record<string, any>) => {
      const response = await fetch(innerUrl, {
        method: 'POST',
        body: JSON.stringify(innerData),
        credentials: 'include',

        headers: Object.assign(
          { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          innerExtraHeaders,
        ),
      });
      if (response.status === 204) {
        return [null, response.status] as const;
      }
      return [await response.text(), response.status] as const;
    },
    url,
    data,
    extraHeaders,
  );

  if (!ignoreErrors) {
    assertAutomationNotBlocked(status, resultText, url);
  }

  try {
    if (resultText !== null) {
      return JSON.parse(resultText);
    }
  } catch (e) {
    if (!ignoreErrors) {
      // Never include data, extraHeaders or resultText here: they can hold credentials, tokens and account data,
      // and this message reaches result.errorMessage.
      throw new Error(
        `fetchPostWithinPage parse error: ${describeParseError(e)}, url: ${redactUrl(url)}, status: ${status}`,
      );
    }
  }
  return null;
}
