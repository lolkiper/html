/**
 * Получение 2FA-кода через сайт (по умолчанию https://2fa.live/).
 * Секрет вставляется на сайт, код считывается со страницы.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readCodeFromPage(page) {
  const selectors = [
    '#output',
    '#token',
    'input[readonly]',
    'textarea[readonly]',
    '[data-code]',
    '.token',
    '#code',
  ];

  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      const text = (await el.inputValue().catch(() => ''))
        || (await el.textContent().catch(() => ''))
        || '';
      const code = text.replace(/\D/g, '');
      if (code.length === 6) return code;
    }
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const match = bodyText.match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

export async function getTotpCodeFromWebsite(page, secret, websiteUrl = 'https://2fa.live/') {
  const cleanSecret = String(secret || '').replace(/\s+/g, '').toUpperCase();
  if (!cleanSecret) throw new Error('Пустой 2FA secret');

  await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const secretSelectors = [
    '#listToken',
    'input[name="secret"]',
    'input[type="text"]',
    'textarea',
  ];

  let filled = false;
  for (const sel of secretSelectors) {
    const input = page.locator(sel).first();
    if (await input.count().catch(() => 0)) {
      await input.fill(cleanSecret).catch(() => {});
      filled = true;
      break;
    }
  }

  if (!filled) {
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.type(cleanSecret, { delay: 30 });
  }

  const submit = page.locator('button:has-text("Submit"), input[type="submit"], button[type="submit"]').first();
  if (await submit.count().catch(() => 0)) {
    await submit.click().catch(() => page.keyboard.press('Enter'));
  } else {
    await page.keyboard.press('Enter').catch(() => {});
  }

  for (let i = 0; i < 15; i++) {
    await sleep(400);
    const code = await readCodeFromPage(page);
    if (code) {
      console.log(`[2FA] Код получен с сайта ${websiteUrl}: ******`);
      return code;
    }
  }

  throw new Error(`Не удалось получить 2FA-код с ${websiteUrl}`);
}
