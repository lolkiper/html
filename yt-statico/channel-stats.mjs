import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { DolphinClient, normalizeToken } from './dolphin-api.mjs';
import { parseAccountsFile } from './account-onboard.mjs';
import { loginGoogleOnYouTube } from './google-youtube-login.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const baseDir = process.cwd();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadConfig() {
  const statsConfig = path.join(baseDir, 'stats-config.json');
  const onboardConfig = path.join(baseDir, 'onboard-config.json');

  if (fs.existsSync(statsConfig)) {
    return JSON.parse(fs.readFileSync(statsConfig, 'utf-8'));
  }
  if (fs.existsSync(onboardConfig)) {
    return {
      ...JSON.parse(fs.readFileSync(onboardConfig, 'utf-8')),
      USE_DOLPHIN: false,
      CHANNELS_FILE: 'channels.txt',
      STATS_RESULTS_FILE: 'channel-stats-results.json',
    };
  }

  return {
    USE_DOLPHIN: false,
    CHANNELS_FILE: 'channels.txt',
    STATS_RESULTS_FILE: 'channel-stats-results.json',
    ACCOUNTS_FILE: 'accounts.txt',
    DELAY_BETWEEN_CHANNELS_MS: 3000,
    HEADLESS: true,
  };
}

function useDolphin(config) {
  return config.USE_DOLPHIN === true || config.USE_DOLPHIN === 'true';
}

function buildPlaywrightProxy(proxy) {
  if (!proxy?.host || !proxy?.port) return undefined;
  const type = proxy.type || 'http';
  const server = `${type}://${proxy.host}:${proxy.port}`;
  const out = { server };
  if (proxy.login) {
    out.username = proxy.login;
    out.password = proxy.password || '';
  }
  return out;
}

function getResultsFile(config) {
  return path.join(baseDir, config.STATS_RESULTS_FILE || 'channel-stats-results.json');
}

function getOnboardResultsFile() {
  return path.join(baseDir, 'onboard-results.json');
}

function loadOnboardResults() {
  const file = getOnboardResultsFile();
  if (!fs.existsSync(file)) return { accounts: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { accounts: [] };
  }
}

function loadStatsResults(config) {
  const file = getResultsFile(config);
  if (!fs.existsSync(file)) return { channels: [], updatedAt: null };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { channels: [], updatedAt: null };
  }
}

function saveStatsResult(config, entry) {
  const data = loadStatsResults(config);
  const idx = data.channels.findIndex((c) => c.channelNumber === entry.channelNumber);
  if (idx >= 0) data.channels[idx] = entry;
  else data.channels.push(entry);
  data.channels.sort((a, b) => a.channelNumber - b.channelNumber);
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(getResultsFile(config), JSON.stringify(data, null, 2), 'utf-8');
}

export function extractChannelId(raw) {
  const value = String(raw || '').trim();
  if (!value || value.startsWith('#')) return null;

  const urlMatch = value.match(/youtube\.com\/channel\/(UC[\w-]{20,})/i);
  if (urlMatch) return urlMatch[1];

  const idMatch = value.match(/^(UC[\w-]{20,})$/i);
  if (idMatch) return idMatch[1];

  const pipeMatch = value.match(/^\d+\|(.+)$/);
  if (pipeMatch) return extractChannelId(pipeMatch[1]);

  return null;
}

export function parseChannelsFile(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(baseDir, filePath);
  if (!fs.existsSync(abs)) throw new Error(`Файл каналов не найден: ${abs}`);

  const lines = fs.readFileSync(abs, 'utf-8').split(/\r?\n/);
  const channels = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const channelId = extractChannelId(line);
    if (!channelId) {
      console.warn(`⚠️ Строка ${i + 1}: не удалось извлечь channel ID, пропуск`);
      continue;
    }

    channels.push({
      line: i + 1,
      channelNumber: channels.length + 1,
      channelId,
      raw: line,
    });
  }

  return channels;
}

function normalizeTotpWebsite(url) {
  let value = String(url || 'https://2fa.fb.tools/').trim();
  if (!value) value = 'https://2fa.fb.tools/';
  if (!/^https?:\/\//i.test(value)) value = `https://${value.replace(/^\/+/, '')}`;
  return value;
}

const BAN_PATTERNS = [
  /channel (?:has been )?terminated/i,
  /account has been terminated/i,
  /this channel does not exist/i,
  /channel is unavailable/i,
  /channel isn't available/i,
  /this account has been suspended/i,
  /нарушение правил/i,
  /канал (?:был )?удалён/i,
  /канал недоступен/i,
  /этот канал недоступен/i,
  /аккаунт (?:был )?заблокирован/i,
  /account (?:has been )?disabled/i,
  /community guidelines/i,
];

function detectBanFromText(text) {
  const value = String(text || '');
  return BAN_PATTERNS.some((re) => re.test(value));
}

function detectBanFromUrl(url) {
  const value = String(url || '').toLowerCase();
  return /disabled|banned|suspended|terminated|notavailable|oops/i.test(value);
}

async function parseChannelPage(page, channelId, { checkStudio = false } = {}) {
  const result = {
    channelId,
    channelUrl: `https://www.youtube.com/channel/${channelId}`,
    subscribers: '—',
    totalViews: '—',
    lastVideoTitle: '—',
    lastVideoViews: '—',
    lastVideoDate: '—',
    lastVideoUrl: null,
    isBlocked: false,
    blockReason: null,
    channelName: '—',
  };

  const videosUrl = `https://www.youtube.com/channel/${channelId}/videos`;
  const aboutUrl = `https://www.youtube.com/channel/${channelId}/about`;

  await page.goto(videosUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await sleep(4000);

  const currentUrl = page.url();
  if (detectBanFromUrl(currentUrl)) {
    result.isBlocked = true;
    result.blockReason = 'URL указывает на блокировку';
    return result;
  }

  const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (detectBanFromText(pageText)) {
    result.isBlocked = true;
    result.blockReason = 'Страница канала недоступна или заблокирована';
    return result;
  }

  result.channelName = await page.evaluate(() => {
    const el = document.querySelector('#channel-name #text, ytd-channel-name #text, #inner-header-container #text');
    return el?.textContent?.trim() || '—';
  }).catch(() => '—');

  result.subscribers = await page.evaluate(() => {
    const selectors = [
      '#subscriber-count',
      'yt-formatted-string#subscriber-count',
      '#owner-sub-count',
      'yt-content-metadata-view-model .yt-content-metadata-view-model__metadata-text',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const text = el?.textContent?.trim();
      if (text && /sub|подпис|subscriber|абонент/i.test(text)) {
        return text.replace(/^.*?(?=\d)/, '').trim() || text;
      }
    }
    const meta = Array.from(document.querySelectorAll('yt-content-metadata-view-model span, #subscriber-count'));
    for (const el of meta) {
      const text = el.textContent?.trim();
      if (text && /sub|подпис/i.test(text)) return text;
    }
    return '—';
  }).catch(() => '—');

  const lastVideo = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(
      'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer'
    ));
    for (const item of items) {
      const link = item.querySelector('a#video-title, a#thumbnail, a.yt-simple-endpoint[href*="/watch"]');
      const titleEl = item.querySelector('#video-title, .title, yt-formatted-string#video-title');
      const metaEls = Array.from(item.querySelectorAll('#metadata-line span, .inline-metadata-item, span.style-scope.ytd-video-meta-block'));
      const href = link?.getAttribute('href') || '';
      const title = titleEl?.textContent?.trim();
      if (!title) continue;
      return {
        title,
        href: href.startsWith('http') ? href : (href ? `https://www.youtube.com${href}` : null),
        meta: metaEls.map((el) => el.textContent?.trim()).filter(Boolean),
      };
    }
    return null;
  }).catch(() => null);

  if (lastVideo) {
    result.lastVideoTitle = lastVideo.title;
    result.lastVideoUrl = lastVideo.href;
    const meta = lastVideo.meta || [];

    const viewsLine = meta.find((m) => /view|просмотр|views/i.test(m));
    if (viewsLine) result.lastVideoViews = viewsLine;

    const dateLine = meta.find((m) => !/view|просмотр|views/i.test(m));
    if (dateLine) result.lastVideoDate = dateLine;
  }

  await page.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await sleep(3000);

  const aboutText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (detectBanFromText(aboutText) && !result.isBlocked) {
    result.isBlocked = true;
    result.blockReason = 'About-страница недоступна';
  }

  const totalViewsMatch = aboutText.match(
    /([\d.,\s]+[KkМмMmBb]?)\s*(?:total\s+)?views|([\d.,\s]+[KkМмMmBb]?)\s*просмотр/i
  );
  if (totalViewsMatch) {
    result.totalViews = (totalViewsMatch[1] || totalViewsMatch[2] || '').trim();
  }

  if (result.totalViews === '—') {
    result.totalViews = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('yt-formatted-string, span'));
      for (const el of rows) {
        const text = el.textContent?.trim() || '';
        if (/views|просмотр/i.test(text) && /\d/.test(text)) return text;
      }
      return '—';
    }).catch(() => '—');
  }

  if (checkStudio) {
    await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3000);

    const studioUrl = page.url();
    if (detectBanFromUrl(studioUrl)) {
      result.isBlocked = true;
      result.blockReason = result.blockReason || 'Studio: канал заблокирован';
    }

    const studioText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (detectBanFromText(studioText)) {
      result.isBlocked = true;
      result.blockReason = result.blockReason || 'Studio: нарушение / блокировка';
    }
  }

  if (!result.isBlocked && result.subscribers === '—' && result.totalViews === '—' && !lastVideo) {
    result.isBlocked = true;
    result.blockReason = 'Не удалось получить данные канала';
  }

  return result;
}

async function processChannel(channel, account, profileId, config, dolphin) {
  const startedAt = new Date().toISOString();
  let browser = null;

  const baseEntry = {
    channelNumber: channel.channelNumber,
    channelId: channel.channelId,
    channelUrl: `https://www.youtube.com/channel/${channel.channelId}`,
    email: account.email,
    profileId,
    profileName: account.profileName,
    startedAt,
  };

  try {
    if (!profileId) {
      throw new Error('Нет profileId — сначала запустите Onboard для этого аккаунта');
    }

    console.log(`\n📺 Канал №${channel.channelNumber}: ${channel.channelId}`);
    console.log(`   Аккаунт: ${account.email} | Профиль: ${profileId}`);

    const { wsUrl } = await dolphin.startProfile(profileId, { headless: config.HEADLESS === true });
    browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(90000);

    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const needsLogin = await page.evaluate(() => {
      const avatar = document.querySelector('button#avatar-btn img, #avatar-btn img, ytd-topbar-menu-button-renderer img');
      if (avatar) return false;
      const signInLink = document.querySelector('a[href*="ServiceLogin"], a[href*="accounts.google.com/ServiceLogin"]');
      return Boolean(signInLink);
    }).catch(() => true);

    if (needsLogin) {
      console.log(`   🔐 Вход в Google: ${account.email}`);
      await loginGoogleOnYouTube(page, {
        email: account.email,
        password: account.password,
        totpSecret: account.totpSecret,
        totpWebsite: normalizeTotpWebsite(config.TOTP_WEBSITE),
      });
    }

    const stats = await parseChannelPage(page, channel.channelId, { checkStudio: true });

    const entry = {
      ...baseEntry,
      ...stats,
      status: stats.isBlocked ? 'BLOCKED' : 'OK',
      finishedAt: new Date().toISOString(),
      error: null,
    };

    saveStatsResult(config, entry);

    console.log(`   ✅ Подписчики: ${entry.subscribers}`);
    console.log(`   👁 Всего просмотров: ${entry.totalViews}`);
    console.log(`   🎬 Последнее видео: ${entry.lastVideoTitle} (${entry.lastVideoViews}, ${entry.lastVideoDate})`);
    console.log(`   🚦 Статус: ${entry.status}${entry.blockReason ? ` — ${entry.blockReason}` : ''}`);

    return { ok: true, entry };
  } catch (err) {
    const entry = {
      ...baseEntry,
      status: 'ERROR',
      isBlocked: false,
      blockReason: null,
      subscribers: '—',
      totalViews: '—',
      lastVideoTitle: '—',
      lastVideoViews: '—',
      lastVideoDate: '—',
      channelName: '—',
      error: err.message,
      finishedAt: new Date().toISOString(),
    };
    saveStatsResult(config, entry);
    console.error(`   ❌ Ошибка: ${err.message}`);
    return { ok: false, error: err.message, entry };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (profileId) await dolphin.stopProfile(profileId).catch(() => {});
  }
}

async function processChannelPublic(channel, account, config, browser) {
  const startedAt = new Date().toISOString();
  let context = null;

  const baseEntry = {
    channelNumber: channel.channelNumber,
    channelId: channel.channelId,
    channelUrl: `https://www.youtube.com/channel/${channel.channelId}`,
    email: account?.email || '—',
    profileId: null,
    profileName: account?.profileName || '—',
    startedAt,
  };

  try {
    console.log(`\n📺 Канал №${channel.channelNumber}: ${channel.channelId}`);
    if (account?.email) console.log(`   Аккаунт (справочно): ${account.email}`);

    const proxy = buildPlaywrightProxy(account?.proxy);
    context = await browser.newContext(proxy ? { proxy } : {});
    const page = await context.newPage();
    page.setDefaultTimeout(90000);

    const stats = await parseChannelPage(page, channel.channelId, { checkStudio: false });

    const entry = {
      ...baseEntry,
      ...stats,
      status: stats.isBlocked ? 'BLOCKED' : 'OK',
      finishedAt: new Date().toISOString(),
      error: null,
    };

    saveStatsResult(config, entry);

    console.log(`   ✅ Подписчики: ${entry.subscribers}`);
    console.log(`   👁 Всего просмотров: ${entry.totalViews}`);
    console.log(`   🎬 Последнее видео: ${entry.lastVideoTitle} (${entry.lastVideoViews}, ${entry.lastVideoDate})`);
    console.log(`   🚦 Статус: ${entry.status}${entry.blockReason ? ` — ${entry.blockReason}` : ''}`);

    return { ok: true, entry };
  } catch (err) {
    const entry = {
      ...baseEntry,
      status: 'ERROR',
      isBlocked: false,
      blockReason: null,
      subscribers: '—',
      totalViews: '—',
      lastVideoTitle: '—',
      lastVideoViews: '—',
      lastVideoDate: '—',
      channelName: '—',
      error: err.message,
      finishedAt: new Date().toISOString(),
    };
    saveStatsResult(config, entry);
    console.error(`   ❌ Ошибка: ${err.message}`);
    return { ok: false, error: err.message, entry };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function runPublicStats(config, channels, accounts) {
  console.log('[Stats] Режим БЕЗ Dolphin — публичный парсинг youtube.com/channel/');
  console.log('[Stats] Dolphin Anty и onboard-results.json не нужны');

  const delayMs = Number(config.DELAY_BETWEEN_CHANNELS_MS ?? 3000);
  const headless = config.HEADLESS !== false;
  let browser = null;
  let processed = 0;
  let ok = 0;
  let fail = 0;

  try {
    browser = await chromium.launch({ headless });
    console.log(`[Stats] Браузер Playwright запущен (headless=${headless})`);

    for (const channel of channels) {
      const account = accounts[channel.channelNumber - 1] || null;
      const result = await processChannelPublic(channel, account, config, browser);
      processed++;
      if (result.ok) ok++;
      else fail++;

      if (processed < channels.length) {
        console.log(`[Stats] Пауза ${delayMs / 1000}с перед следующим каналом...`);
        await sleep(delayMs);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  console.log(`\n🏁 Итог: каналов ${processed}, успешно ${ok}, ошибок ${fail}`);
  console.log(`📄 Результаты: ${getResultsFile(config)}`);
}

async function runDolphinStats(config, channels, accounts) {
  if (/dolphin-anty-api\.cc/i.test(config.DOLPHIN_CLOUD_API_URL || '')) {
    config.DOLPHIN_CLOUD_API_URL = 'https://dolphin-anty-api.com';
  }
  config.DOLPHIN_TOKEN = normalizeToken(config.DOLPHIN_TOKEN);

  const onboardResults = loadOnboardResults();
  const profileByEmail = new Map(
    onboardResults.accounts
      .filter((a) => a.profileId)
      .map((a) => [a.email, a.profileId])
  );

  const dolphin = new DolphinClient({
    localApiUrl: config.DOLPHIN_LOCAL_API_URL || config.DOLPHIN_API_URL || 'http://localhost:3001',
    cloudApiUrl: config.DOLPHIN_CLOUD_API_URL || 'https://dolphin-anty-api.com',
    token: config.DOLPHIN_TOKEN,
  });

  console.log('[Stats] Режим Dolphin — профили из onboard-results.json');
  console.log('[Stats] Авторизация в локальном Dolphin API...');
  await dolphin.loginWithToken();
  console.log('[Stats] Проверка доступа к Cloud API...');
  await dolphin.verifyCloudAccess();

  const delayMs = Number(config.DELAY_BETWEEN_CHANNELS_MS ?? config.DELAY_BETWEEN_ACCOUNTS_MS ?? 5000);
  let processed = 0;
  let ok = 0;
  let fail = 0;

  for (const channel of channels) {
    const account = accounts[channel.channelNumber - 1];
    if (!account) {
      console.warn(`⚠️ Канал №${channel.channelNumber}: нет аккаунта в accounts.txt (строка ${channel.channelNumber})`);
      saveStatsResult(config, {
        channelNumber: channel.channelNumber,
        channelId: channel.channelId,
        status: 'ERROR',
        error: 'Нет соответствующего аккаунта в accounts.txt',
        finishedAt: new Date().toISOString(),
      });
      fail++;
      continue;
    }

    const profileId = profileByEmail.get(account.email);
    const result = await processChannel(channel, account, profileId, config, dolphin);
    processed++;
    if (result.ok) ok++;
    else fail++;

    if (processed < channels.length) {
      console.log(`[Stats] Пауза ${delayMs / 1000}с перед следующим каналом...`);
      await sleep(delayMs);
    }
  }

  console.log(`\n🏁 Итог: каналов ${processed}, успешно ${ok}, ошибок ${fail}`);
  console.log(`📄 Результаты: ${getResultsFile(config)}`);
}

export async function runChannelStats(options = {}) {
  const config = loadConfig();
  const channelsFile = config.CHANNELS_FILE || 'channels.txt';
  const channels = parseChannelsFile(channelsFile);

  if (!channels.length) {
    console.log('Нет каналов для проверки.');
    return;
  }

  const accountsFile = config.ACCOUNTS_FILE || 'accounts.txt';
  let accounts = [];
  try {
    accounts = parseAccountsFile(accountsFile);
  } catch (err) {
    if (useDolphin(config)) throw err;
    console.warn(`[Stats] accounts.txt не найден — только коды каналов`);
  }

  if (useDolphin(config)) {
    await runDolphinStats(config, channels, accounts);
  } else {
    await runPublicStats(config, channels, accounts);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runChannelStats()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌', err.message);
      if (err.stack) console.error(err.stack);
      process.exit(1);
    });
}
