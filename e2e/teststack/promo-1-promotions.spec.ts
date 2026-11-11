import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createSign } from 'crypto';
import { execFileSync } from 'child_process';
import { test, expect } from '../fixtures';
import { DOCKER, loadScenario, login } from './scenario';
import { IdentityClient, IDENTITY_URL, getTokens } from './auth-basket-helpers';
import { SLOT, port } from './ports';

// PROMO-1: the cases of tests/plans/PROMO-1-promotions-service-scaffold that need a token issued by the real
// Identity.API (the in-process cases are in tests/Promotions.FunctionalTests). Scenario: testing/scenarios/promo-1
// (promotions 1-4 are the seeded ones, 5 Draft, 6 ended yesterday, 7 starts tomorrow).
const PROMOTIONS_URL = `http://localhost:${port('promotions')}`;
const WEBHOOKS_CLIENT_URL = `http://localhost:${port('webhooksclient')}`;
const ACTIVE = `${PROMOTIONS_URL}/api/promotions/active?api-version=1.0`;
const LIST = `${PROMOTIONS_URL}/api/promotions?api-version=1.0`;
const ALICE_ID = 'a11ce000-0000-4000-8000-000000000001';
// PROMO-2: /active leaves out the coupon-only promotion (4) and the list endpoint is paged (PaginatedItems).
const ACTIVE_NAMES = ['Fall Hiking Sale', '$10 off orders over $150', 'Buy 2 Get 1 Free'];
const ALL_NAMES = [...ACTIVE_NAMES, 'Coupon only: 10% off', 'Draft 5% off', 'Ended yesterday', 'Starts tomorrow'];

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  loadScenario('promo-1');
});

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Compose project of the stack slot the specs run against (container names are <project>-<service>-1). */
const stackProject = () => (SLOT === 0 ? 'eshop-teststack' : `eshop-teststack-${SLOT}`);

/** Sign a token with the key of the running Identity.API container (its developer signing credential). */
function signWithIdentityKey(payload: Record<string, unknown>): string {
  const raw = execFileSync(DOCKER, ['exec', `${stackProject()}-identity-api-1`, 'cat', '/app/tempkey.jwk'], { encoding: 'utf8' });
  const k = JSON.parse(raw);
  const key = createPrivateKey({
    format: 'jwk',
    key: { kty: 'RSA', n: k.N, e: k.E, d: k.D, p: k.P, q: k.Q, dp: k.DP, dq: k.DQ, qi: k.QI },
  });
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${part({ alg: 'RS256', typ: 'at+jwt', kid: k.Kid })}.${part(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key).toString('base64url');
  return `${signingInput}.${signature}`;
}

const tokenClaims = (exp: number) => ({
  iss: IDENTITY_URL,
  nbf: exp - 7200,
  iat: exp - 7200,
  exp,
  client_id: 'webapp',
  sub: ALICE_ID,
  scope: ['promotions'],
  // PROMO-2: the list endpoint requires the admin policy (scope promotions and role admin).
  role: 'admin',
});

test('TC-PROMO-1-19 GET /active returns the same result with a valid token', async ({ request }) => {
  let token = '';
  await test.step('Get an access token for alice (client webapp, scope promotions)', async () => {
    token = (await getTokens('alice', 'Pass123$', 'openid profile promotions')).access_token;
  });

  let withToken, anonymous;
  await test.step('GET /api/promotions/active with the token, then anonymously', async () => {
    withToken = await request.get(ACTIVE, { headers: bearer(token) });
    anonymous = await request.get(ACTIVE);
  });

  await test.step('Both return 200 with identical bodies', async () => {
    expect(withToken.status()).toBe(200);
    expect(anonymous.status()).toBe(200);
    const body = await withToken.json();
    expect(body.map((p: { name: string }) => p.name)).toEqual(ACTIVE_NAMES);
    expect(body).toEqual(await anonymous.json());
  });
});

test('TC-PROMO-1-20 GET /api/promotions with a promotions-scope token returns every promotion', async ({ request }) => {
  let token = '';
  await test.step('Get an access token for alice (client webapp, scope promotions)', async () => {
    token = (await getTokens('alice', 'Pass123$', 'openid profile promotions')).access_token;
  });

  const response = await test.step('GET /api/promotions with the token', () => request.get(LIST, { headers: bearer(token) }));

  await test.step('200 with all 7 promotions, active or not', async () => {
    expect(response.status()).toBe(200);
    const body = (await response.json()).data;
    expect(body).toHaveLength(7);
    expect(body.map((p: { name: string }) => p.name).sort()).toEqual([...ALL_NAMES].sort());
    expect(body.map((p: { status: string }) => p.status).sort()).toEqual(['Draft', 'Published', 'Published', 'Published', 'Published', 'Published', 'Published']);
  });
});

test('TC-PROMO-1-21 signing in to the WebApp yields a token with the promotions scope that is accepted', async ({ page }) => {
  await test.step('Open the WebApp and sign in as alice through the Identity login page', async () => {
    await login(page, 'alice');
    await page.goto('/');
    await expect(page.getByLabel('Sign in')).toHaveCount(0);
    await expect(page.locator('.user-menu-name')).toHaveText(/alice/i);
  });

  let token = '';
  await test.step('Read the access token the WebApp holds for the session', async () => {
    token = await webAppAccessToken(await page.context().cookies());
  });

  await test.step('Decode the token and read its scope claim', async () => {
    const access = claims(token);
    expect(access.client_id).toBe('webapp');
    expect(access.sub).toBe(ALICE_ID);
    expect(access.scope).toContain('promotions');
  });

  await test.step('GET /api/promotions with that token', async () => {
    const response = await page.request.get(LIST, { headers: bearer(token) });
    expect(response.status()).toBe(200);
    const body = (await response.json()).data;
    expect(body).toHaveLength(7);
    expect(body.map((p: { name: string }) => p.name).sort()).toEqual([...ALL_NAMES].sort());
  });
});

/**
 * The access token the WebApp keeps (SaveTokens) in its encrypted auth cookie. The WebApp runs ASP.NET Core Data
 * Protection with a key ring in its container (AES_256_CBC + HMACSHA256), so the cookie is decrypted here the way the
 * framework does it: key from the container's key file, SP800-108 CTR HMACSHA512 subkeys, purposes
 * [content root, CookieAuthenticationMiddleware, "Cookies", "v2"].
 */
async function webAppAccessToken(cookies: { name: string; value: string }[]): Promise<string> {
  const chunks = cookies.filter((c) => /^\.AspNetCore\.Cookies(C\d+)?$/.test(c.name));
  const head = chunks.find((c) => c.name === '.AspNetCore.Cookies');
  const count = Number(/^chunks-(\d+)$/.exec(head?.value ?? '')?.[1] ?? 0);
  const value = count
    ? Array.from({ length: count }, (_, i) => chunks.find((c) => c.name === `.AspNetCore.CookiesC${i + 1}`)?.value ?? '').join('')
    : (head?.value ?? '');
  expect(value, 'the WebApp auth cookie').not.toBe('');
  const payload = Buffer.from(value, 'base64url');

  const keyId = Buffer.from(payload.subarray(4, 20));
  const guid = [keyId.subarray(0, 4).reverse(), keyId.subarray(4, 6).reverse(), keyId.subarray(6, 8).reverse(), keyId.subarray(8, 10), keyId.subarray(10, 16)]
    .map((b) => Buffer.from(b).toString('hex')).join('-');
  const xml = execFileSync(DOCKER, ['exec', `${stackProject()}-webapp-1`, 'cat', `/home/app/.aspnet/DataProtection-Keys/key-${guid}.xml`], { encoding: 'utf8' });
  const master = Buffer.from(/<masterKey[\s\S]*?<value>([^<]+)<\/value>/.exec(xml)![1], 'base64');

  const be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const kdf = (kdk: Buffer, label: Buffer, context: Buffer, length: number) => {
    let out = Buffer.alloc(0);
    for (let i = 1; out.length < length; i++) {
      out = Buffer.concat([out, createHmac('sha512', kdk).update(Buffer.concat([be(i), label, Buffer.from([0]), context, be(length * 8)])).digest()]);
    }
    return out.subarray(0, length);
  };
  const empty = Buffer.alloc(0);
  const zero = kdf(empty, empty, empty, 64);
  const zc = createCipheriv('aes-256-cbc', zero.subarray(0, 32), Buffer.alloc(16));
  const contextHeader = Buffer.concat([Buffer.from([0, 0]), be(32), be(16), be(32), be(32),
    Buffer.concat([zc.update(empty), zc.final()]), createHmac('sha256', zero.subarray(32)).update(empty).digest()]);
  const str = (s: string) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length]), b]); };

  const iv = payload.subarray(36, 52);
  const cipher = payload.subarray(52, payload.length - 32);
  const mac = payload.subarray(payload.length - 32);
  for (const root of ['/app/', '/app']) {
    const purposes = [root, 'Microsoft.AspNetCore.Authentication.Cookies.CookieAuthenticationMiddleware', 'Cookies', 'v2'];
    const aad = Buffer.concat([payload.subarray(0, 20), be(purposes.length), ...purposes.map(str)]);
    const keys = kdf(master, aad, Buffer.concat([contextHeader, payload.subarray(20, 36)]), 64);
    if (!createHmac('sha256', keys.subarray(32)).update(Buffer.concat([iv, cipher])).digest().equals(mac)) continue;
    const d = createDecipheriv('aes-256-cbc', keys.subarray(0, 32), iv);
    const ticket = Buffer.concat([d.update(cipher), d.final()]).toString('latin1');
    const access = (ticket.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) ?? []).find((jwt) => claims(jwt).scope !== undefined);
    expect(access, 'an access token in the WebApp auth ticket').toBeDefined();
    return access!;
  }
  throw new Error('Could not decrypt the WebApp auth cookie with its data-protection key');
}

test('TC-PROMO-1-24 GET /api/promotions with an expired token returns 401', async ({ request }) => {
  const now = Math.floor(Date.now() / 1000);
  let expired = '';

  await test.step('Sign a token for alice with scope promotions that expired 1 hour ago', async () => {
    expired = signWithIdentityKey(tokenClaims(now - 3600));
  });

  await test.step('Control: the same token with a future exp is accepted, so only the expiry can be at fault', async () => {
    const valid = await request.get(LIST, { headers: bearer(signWithIdentityKey(tokenClaims(now + 3600))) });
    expect(valid.status()).toBe(200);
  });

  const response = await test.step('GET /api/promotions with the expired token', () => request.get(LIST, { headers: bearer(expired) }));

  await test.step('401 and no promotion data', async () => {
    expect(response.status()).toBe(401);
    const body = await response.text();
    for (const name of ALL_NAMES) expect(body).not.toContain(name);
  });
});

test('TC-PROMO-1-25 Identity discovery document lists the promotions scope', async () => {
  const response = await test.step('GET /.well-known/openid-configuration anonymously', () =>
    new IdentityClient().get(`${IDENTITY_URL}/.well-known/openid-configuration`));

  await test.step('200 and scopes_supported contains promotions', async () => {
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).scopes_supported).toContain('promotions');
  });
});

test('TC-PROMO-1-26 Other clients cannot request the promotions scope', async () => {
  const query = new URLSearchParams({
    client_id: 'webhooksclient',
    response_type: 'code',
    redirect_uri: `${WEBHOOKS_CLIENT_URL}/signin-oidc`,
    scope: 'openid promotions',
    state: 's',
    nonce: 'n',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  });

  const client = new IdentityClient();
  const response = await test.step('GET /connect/authorize as webhooksclient with scope "openid promotions"', () =>
    client.get(`${IDENTITY_URL}/connect/authorize?${query}`));

  await test.step('The request is rejected with invalid_scope and no login page is offered', async () => {
    // Identity sends the browser to its error page (the redirect URI is not used for this error).
    const location = response.headers.location ?? '';
    expect(response.status).toBe(302);
    expect(location).toMatch(/\/home\/error\?errorId=/);
    expect(location).not.toMatch(/\/Account\/Login/i);
    expect(location).not.toContain('code=');
    const errorPage = await client.get(new URL(location, IDENTITY_URL).toString());
    expect(errorPage.status).toBe(200);
    expect(errorPage.body).toContain('invalid_scope');
    expect(errorPage.body).not.toContain('name="Username"');
  });
});
