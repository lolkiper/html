/**
 * Получение 2FA-кода через сайт (по умолчанию https://2fa.fb.tools/).
 * Для 2fa.fb.tools используется публичный API: GET /api/otp/{secret}
 * Для других сайтов (2fa.live и т.д.) — вставка secret в форму через Playwright.
 */

import axios from 'axios';

const DEFAULT_TOTP_SITE = 'https://2fa.fb.tools/';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanSecret(secret) {
  let value = String(secret || '').trim();
  const otpauthMatch = value.match(/[?&]secret=([A-Za-z2-7]+)/i);
  if (otpauthMatch) value = otpauthMatch[1];
  return value.replace(/\s+/g, '').toUpperCase();
}

function normalizeWebsiteUrl(websiteUrl) {
  let url = String(websiteUrl || DEFAULT_TOTP_SITE).trim();
  if (!url) url = DEFAULT_TOTP_SITE;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url.replace(/^\/+/, '')}`;
  }
  return url.replace(/\/$/, '');
}

function isFbToolsSite(websiteUrl) {
  return /2fa\.fb\.tools/i.test(String(websiteUrl || ''));
}

function fbToolsApiBase(websiteUrl) {
  return normalizeWebsiteUrl(websiteUrl).replace(/\/(ru|uk|th)$/i, '');
}

async function getCodeFromFbToolsApi(secret, websiteUrl) {
  const base = fbToolsApiBase(websiteUrl);
  const apiUrl = `${base}/api/otp/${encodeURIComponent(secret)}`;
  const { data } = await axios.get(apiUrl, {
      timeout: 30000,
      headers: { Accept: 'application/json' },
    }
  );

  const code = String(data?.data?.otp || data?.otp || '').replace(/\D/g, '');
  if (code.length === 6) {
    console.log('[2FA] Код получен через API 2fa.fb.tools: ******');
    return code;
  }

  throw new Error(`2fa.fb.tools API не вернул код: ${JSON.stringify(data)}`);
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
    '[class*="otp"]',
    '[class*="code"]',
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

async function getCodeFromBrowserForm(page, secret, websiteUrl) {
  const url = normalizeWebsiteUrl(websiteUrl);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);

  const secretSelectors = [
    'input[placeholder*="secret" i]',
    'input[aria-label*="secret" i]',
    '#listToken',
    'input[name="secret"]',
    'input[type="text"]',
    'textarea',
  ];

  let filled = false;
  for (const sel of secretSelectors) {
    const input = page.locator(sel).first();
    if (await input.count().catch(() => 0)) {
      await input.fill(secret).catch(() => {});
      filled = true;
      break;
    }
  }

  if (!filled) {
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.type(secret, { delay: 30 });
  }

  const submit = page.locator(
    'button:has-text("Submit"), button:has-text("Generate"), input[type="submit"], button[type="submit"]'
  ).first();
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

export async function getTotpCodeFromWebsite(page, secret, websiteUrl = DEFAULT_TOTP_SITE) {
  const normalizedSecret = cleanSecret(secret);
  if (!normalizedSecret) throw new Error('Пустой 2FA secret');

  const normalizedSite = normalizeWebsiteUrl(websiteUrl);

  if (isFbToolsSite(normalizedSite)) {
    return getCodeFromFbToolsApi(normalizedSecret, normalizedSite);
  }

  if (!page) {
    throw new Error('Для этого 2FA-сайта нужен браузер (page), укажите 2fa.fb.tools для API');
  }

  return getCodeFromBrowserForm(page, normalizedSecret, normalizedSite);
}
