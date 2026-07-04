import { getTotpCodeFromWebsite } from './totp-website.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      await loc.click({ timeout: 8000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      await loc.fill(value, { timeout: 8000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function pressNext(page) {
  const clicked = await clickFirst(page, [
    '#identifierNext button',
    '#passwordNext button',
    '#totpNext button',
    'button:has-text("Next")',
    'button:has-text("Далее")',
    'button:has-text("Siguiente")',
    'button:has-text("Weiter")',
    'div[role="button"]:has-text("Next")',
    'div[role="button"]:has-text("Далее")',
  ]);
  if (!clicked) await page.keyboard.press('Enter').catch(() => {});
}

export async function loginGoogleOnYouTube(page, { email, password, totpSecret, totpWebsite }) {
  console.log(`[Login] Открываю YouTube для входа: ${email}`);
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(1500);

  const signInClicked = await clickFirst(page, [
    'a[href*="ServiceLogin"]',
    'yt-button-shape a[href*="accounts.google"]',
    'a:has-text("Sign in")',
    'a:has-text("Войти")',
    'a:has-text("Iniciar sesión")',
    'tp-yt-paper-button:has-text("Sign in")',
    'tp-yt-paper-button:has-text("Войти")',
  ]);

  if (!signInClicked) {
    await page.goto('https://accounts.google.com/signin/v2/identifier?service=youtube', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
  }

  await page.waitForSelector('input[type="email"], #identifierId', { timeout: 60000 });
  await fillFirst(page, ['#identifierId', 'input[type="email"]'], email);
  await pressNext(page);
  await sleep(2000);

  await page.waitForSelector('input[type="password"], input[name="Passwd"]', { timeout: 60000 });
  await fillFirst(page, ['input[name="Passwd"]', 'input[type="password"]'], password);
  await pressNext(page);
  await sleep(2500);

  const needs2fa = await page.locator(
    'input[name="totpPin"], input[type="tel"], #totpPin, input[aria-label*="code"], input[aria-label*="код"]'
  ).first().isVisible({ timeout: 8000 }).catch(() => false);

  if (needs2fa) {
    if (!totpSecret) throw new Error('Требуется 2FA, но secret не указан в accounts.txt');

    console.log('[Login] Требуется 2FA — получаю код через сайт...');
    const totpPage = await page.context().newPage();
    try {
      const code = await getTotpCodeFromWebsite(totpPage, totpSecret, totpWebsite);
      await fillFirst(page, [
        'input[name="totpPin"]',
        'input[type="tel"]',
        '#totpPin',
        'input[autocomplete="one-time-code"]',
      ], code);
      await pressNext(page);
      await sleep(3000);
    } finally {
      await totpPage.close().catch(() => {});
    }
  }

  const challenge = await page.locator('text=/confirm|подтверд|verify|challenge/i').first()
    .isVisible({ timeout: 5000 }).catch(() => false);
  if (challenge) {
    throw new Error('Google запросил дополнительную проверку (капча/телефон) — нужен ручной вход');
  }

  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(2000);
  console.log(`[Login] Вход выполнен: ${email}`);
}

export async function setYouTubeLanguageEnglish(page) {
  console.log('[Login] Меняю язык интерфейса YouTube на English...');

  const urls = [
    'https://www.youtube.com/account',
    'https://www.youtube.com/account_playback',
    'https://www.youtube.com/account_notifications',
  ];

  for (const url of urls) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await sleep(1500);

    const englishOption = page.locator([
      'tp-yt-paper-item:has-text("English")',
      'yt-formatted-string:has-text("English")',
      'a:has-text("English (US)")',
      'a:has-text("English")',
      'button:has-text("English")',
      '[role="menuitem"]:has-text("English")',
    ].join(', ')).first();

    if (await englishOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      await englishOption.click().catch(() => {});
      await sleep(2000);
      console.log('[Login] Язык YouTube переключён на English');
      return true;
    }

    const languageRow = page.locator([
      'text=/Language|Язык|Idioma/i',
      'yt-formatted-string:has-text("Language")',
      'yt-formatted-string:has-text("Язык")',
    ].join(', ')).first();

    if (await languageRow.isVisible({ timeout: 3000 }).catch(() => false)) {
      await languageRow.click().catch(() => {});
      await sleep(1000);
      const eng = page.locator('tp-yt-paper-item:has-text("English"), yt-formatted-string:has-text("English")').first();
      if (await eng.isVisible({ timeout: 5000 }).catch(() => false)) {
        await eng.click().catch(() => {});
        await sleep(2000);
        console.log('[Login] Язык YouTube переключён на English (через меню)');
        return true;
      }
    }
  }

  await page.goto('https://www.youtube.com/?hl=en&gl=US&persist_hl=1', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  }).catch(() => {});
  console.log('[Login] Применён fallback URL ?hl=en — проверьте язык вручную при необходимости');
  return false;
}
