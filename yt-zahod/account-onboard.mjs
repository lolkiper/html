import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { DolphinClient, normalizeToken } from './dolphin-api.mjs';
import { loginGoogleOnYouTube, setYouTubeLanguageEnglish } from './google-youtube-login.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const baseDir = process.cwd();
const configPath = path.join(baseDir, 'onboard-config.json');
const RESULTS_FILE = path.join(baseDir, 'onboard-results.json');

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Не найден onboard-config.json в ${baseDir}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

export function parseProxy(raw) {
  if (!raw || raw === '-' || raw === 'none') return null;

  let value = String(raw).trim();
  if (!value) return null;

  let type = 'http';
  const knownTypes = new Set(['http', 'https', 'socks4', 'socks5', 'ssh']);

  const atMatch = value.match(
    /^(?:(https?|socks4|socks5):\/\/)?(?<login>[^:]+):(?<password>[^@]+)@(?<host>[^:]+):(?<port>\d+)\/?$/i
  );
  if (atMatch?.groups) {
    return {
      host: atMatch.groups.host.trim(),
      port: atMatch.groups.port.trim(),
      login: atMatch.groups.login.trim(),
      password: atMatch.groups.password.trim(),
      type: (atMatch[1] || 'http').toLowerCase(),
    };
  }

  const schemeMatch = value.match(/^(https?|socks4|socks5):\/\/(.+)$/i);
  if (schemeMatch) {
    type = schemeMatch[1].toLowerCase();
    value = schemeMatch[2];
  }

  const parts = value.split(':');
  if (parts.length < 2) return null;

  const host = parts[0].trim();
  const port = parts[1].trim();

  if (parts.length >= 5 && knownTypes.has(parts[parts.length - 1].trim().toLowerCase())) {
    return {
      host,
      port,
      login: parts[2].trim(),
      password: parts.slice(3, -1).join(':').trim(),
      type: parts[parts.length - 1].trim().toLowerCase(),
    };
  }

  if (parts.length >= 4) {
    return {
      host,
      port,
      login: parts[2].trim(),
      password: parts.slice(3).join(':').trim(),
      type,
    };
  }

  if (parts.length === 3) {
    return {
      host,
      port,
      login: parts[2].trim(),
      password: '',
      type,
    };
  }

  return { host, port, login: '', password: '', type };
}

/**
 * Формат accounts.txt (одна строка = один аккаунт):
 * email|password|totp_secret|proxy|profile_name
 *
 * proxy — любой из форматов:
 *   http://host:port:login:pass
 *   host:port:login:pass:http
 *   login:pass@host:port
 * Если прокси нет — "-"
 * profile_name опционально.
 */
export function parseAccountsFile(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(baseDir, filePath);
  if (!fs.existsSync(abs)) throw new Error(`Файл аккаунтов не найден: ${abs}`);

  const lines = fs.readFileSync(abs, 'utf-8').split(/\r?\n/);
  const accounts = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 2) {
      console.warn(`⚠️ Строка ${i + 1}: мало полей, пропуск`);
      continue;
    }

    const [email, password, totpSecret = '', proxyRaw = '-', profileName = ''] = parts;
    accounts.push({
      line: i + 1,
      email,
      password,
      totpSecret,
      proxy: parseProxy(proxyRaw),
      profileName: profileName || email.split('@')[0],
    });
  }

  return accounts;
}

function loadResults() {
  if (!fs.existsSync(RESULTS_FILE)) return { accounts: [] };
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
  } catch {
    return { accounts: [] };
  }
}

function saveResult(entry) {
  const data = loadResults();
  const idx = data.accounts.findIndex((a) => a.email === entry.email);
  if (idx >= 0) data.accounts[idx] = entry;
  else data.accounts.push(entry);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeTotpWebsite(url) {
  let value = String(url || 'https://2fa.fb.tools/').trim();
  if (!value) value = 'https://2fa.fb.tools/';
  if (!/^https?:\/\//i.test(value)) value = `https://${value.replace(/^\/+/, '')}`;
  return value;
}

async function processAccount(account, config, dolphin) {
  const startedAt = new Date().toISOString();
  let profileId = account.existingProfileId || null;
  let browser = null;

  try {
    let usedExistingProfile = Boolean(account.existingProfileId);

    if (!profileId) {
      console.log(`\n🐬 Создаю профиль Dolphin: ${account.profileName}`);
      const created = await dolphin.createProfile({
        name: account.profileName,
        proxy: account.proxy,
        platform: config.PLATFORM || 'windows',
        browserVersion: config.BROWSER_VERSION || '140',
      });
      profileId = created.profileId;
      usedExistingProfile = false;
      console.log(`✅ Профиль создан: ID ${profileId}`);
    } else {
      console.log(`\n🐬 Использую существующий профиль: ${profileId}`);
    }

    const startBrowser = async () => {
      const { wsUrl } = await dolphin.startProfile(profileId, { headless: config.HEADLESS === true });
      browser = await chromium.connectOverCDP(wsUrl);
      const context = browser.contexts()[0] || await browser.newContext();
      const page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout(90000);
      return page;
    };

    let page;
    try {
      page = await startBrowser();
    } catch (startErr) {
      if (usedExistingProfile) {
        console.warn(`[Onboard] Профиль ${profileId} не запустился (${startErr.message}), создаю новый...`);
        if (profileId) await dolphin.stopProfile(profileId).catch(() => {});
        profileId = null;
        browser = null;
        const created = await dolphin.createProfile({
          name: account.profileName,
          proxy: account.proxy,
          platform: config.PLATFORM || 'windows',
          browserVersion: config.BROWSER_VERSION || '140',
        });
        profileId = created.profileId;
        console.log(`✅ Новый профиль создан: ID ${profileId}`);
        page = await startBrowser();
      } else {
        throw startErr;
      }
    }

    await loginGoogleOnYouTube(page, {
      email: account.email,
      password: account.password,
      totpSecret: account.totpSecret,
      totpWebsite: normalizeTotpWebsite(config.TOTP_WEBSITE),
    });

    await setYouTubeLanguageEnglish(page);

    saveResult({
      email: account.email,
      profileId,
      profileName: account.profileName,
      status: 'OK',
      language: 'en',
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    console.log(`✅ Готово: ${account.email} → профиль ${profileId}`);
    return { ok: true, profileId };
  } catch (err) {
    saveResult({
      email: account.email,
      profileId,
      profileName: account.profileName,
      status: 'ERROR',
      error: err.message,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    console.error(`❌ Ошибка ${account.email}: ${err.message}`);
    return { ok: false, error: err.message, profileId };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (profileId) await dolphin.stopProfile(profileId).catch(() => {});
  }
}

export async function runOnboard(options = {}) {
  const config = loadConfig();
  if (/dolphin-anty-api\.cc/i.test(config.DOLPHIN_CLOUD_API_URL || '')) {
    console.warn('[Onboard] ⚠️ В конфиге Cloud API .cc — используем https://dolphin-anty-api.com');
    config.DOLPHIN_CLOUD_API_URL = 'https://dolphin-anty-api.com';
  }
  config.DOLPHIN_TOKEN = normalizeToken(config.DOLPHIN_TOKEN);

  const accountsFile = options.accountsFile || config.ACCOUNTS_FILE || 'accounts.txt';
  const accounts = parseAccountsFile(accountsFile);

  if (!accounts.length) {
    console.log('Нет аккаунтов для обработки.');
    return;
  }

  const dolphin = new DolphinClient({
    localApiUrl: config.DOLPHIN_LOCAL_API_URL || config.DOLPHIN_API_URL || 'http://localhost:3001',
    cloudApiUrl: config.DOLPHIN_CLOUD_API_URL || 'https://dolphin-anty-api.com',
    token: config.DOLPHIN_TOKEN,
  });

  console.log('[Onboard] Авторизация в локальном Dolphin API...');
  await dolphin.loginWithToken();
  console.log('[Onboard] Проверка доступа к Cloud API...');
  await dolphin.verifyCloudAccess();

  const delayMs = Number(config.DELAY_BETWEEN_ACCOUNTS_MS ?? 5000);
  const results = loadResults();
  const doneEmails = new Set(results.accounts.filter((a) => a.status === 'OK').map((a) => a.email));

  let processed = 0;
  let ok = 0;
  let fail = 0;

  for (const account of accounts) {
    if (config.SKIP_ALREADY_OK && doneEmails.has(account.email)) {
      console.log(`⏭️ Пропуск (уже OK): ${account.email}`);
      continue;
    }

    const existing = results.accounts.find((a) => a.email === account.email && a.profileId);
    if (existing?.profileId) account.existingProfileId = existing.profileId;

    const result = await processAccount(account, config, dolphin);
    processed++;
    if (result.ok) ok++;
    else fail++;

    if (processed < accounts.length) {
      console.log(`[Onboard] Пауза ${delayMs / 1000}с перед следующим аккаунтом...`);
      await sleep(delayMs);
    }
  }

  console.log(`\n🏁 Итог: обработано ${processed}, успешно ${ok}, ошибок ${fail}`);
  console.log(`📄 Результаты: ${RESULTS_FILE}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runOnboard()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌', err.message);
      if (err.stack) console.error(err.stack);
      process.exit(1);
    });
}
