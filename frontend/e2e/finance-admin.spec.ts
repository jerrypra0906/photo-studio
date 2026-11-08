import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { OWNER, RUN, apiCall, expectNoHorizontalScroll, session } from './helpers';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => ({ context, page } = await session(browser, OWNER)));
test.afterAll(async () => context.close());

const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

test.describe('Keuangan › Ringkasan (FR-23, FR-28)', () => {
  const last = () => { const d = new Date(Date.now() + 7 * 3600e3); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

  test('DASH+ one month answers the four questions: result, comparison, best package, biggest expense', async () => {
    await page.goto(`/finance?month=${last()}`);
    await expect(page.getByText(/^Laba bersih · /)).toBeVisible();
    for (const h of ['Dibanding bulan lain', 'Paket terbaik', 'Pengeluaran terbesar']) await expect(page.getByRole('heading', { name: h })).toBeVisible();
    await expect(page.getByText('Peringkat', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('DASH+ no figure is repeated across tabs: Pengeluaran shows no revenue or profit', async () => {
    await page.getByRole('link', { name: 'Pengeluaran', exact: true }).click();
    await expect(page.getByText('Total pengeluaran')).toBeVisible();
    await expect(page.getByText(/^Laba bersih/)).toHaveCount(0);
    await expect(page.getByText('Pendapatan', { exact: true })).toHaveCount(0);
  });

  test('DASH+ the selected month carries across Ringkasan, Pengeluaran and Laporan', async () => {
    const m = last();
    await expect(page).toHaveURL(new RegExp(`/finance/expenses\\?month=${m}`));
    await page.getByRole('link', { name: 'Laporan', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/finance/recap\\?month=${m}`));
    await expect(page.getByRole('heading', { name: /^Laporan laba rugi · / })).toBeVisible();
    await page.getByRole('link', { name: 'Ringkasan', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/finance\\?month=${m}`));
  });

  test('DASH+ tapping a month in the comparison chart switches the whole page to that month', async () => {
    const col = page.getByRole('button', { name: /: lihat detail$/ }).first();
    await col.scrollIntoViewIfNeeded();
    await col.click();
    await expect(page).not.toHaveURL(new RegExp(`month=${last()}$`));
    await expect(page.getByRole('status').filter({ hasText: 'Pendapatan' })).toBeVisible();
  });

  test('DASH+ tapping the biggest expense opens Pengeluaran filtered to that category', async () => {
    await page.goto(`/finance?month=${last()}`);
    const top = page.getByRole('heading', { name: 'Pengeluaran terbesar' }).locator('xpath=ancestor::div[contains(@class,"space-y-3")][1]').getByRole('link').first();
    await top.scrollIntoViewIfNeeded();
    await top.click();
    await expect(page).toHaveURL(/\/finance\/expenses\?month=\d{4}-\d{2}&categoryId=/);
    await expect(page.getByRole('button', { name: 'Semua', exact: true })).toHaveAttribute('aria-pressed', 'false');
  });

  test('DASH− an empty month says so instead of showing broken charts', async () => {
    await page.goto('/finance?month=1971-01');
    await expect(page.getByText('Belum ada transaksi di Januari 1971.')).toBeVisible();
  });
});

test.describe('Expenses & recap (US-22, US-26, US-27)', () => {
  test('EXP− amount 0 keeps Save disabled; − a future date shows an error', async () => {
    await page.goto('/finance/expenses/new');
    await page.getByRole('button', { name: 'Lainnya', exact: true }).click();
    await page.locator('#amt').fill('0');
    await expect(page.getByText('Masukkan jumlah di atas Rp0')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Simpan', exact: true })).toBeDisabled();
    const tomorrow = new Date(Date.now() + 31 * 3600e3).toISOString().slice(0, 10);
    await page.locator('#paidOn').fill(tomorrow);
    await expect(page.getByText('Tanggal tidak boleh di masa depan')).toBeVisible();
  });

  test('EXP+ records an expense with Rp formatting and shows it in the list', async () => {
    await page.locator('#paidOn').fill(today());
    await page.locator('#amt').fill('123456');
    await expect(page.locator('#amt')).toHaveValue('123.456');
    await page.locator('#note').fill(`E2E expense ${RUN}`);
    await page.getByRole('button', { name: 'Simpan', exact: true }).click();
    await page.goto('/finance/expenses');
    const row = page.getByRole('link', { name: new RegExp(`E2E expense ${RUN}`) });
    await expect(row).toBeVisible();
    await row.click();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Hapus', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Hapus', exact: true }).click();
    await expect(page).toHaveURL(/\/finance\/expenses$/);
  });

  test('RECAP+ shows net profit and downloads the CSV', async () => {
    await page.goto('/finance/recap');
    await expect(page.getByText(/^Laba bersih/).first()).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Ekspor CSV' }).click();
    expect((await download).suggestedFilename()).toMatch(/^rekap-\d{4}-\d{2}\.csv$/);
  });
});

test.describe('Admin masters & settings (US-18 … US-21)', () => {
  test('ADMIN− a duplicate booking type name is rejected under the field', async () => {
    await page.goto('/admin/types');
    await page.getByRole('button', { name: '+ Tambah' }).click();
    await page.getByRole('dialog').getByRole('textbox').first().fill('studio only');
    await page.getByRole('dialog').getByRole('button', { name: 'Simpan' }).click();
    await expect(page.getByText('Nama sudah ada')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('ADMIN− settings: closing before opening is rejected', async () => {
    await page.goto('/admin/settings');
    await page.getByLabel('Tutup Minggu').fill('08:00');
    await page.getByRole('button', { name: 'Simpan pengaturan' }).click();
    await expect(page.getByText('Jam tutup harus setelah jam buka').first()).toBeVisible();
    await page.reload(); // discard the invalid edit
  });

  test('ADMIN− template with an unknown placeholder cannot be saved', async () => {
    await page.goto('/admin/templates');
    await page.getByLabel('Isi template').fill('Halo {clientname}');
    await expect(page.getByText(/Placeholder tidak dikenal: \{clientname\}/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Simpan template' })).toBeDisabled();
  });
});

test.describe('User management (register / edit / remove)', () => {
  const email = `e2e-staff-${RUN}@jes.local`;

  test('USERS− register: weak password keeps Save disabled; mismatched confirmation is refused', async () => {
    await page.goto('/admin/users');
    await page.getByRole('button', { name: '+ Daftarkan' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Nama').fill('E2E Staf');
    await dlg.getByLabel('Email (untuk masuk)').fill(email);
    await dlg.getByLabel('Kata sandi awal').fill('short1');
    await expect(dlg.getByText('○ Minimal 10 karakter')).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Simpan' })).toBeDisabled();
    await dlg.getByLabel('Kata sandi awal').fill('Studio-Staff-2026');
    await expect(dlg.getByText('✓ Minimal 10 karakter')).toBeVisible();
    await dlg.getByLabel('Ulangi kata sandi').fill('Studio-Staff-2027');
    await dlg.getByRole('button', { name: 'Simpan' }).click();
    await expect(dlg.getByText('Konfirmasi tidak sama')).toBeVisible();
  });

  test('USERS+ register a Staff account → listed as never signed in', async () => {
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Ulangi kata sandi').fill('Studio-Staff-2026');
    await dlg.getByRole('button', { name: 'Simpan' }).click();
    await expect(page.getByText(`${email} · Staf · belum pernah masuk`)).toBeVisible();
  });

  test('USERS− registering the same email again shows "Email sudah terdaftar"', async () => {
    await page.getByRole('button', { name: '+ Daftarkan' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Nama').fill('Dup');
    await dlg.getByLabel('Email (untuk masuk)').fill(email.toUpperCase());
    await dlg.getByLabel('Kata sandi awal').fill('Studio-Staff-2026');
    await dlg.getByLabel('Ulangi kata sandi').fill('Studio-Staff-2026');
    await dlg.getByRole('button', { name: 'Simpan' }).click();
    await expect(dlg.getByText('Email sudah terdaftar')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('USERS+ edit: rename and promote to Owner', async () => {
    await page.getByRole('button', { name: new RegExp(`E2E Staf.*${email.replace(/[.]/g, '\\.')}`) }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Nama').fill('E2E Manajer');
    await dlg.getByRole('button', { name: 'Owner', exact: true }).click();
    await dlg.getByRole('button', { name: 'Simpan' }).click();
    await expect(page.getByText(`${email} · Owner · belum pernah masuk`)).toBeVisible();
  });

  test('USERS− own account: Staff role and Hapus are not offered', async () => {
    await page.getByRole('button', { name: /\(Anda\)/ }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByRole('button', { name: 'Staf', exact: true })).toBeDisabled();
    await expect(dlg.getByRole('button', { name: 'Hapus' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('USERS+ remove a user after confirming → gone from the list and cannot sign in', async () => {
    await page.getByRole('button', { name: /E2E Manajer/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Hapus' }).click();
    await expect(page.getByRole('dialog').getByText(/tidak bisa masuk lagi/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Hapus pengguna' }).click();
    await expect(page.getByText(email)).toHaveCount(0);
    const r = await context.request.post('/api/v1/auth/login', { data: { email, password: 'Studio-Staff-2026' } });
    expect([401, 429]).toContain(r.status());
  });
});

test.describe('My account (self-service)', () => {
  test('ACCOUNT− wrong current password is refused; + correct one changes it and keeps this device signed in', async ({ browser }) => {
    const email = `e2e-self-${RUN}@jes.local`;
    await apiCall(context.request, 'POST', '/users', { name: 'E2E Self', email, password: 'Self-Service-2026', role: 'STAFF' });
    const s = await session(browser, { email, password: 'Self-Service-2026' });
    await s.page.goto('/me');
    await s.page.getByLabel('Kata sandi saat ini').fill('wrong-password-1');
    await s.page.getByLabel('Kata sandi baru', { exact: true }).fill('Self-Service-2027');
    await s.page.getByLabel('Ulangi kata sandi baru').fill('Self-Service-2027');
    await s.page.getByRole('button', { name: 'Ganti kata sandi' }).click();
    await expect(s.page.getByText('Kata sandi saat ini salah')).toBeVisible();
    await s.page.getByLabel('Kata sandi saat ini').fill('Self-Service-2026');
    await s.page.getByRole('button', { name: 'Ganti kata sandi' }).click();
    await expect(s.page.getByText(/Kata sandi diganti/)).toBeVisible();
    await s.page.reload();
    await expect(s.page.getByText(email)).toBeVisible(); // still signed in after reload
    await s.page.getByLabel('Nama').fill('E2E Self Renamed');
    await s.page.getByRole('button', { name: 'Simpan nama' }).click();
    await expect(s.page.getByText('Nama disimpan')).toBeVisible();
    await s.context.close();
    const users = (await apiCall(context.request, 'GET', '/users')).body;
    const u = users.find((x: any) => x.email === email);
    expect(u.name).toBe('E2E Self Renamed');
    await apiCall(context.request, 'DELETE', `/users/${u.id}`);
  });
});
