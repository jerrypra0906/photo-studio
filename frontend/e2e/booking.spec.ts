import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { OWNER, RUN, apiCall, expectNoHorizontalScroll, futureDay, session } from './helpers';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const day = futureDay();
const client = `E2E Lilin ${RUN}`;
let bookingUrl = '';
const created: string[] = [];

test.beforeAll(async ({ browser }) => ({ context, page } = await session(browser, OWNER)));
test.afterAll(async () => {
  for (const id of created) await apiCall(context.request, 'POST', `/bookings/${id}/cancel`, { reason: 'OTHER', note: 'e2e cleanup' });
  await context.close();
});

async function ids() {
  const types = (await apiCall(context.request, 'GET', '/booking-types')).body;
  return { SO: types.find((t: any) => t.name === 'Studio Only').id, PP: types.find((t: any) => t.name === 'Photo Package').id };
}

test.describe('New booking form (US-03 … US-11)', () => {
  test('BOOK− Save stays disabled until type, time, client and photographer are valid', async () => {
    await page.goto(`/bookings/new?date=${day}`);
    const save = page.getByRole('button', { name: 'Simpan booking' });
    await expect(save).toBeDisabled();
    await page.getByRole('button', { name: /^Photo Package/ }).click();
    await page.getByRole('button', { name: '10:00', exact: true }).click();
    await page.locator('#cn').fill('Ab');
    await expect(save).toBeDisabled(); // Photo Package needs a photographer (US-07.3)
    await page.getByRole('button', { name: 'Hamja', exact: true }).click();
    await expect(save).toBeEnabled();
  });

  test('BOOK− an invalid phone number shows an inline error and blocks Save', async () => {
    await page.locator('#cp').fill('12ab');
    await expect(page.getByText('Masukkan nomor telepon yang valid')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Simpan booking' })).toBeDisabled();
    await page.locator('#cp').fill('0821 2350 0508');
    await expect(page.getByText('Masukkan nomor telepon yang valid')).toHaveCount(0);
  });

  test('BOOK+ live total: Photo Package 1h + MUA + Hairdo + Dekorasi = Rp1.449.000; balance after DP', async () => {
    await page.getByRole('switch', { name: 'MUA + Hairdo' }).click();
    await page.getByRole('switch', { name: 'Dekorasi' }).click();
    await expect(page.getByText('Rp1.449.000').first()).toBeVisible();
    await page.getByRole('button', { name: /Pembayaran/ }).click();
    await page.locator('#dp').fill('500000');
    await expect(page.locator('#dp')).toHaveValue('500.000'); // thousands separators while typing
    await page.getByRole('button', { name: /^Total/ }).click(); // expand breakdown
    await expect(page.getByText('Rp949.000')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('BOOK+ save creates JES-YYMMDD-NNN and opens the detail with the price breakdown', async () => {
    await page.locator('#cn').fill(client);
    await page.getByRole('button', { name: 'Simpan booking' }).click();
    await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
    bookingUrl = page.url();
    created.push(bookingUrl.split('/').pop()!);
    await expect(page.getByRole('heading', { name: new RegExp(`^JES-${day.slice(2).replace(/-/g, '')}-\\d{3}$`) })).toBeVisible();
    await expect(page.getByText(client)).toBeVisible();
    await expect(page.getByText('Rp1.449.000').first()).toBeVisible();
  });

  test('BOOK− the booked slot is no longer offered; a manual clashing time names the clash', async () => {
    await page.goto(`/bookings/new?date=${day}`);
    await page.getByRole('button', { name: /^Studio Only/ }).click();
    await expect(page.getByRole('button', { name: '10:00', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '11:00', exact: true })).toBeVisible();
    await page.getByText('Jam lain (di luar jam buka)').click();
    await page.getByLabel('Jam mulai manual').fill('10:30');
    await expect(page.getByText(/^Bentrok dengan JES-/)).toBeVisible();
    await page.locator('#cn').fill('Clash test');
    await expect(page.getByRole('button', { name: 'Simpan booking' })).toBeDisabled();
  });
});

test.describe('Booking detail (US-13 … US-17)', () => {
  test('BOOK+ WhatsApp sheet: filled message with total and a wa.me link', async () => {
    await page.goto(bookingUrl);
    await page.getByRole('button', { name: 'WhatsApp', exact: true }).click();
    const text = page.getByLabel('Teks pesan');
    await expect(text).toHaveValue(new RegExp(`Halo kak ${client}`));
    await expect(text).toHaveValue(/Total: Rp1\.449\.000/);
    await expect(page.getByRole('link', { name: 'Buka WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/6282123500508\?text=/);
    await page.keyboard.press('Escape');
  });

  test('BOOK+ invoice sheet loads the PDF and offers a download', async () => {
    await page.getByRole('button', { name: 'Invoice (PDF)' }).click();
    await expect(page.getByRole('link', { name: 'Unduh' })).toHaveAttribute('download', /^Invoice_.+\.pdf$/);
    await page.keyboard.press('Escape');
  });

  test('BOOK+ edit: adding Extra person raises the total and creates invoice revision R1', async () => {
    await page.getByRole('button', { name: 'Menu lainnya' }).click();
    await page.getByRole('button', { name: 'Ubah / jadwal ulang' }).click();
    await page.getByRole('button', { name: /^Extra person/ }).click();
    await expect(page.getByText('Rp1.474.000').first()).toBeVisible();
    await page.getByRole('button', { name: 'Simpan', exact: true }).click();
    await expect(page).toHaveURL(bookingUrl);
    await expect(page.getByText('Rp1.474.000').first()).toBeVisible();
    await expect(page.getByText(/Invoice R1/)).toBeVisible();
  });

  test('BOOK− cancelling without a reason is refused; with a reason the booking is cancelled', async () => {
    await page.getByRole('button', { name: 'Menu lainnya' }).click();
    await page.getByRole('button', { name: 'Batalkan booking' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Batalkan', exact: true }).click();
    await expect(page.getByText('Pilih alasan')).toBeVisible();
    await page.getByLabel('Klien membatalkan').check();
    await page.getByRole('dialog').getByRole('button', { name: 'Batalkan', exact: true }).click();
    await expect(page.getByText('Dibatalkan', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/DP Rp500\.000 tercatat/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invoice (PDF)' })).toHaveCount(0);
  });

  test('BOOK+ complete a past session as paid in full', async () => {
    const { SO } = await ids();
    // completed bookings from earlier runs stay on their dates, so retry until a past slot is free
    let b: any;
    for (let i = 0; i < 10 && !b?.id; i++) {
      const past = `19${80 + Math.floor(Math.random() * 20)}-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}`;
      b = (await apiCall(context.request, 'POST', '/bookings', { typeId: SO, hours: 1, date: past, startTime: `${10 + Math.floor(Math.random() * 8)}:00`, clientName: `E2E Past ${RUN}` })).body;
    }
    expect(b?.id, 'could not create a past booking').toBeTruthy();
    await page.goto(`/bookings/${b.id}`);
    await expect(page.getByText('Sesi sudah lewat.')).toBeVisible();
    await page.getByRole('button', { name: 'Tandai selesai' }).first().click();
    await page.getByRole('button', { name: 'Lunas', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Tandai selesai' }).click();
    await expect(page.getByText('Selesai', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Lunas', { exact: true }).first()).toBeVisible();
  });
});

test.describe('Schedule & search (US-12)', () => {
  test('BOOK+ schedule shows the booking; tapping an empty slot opens a pre-filled form', async () => {
    const { SO } = await ids();
    const d = futureDay(3);
    const b = (await apiCall(context.request, 'POST', '/bookings', { typeId: SO, hours: 2, date: d, startTime: '13:00', clientName: `E2E Sched ${RUN}` })).body;
    created.push(b.id);
    await page.goto(`/schedule?date=${d}`);
    await expect(page.getByRole('link', { name: new RegExp(`E2E Sched ${RUN}`) })).toBeVisible();
    await page.getByRole('button', { name: 'Booking 16:00' }).click();
    await expect(page).toHaveURL(new RegExp(`/bookings/new\\?date=${d}&time=16:00`));
    await expect(page.locator('#date')).toHaveValue(d);
  });

  test('BOOK+ search finds a booking by partial client name; − nonsense finds nothing', async () => {
    await page.goto('/bookings');
    await page.getByLabel('Cari booking').fill(`sched ${RUN}`);
    await expect(page.getByText(`E2E Sched ${RUN}`)).toBeVisible();
    await page.getByLabel('Cari booking').fill(`zzz-${RUN}-none`);
    await expect(page.getByText('Tidak ada booking yang cocok.')).toBeVisible();
  });
});
