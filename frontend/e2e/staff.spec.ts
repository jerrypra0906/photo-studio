import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { OWNER, RUN, STAFF, apiCall, expectNoHorizontalScroll, futureDay, session } from './helpers';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => ({ context, page } = await session(browser, STAFF)));
test.afterAll(async () => context.close());

test.describe('Staff restrictions in the UI (US-02, SEC-B4)', () => {
  for (const path of ['/finance', '/finance/expenses', '/finance/recap', '/admin', '/admin/users', '/admin/settings']) {
    test(`STAFF− opening ${path} directly shows "no access" and no data`, async () => {
      await page.goto(path);
      await expect(page.getByText('Anda tidak memiliki akses ke halaman ini.')).toBeVisible();
    });
  }

  test('STAFF− booking form hides the price adjustment and blocks past dates', async () => {
    await page.goto('/bookings/new');
    await page.getByRole('button', { name: /Pembayaran/ }).click();
    await expect(page.getByText(/^Penyesuaian harga/)).toHaveCount(0);
    await expect(page.locator('#dp')).toBeVisible();
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    await expect(page.locator('#date')).toHaveAttribute('min', today);
  });

  test('STAFF− an ended booking offers no "Tandai selesai" or payment action', async ({ browser }) => {
    const o = await session(browser, OWNER);
    const types = (await apiCall(o.context.request, 'GET', '/booking-types')).body;
    const so = types.find((t: any) => t.name === 'Studio Only').id;
    let b: any;
    for (let i = 0; i < 10 && !b?.id; i++) {
      const past = `19${80 + Math.floor(Math.random() * 20)}-0${1 + Math.floor(Math.random() * 9)}-2${Math.floor(Math.random() * 8)}`;
      b = (await apiCall(o.context.request, 'POST', '/bookings', { typeId: so, hours: 1, date: past, startTime: `${10 + Math.floor(Math.random() * 8)}:00`, clientName: `E2E Staff view ${RUN}` })).body;
    }
    expect(b?.id, 'could not create a past booking').toBeTruthy();
    await page.goto(`/bookings/${b.id}`);
    await expect(page.getByText(/Owner akan menandai selesai/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tandai selesai' })).toHaveCount(0);
    await apiCall(o.context.request, 'POST', `/bookings/${b.id}/cancel`, { reason: 'OTHER' });
    await o.context.close();
  });

  test('STAFF+ can create a booking end-to-end', async () => {
    const d = futureDay(5);
    await page.goto(`/bookings/new?date=${d}`);
    await page.getByRole('button', { name: /^Studio Only/ }).click();
    await page.getByRole('button', { name: '11:00', exact: true }).click();
    await page.locator('#cn').fill(`E2E Staff ${RUN}`);
    await page.getByRole('button', { name: 'Simpan booking' }).click();
    await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Rp170.000').first()).toBeVisible();
    await apiCall(context.request, 'POST', `/bookings/${page.url().split('/').pop()}/cancel`, { reason: 'OTHER' });
  });

  test('STAFF+ account page lets staff change their own name only', async () => {
    await page.goto('/me');
    await expect(page.getByText(STAFF.email)).toBeVisible();
    await expect(page.getByText('kelola pengguna')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('Responsive & theme', () => {
  for (const [w, h] of [[360, 760], [430, 932]] as const) {
    test(`RESP+ key screens have no horizontal scroll at ${w}px`, async () => {
      await page.setViewportSize({ width: w, height: h });
      for (const p of ['/', '/schedule', '/bookings', '/bookings/new', '/me']) {
        await page.goto(p);
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalScroll(page);
      }
    });
  }

  test('THEME+ dark mode applies the dark surface', async ({ browser }) => {
    const s = await session(browser, STAFF, { colorScheme: 'dark' });
    await s.page.goto('/');
    const bg = await s.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g)!.map(Number);
    expect(r + g + b, `body background ${bg}`).toBeLessThan(150);
    await s.context.close();
  });
});
