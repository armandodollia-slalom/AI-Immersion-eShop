import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { Browser, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { loadScenario, login } from './scenario';
import { WEBAPP_URL } from './ports';

// Scenario bug-5: the default data; alice (Pass123$) signs in, then /user/login is requested with various returnUrl values.
test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  loadScenario('bug-5');
});

async function signedInPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, 'alice');
  return page;
}

async function expectRedirect(browser: Browser, returnUrl: string | null, expectedLocation: string) {
  const page = await signedInPage(browser);
  const query = returnUrl === null ? '' : `?returnUrl=${encodeURIComponent(returnUrl)}`;
  const response = await test.step(`GET /user/login${query} without following redirects`, () =>
    page.context().request.get(`${WEBAPP_URL}/user/login${query}`, { maxRedirects: 0 }));
  await test.step('the response redirects to the expected local location', () => {
    expect(response.status()).toBe(302);
    const location = new URL(response.headers()['location'], WEBAPP_URL);
    expect(location.host).toBe(new URL(WEBAPP_URL).host);
    expect(location.href).toBe(`${WEBAPP_URL}${expectedLocation}`);
  });
  await page.context().close();
}

test.describe('BUG-5 login returnUrl', () => {
  test('TC-BUG-5-01 protocol-relative returnUrl //evil.example redirects to the home page', async ({ browser }) => {
    await expectRedirect(browser, '//evil.example', '/');
  });

  test('TC-BUG-5-02 returnUrl /\\evil.example redirects to the home page', async ({ browser }) => {
    await expectRedirect(browser, '/\\evil.example', '/');
  });

  test('TC-BUG-5-03 absolute returnUrl falls back to the home page', async ({ browser }) => {
    await expectRedirect(browser, 'https://evil.example/', '/');
  });

  test('TC-BUG-5-04 base-relative returnUrl item/7 is honoured', async ({ browser }) => {
    const page = await signedInPage(browser);
    await test.step('navigate to /user/login?returnUrl=item%2F7', () =>
      page.goto(`${WEBAPP_URL}/user/login?returnUrl=item%2F7`));
    await test.step('the browser ends at /item/7', async () => {
      await expect(page).toHaveURL(`${WEBAPP_URL}/item/7`);
    });
    await page.context().close();
  });

  test('TC-BUG-5-05 single-leading-slash returnUrl /item/7 is honoured', async ({ browser }) => {
    await expectRedirect(browser, '/item/7', '/item/7');
  });

  test('TC-BUG-5-06 no returnUrl redirects to the home page', async ({ browser }) => {
    await expectRedirect(browser, null, '/');
  });

  test('TC-BUG-5-07 auth-login spec passes with the test.fixme marker removed', async () => {
    test.setTimeout(600_000);
    const specPath = path.join(__dirname, 'auth-login.spec.ts');
    const title = 'a protocol-relative returnUrl on /user/login must not redirect off-site';
    await test.step('auth-login.spec.ts has no test.fixme on the protocol-relative test', () => {
      const source = fs.readFileSync(specPath, 'utf8');
      expect(source).toContain(`test('${title}'`);
      expect(source).not.toMatch(/test\.fixme/);
    });
    const run = await test.step('run auth-login.spec.ts on the scenarios project', () =>
      spawnSync(
        'npx',
        ['playwright', 'test', '-c', 'playwright.teststack.config.ts', '--project', 'scenarios', '--no-deps',
          '--reporter=json', '--retries=1', 'e2e/teststack/auth-login.spec.ts'],
        { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
          env: { ...process.env, E2E_KEEP_VIDEOS: '', PLAYWRIGHT_JSON_OUTPUT_NAME: '' } }));
    await test.step('the protocol-relative test ran and passed, every test passed, exit code 0', () => {
      expect(run.status, run.stdout.slice(-3000) + run.stderr).toBe(0);
      const report = JSON.parse(run.stdout);
      const tests: { title: string; status: string }[] = [];
      const walk = (suite: any) => {
        for (const spec of suite.specs ?? [])
          for (const t of spec.tests ?? []) tests.push({ title: spec.title, status: t.status });
        for (const child of suite.suites ?? []) walk(child);
      };
      report.suites.forEach(walk);
      const target = tests.filter(t => t.title === title);
      expect(target.map(t => t.status)).toEqual([expect.stringMatching(/^(expected|flaky)$/)]);
      expect(tests.filter(t => t.status !== 'expected' && t.status !== 'flaky')).toEqual([]);
      expect(report.stats.unexpected).toBe(0);
      expect(report.stats.skipped).toBe(0);
    });
  });
});
