import { type Page, expect, test } from '@playwright/test';
import { OWNER, STAFF, expectNoHorizontalScroll } from './helpers';

test.describe.configure({ mode: 'serial' });

/** Clicks "Masuk"; if the per-IP login limit answers "coba lagi dalam N detik", waits N seconds and submits again. */
async function submitLogin(page: Page) {
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Masuk' }).click();
    const limited = page.getByText(/coba lagi dalam (\d+) detik/);
    const outcome = await Promise.race([
      limited.waitFor({ timeout: 4000 }).then(() => 'limited', () => 'ok'),
      page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 4000 }).then(() => 'ok', () => 'ok'),
    ]);
    if (outcome !== 'limited') return;
    const secs = Number((await limited.textContent())?.match(/(\d+) detik/)?.[1] ?? 10);
    await page.waitForTimeout((secs + 1) * 1000);
  }
}

test.describe('Login & session (US-01, US-02)', () => {
  test('AUTH+ login page renders the logo and fits a 360px phone without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/login');
    await expect(page.getByAltText('JES Space Studio')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Masuk' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('AUTH− wrong password shows a generic error and stays on login', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Kata sandi').fill('definitely-wrong-1');
    await submitLogin(page);
    await expect(page.getByText('Email atau kata sandi salah')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('AUTH− empty form cannot be submitted (required fields)', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Masuk' }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.getByLabel('Email').evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  });

  test('AUTH− a protected page redirects an anonymous visitor to login', async ({ page }) => {
    await page.goto('/finance');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('AUTH+ owner signs in, stays signed in after reload, and signs out', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Kata sandi').fill(OWNER.password);
    await submitLogin(page);
    await expect(page.getByRole('heading', { name: /^Halo,/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Halo,/ })).toBeVisible();
    await page.goto('/me');
    await page.getByRole('button', { name: 'Keluar' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('AUTH+ show/hide password toggle reveals the typed text', async ({ page }) => {
    await page.goto('/login');
    const pw = page.getByLabel('Kata sandi');
    await pw.fill('abc123');
    await expect(pw).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Tampilkan' }).click();
    await expect(pw).toHaveAttribute('type', 'text');
  });

  test('AUTH+ staff signs in and sees the staff navigation only', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(STAFF.email);
    await page.getByLabel('Kata sandi').fill(STAFF.password);
    await submitLogin(page);
    const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
    await expect(nav.getByRole('link', { name: 'Booking' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Keuangan' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  });
});
