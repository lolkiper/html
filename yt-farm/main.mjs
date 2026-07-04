import { uploadVideo } from './youtube-studio.mjs';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * main.mjs — единственная точка входа фермы.
 * Worker: node main.mjs <slot> <dolphin_profile_id>
 * Панель: spawn(process.execPath, [main.mjs, slot, profileId], { cwd: process.cwd() })
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const baseDir = process.cwd();
const configPath = path.join(baseDir, 'config.json');

if (!fs.existsSync(configPath)) {
  console.error(`❌ Критическая ошибка: Файл конфигурации не найден по пути: ${configPath}`);
  process.exit(1);
}

function normalizeConfig(raw) {
  const schedule = raw.SCHEDULE_SETTINGS || {};
  return {
    ...raw,
    MAX_PARALLEL_SLOTS: raw.MAX_PARALLEL_SLOTS ?? raw.CONCURRENCY_LIMIT ?? 1,
    SCHEDULE_SETTINGS: {
      ...schedule,
      VIDEOS_PER_CHANNEL: schedule.VIDEOS_PER_CHANNEL ?? raw.VIDEOS_PER_CHANNEL ?? 16,
    },
    ANTIDETECT: raw.ANTIDETECT || {},
  };
}

const CONFIG = normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')));

const SCHEDULE_SETTINGS = CONFIG.SCHEDULE_SETTINGS || {};
const ANTIDETECT = CONFIG.ANTIDETECT || {};
const VIDEOS_PER_CHANNEL = SCHEDULE_SETTINGS.VIDEOS_PER_CHANNEL ?? 16;
const BATCH_SIZE = SCHEDULE_SETTINGS.BATCH_SIZE ?? 10;

const CHANNEL_STATE_FILE = path.join(baseDir, 'channel-state.json');
const CHANNEL_STATE_LOCK_FILE = path.join(baseDir, 'channel-state.lock');

const LOCK_STALE_MS = SCHEDULE_SETTINGS.LOCK_STALE_MS ?? 5 * 60 * 1000;
const LOCK_RETRY_MS = SCHEDULE_SETTINGS.LOCK_RETRY_MS ?? 250;
const LOCK_MAX_WAIT_MS = SCHEDULE_SETTINGS.LOCK_MAX_WAIT_MS ?? 120000;

// =============================================================================
// MUTEX: эксклюзивные lock-файлы (channel-state.lock / history_profile_*.lock)
// =============================================================================

function syncSleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function capDelay(ms) {
  if (ms > 10000) return 5000;
  if (ms >= 2000) return 1000;
  return ms;
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function acquireFileLock(lockPath, label) {
  const started = Date.now();
  while (Date.now() - started < LOCK_MAX_WAIT_MS) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* lock исчез */ }
      syncSleep(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Таймаут ожидания ${label} (${lockPath})`);
}

function releaseFileLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const lockPid = parseInt(raw.split('\n')[0], 10);
    if (lockPid === process.pid) fs.unlinkSync(lockPath);
  } catch { /* уже снят */ }
}

function withFileLock(lockPath, label, fn) {
  acquireFileLock(lockPath, label);
  try {
    return fn();
  } finally {
    releaseFileLock(lockPath);
  }
}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function pauseBetweenUploads() {
  const rawMin = Number(ANTIDETECT.BETWEEN_UPLOAD_MIN_MS ?? 1000);
  const rawMax = Number(ANTIDETECT.BETWEEN_UPLOAD_MAX_MS ?? 1000);
  const lo = Math.min(rawMin, rawMax);
  const hi = Math.max(rawMin, rawMax);
  const waitMs = capDelay(randomBetween(lo, hi));
  console.log(`[Anti-detect] Пауза ${Math.round(waitMs / 1000)}с перед следующим видео...`);
  return new Promise((r) => setTimeout(r, waitMs));
}

// =============================================================================
// РАСПИСАНИЕ КАНАЛОВ (per-channel state в channel-state.json)
// =============================================================================

const SCHEDULE_DEFAULTS = {
  STEP_HOURS: 6,
  NEW_CHANNEL_START_HOUR: 7,
  LOW_SCHEDULE_THRESHOLD: 10,
  VIDEOS_PER_CHANNEL: 16,
  SCHEDULE_EXTENSION_BUFFER: 16,
};

function mergeScheduleSettings(settings = {}) {
  return { ...SCHEDULE_DEFAULTS, ...settings };
}

function parseScheduleTime(str) {
  const [datePart, timePart] = str.split(' ');
  const [day, month, year] = datePart.split('.').map(Number);
  const [hours, minutes] = timePart.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function formatScheduleTime(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

function addScheduleHours(date, hours) {
  const result = new Date(date.getTime());
  result.setHours(result.getHours() + hours);
  return result;
}

function snapToQuarterHour(date) {
  const result = new Date(date.getTime());
  result.setMinutes(Math.round(result.getMinutes() / 15) * 15);
  result.setSeconds(0, 0);
  return result;
}

function addScheduleStep(date, settings) {
  const merged = mergeScheduleSettings(settings);
  return snapToQuarterHour(addScheduleHours(date, merged.STEP_HOURS));
}

function getTomorrowAt(hour) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function generateInitialSchedule(slotCount, settings) {
  const merged = mergeScheduleSettings(settings);
  const schedule = [];
  let current = snapToQuarterHour(getTomorrowAt(merged.NEW_CHANNEL_START_HOUR));
  for (let i = 0; i < slotCount; i++) {
    schedule.push(formatScheduleTime(current));
    if (i < slotCount - 1) current = addScheduleStep(current, merged);
  }
  return schedule;
}

function extendSchedule(existingSchedule, slotsToAdd, settings) {
  const merged = mergeScheduleSettings(settings);
  if (!existingSchedule.length) return generateInitialSchedule(slotsToAdd, merged);
  const extended = [...existingSchedule];
  let last = parseScheduleTime(extended[extended.length - 1]);
  for (let i = 0; i < slotsToAdd; i++) {
    last = addScheduleStep(last, merged);
    extended.push(formatScheduleTime(last));
  }
  return extended;
}

function loadChannelStateUnsafe() {
  if (!fs.existsSync(CHANNEL_STATE_FILE)) return { version: 1, channels: {} };
  try {
    return JSON.parse(fs.readFileSync(CHANNEL_STATE_FILE, 'utf-8'));
  } catch {
    return { version: 1, channels: {} };
  }
}

function saveChannelStateUnsafe(state) {
  atomicWriteJson(CHANNEL_STATE_FILE, state);
}

function withChannelStateLock(fn) {
  return withFileLock(CHANNEL_STATE_LOCK_FILE, 'channel-state.lock', fn);
}

function loadChannelState() {
  return withChannelStateLock(() => loadChannelStateUnsafe());
}

function mutateChannelState(mutator) {
  return withChannelStateLock(() => {
    const state = loadChannelStateUnsafe();
    const result = mutator(state);
    saveChannelStateUnsafe(state);
    return result;
  });
}

function getChannelFromState(channelNumber) {
  const state = loadChannelState();
  return state.channels[String(channelNumber)] || null;
}

function syncChannelsFromMapping(profileMapping) {
  return mutateChannelState((state) => {
    const discovered = { new: [], existing: [] };

    for (const [profileId, channelData] of Object.entries(profileMapping || {})) {
      const channelNumber = channelData?.[0];
      if (!channelNumber) continue;
      const key = String(channelNumber);

      if (!state.channels[key]) {
        state.channels[key] = {
          channelNumber,
          profileId,
          initialized: false,
          schedule: [],
          createdAt: new Date().toISOString(),
        };
        discovered.new.push({ channelNumber, profileId });
      } else {
        discovered.existing.push({ channelNumber, profileId });
        if (state.channels[key].profileId !== profileId) {
          state.channels[key].profileId = profileId;
        }
      }
    }

    return discovered;
  });
}

function migrateScheduleFromHistory(channelNumber, history, settings) {
  const merged = mergeScheduleSettings(settings);

  return mutateChannelState((state) => {
    const key = String(channelNumber);
    const channel = state.channels[key];
    if (!channel) return null;

    const uploads = (history.uploaded || [])
      .filter((item) => item.channel === channelNumber && item.scheduledFor)
      .sort((a, b) => parseScheduleTime(a.scheduledFor) - parseScheduleTime(b.scheduledFor));

    if (!uploads.length) return null;
    if (channel.initialized && channel.schedule.length) return channel.schedule;

    const schedule = uploads.map((u) => u.scheduledFor);
    const uploadedCount = uploads.length;
    const remaining = merged.VIDEOS_PER_CHANNEL - uploadedCount;

    channel.schedule = remaining > 0
      ? extendSchedule(schedule, Math.max(remaining, merged.LOW_SCHEDULE_THRESHOLD), merged)
      : schedule;
    channel.initialized = true;
    channel.initializedAt = channel.initializedAt || new Date().toISOString();
    channel.migratedFromHistory = true;

    console.log(`[Schedule] Канал №${channelNumber}: миграция из history (${uploadedCount} слотов, всего ${channel.schedule.length})`);
    return channel.schedule;
  });
}

function migrateScheduleFromLegacyConfig(channelNumber, legacySchedule, settings) {
  if (!legacySchedule?.length) return null;

  return mutateChannelState((state) => {
    const key = String(channelNumber);
    const channel = state.channels[key];
    if (!channel || channel.initialized) return channel?.schedule || null;

    channel.schedule = [...legacySchedule];
    channel.initialized = true;
    channel.initializedAt = new Date().toISOString();
    channel.migratedFromLegacyConfig = true;

    console.log(`[Schedule] Канал №${channelNumber}: миграция из CONFIG.SCHEDULE (${legacySchedule.length} слотов)`);
    return channel.schedule;
  });
}

function initializeChannelSchedule(channelNumber, settings) {
  const merged = mergeScheduleSettings(settings);

  return mutateChannelState((state) => {
    const key = String(channelNumber);
    const channel = state.channels[key];
    if (!channel) throw new Error(`Канал №${channelNumber} не найден в channel-state.json`);
    if (channel.initialized && channel.schedule.length) return channel.schedule;

    channel.schedule = generateInitialSchedule(merged.VIDEOS_PER_CHANNEL, merged);
    channel.initialized = true;
    channel.initializedAt = new Date().toISOString();

    console.log(`[Schedule] Канал №${channelNumber}: новое расписание с ${channel.schedule[0]} (${channel.schedule.length} слотов, шаг ${merged.STEP_HOURS}ч, минуты fuzz в Studio)`);
    return channel.schedule;
  });
}

function ensureChannelScheduleCapacity(channelNumber, uploadedCount, settings) {
  const merged = mergeScheduleSettings(settings);

  return mutateChannelState((state) => {
    const key = String(channelNumber);
    const channel = state.channels[key];
    if (!channel) throw new Error(`Канал №${channelNumber} не найден в channel-state.json`);

    if (!channel.initialized) {
      channel.schedule = generateInitialSchedule(merged.VIDEOS_PER_CHANNEL, merged);
      channel.initialized = true;
      channel.initializedAt = new Date().toISOString();
      return channel.schedule;
    }

    const remainingSlots = channel.schedule.length - uploadedCount;
    if (remainingSlots < merged.LOW_SCHEDULE_THRESHOLD) {
      const videosStillNeeded = Math.max(0, merged.VIDEOS_PER_CHANNEL - uploadedCount);
      const targetRemaining = Math.max(videosStillNeeded, merged.LOW_SCHEDULE_THRESHOLD, merged.SCHEDULE_EXTENSION_BUFFER);
      const slotsToAdd = targetRemaining - remainingSlots;

      if (slotsToAdd > 0) {
        const before = channel.schedule.length;
        const lastSlot = channel.schedule[channel.schedule.length - 1];
        channel.schedule = extendSchedule(channel.schedule, slotsToAdd, merged);
        channel.lastExtendedAt = new Date().toISOString();
        console.log(`[Schedule] Канал №${channelNumber}: продлено ${before} → ${channel.schedule.length} (последний был ${lastSlot}, новый ${channel.schedule[channel.schedule.length - 1]})`);
      }
    }

    return channel.schedule;
  });
}

function getChannelBatchSlots(channelNumber, uploadedCount, batchSize) {
  const channel = getChannelFromState(channelNumber);
  if (!channel?.schedule?.length) return [];
  return channel.schedule.slice(uploadedCount, uploadedCount + batchSize);
}

function prepareChannelSchedule(channelNumber, profileId, history, settings, legacySchedule) {
  const merged = mergeScheduleSettings(settings);
  syncChannelsFromMapping({ [profileId]: [channelNumber] });

  const channel = getChannelFromState(channelNumber);
  const isInitialized = Boolean(channel?.initialized && channel.schedule?.length);

  let schedule =
    migrateScheduleFromHistory(channelNumber, history, merged) ||
    migrateScheduleFromLegacyConfig(channelNumber, legacySchedule, merged);

  if (!schedule) {
    schedule = isInitialized ? channel.schedule : initializeChannelSchedule(channelNumber, merged);
  }

  const uploadedCount = (history.uploaded || []).filter((item) => item.channel === channelNumber).length;
  schedule = ensureChannelScheduleCapacity(channelNumber, uploadedCount, merged);

  return {
    schedule,
    uploadedCount,
    batchSlots: (batchSize) => getChannelBatchSlots(channelNumber, uploadedCount, batchSize),
  };
}

// =============================================================================
// ФЕРМА
// =============================================================================

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getHistoryPaths(profileId) {
  return {
    historyFile: path.join(baseDir, `history_profile_${profileId}.json`),
    lockFile: path.join(baseDir, `history_profile_${profileId}.lock`),
  };
}

function loadHistoryUnsafe(historyFile) {
  if (!fs.existsSync(historyFile)) return { uploaded: [] };
  try { return JSON.parse(fs.readFileSync(historyFile, 'utf-8')); }
  catch (e) { return { uploaded: [] }; }
}

function loadHistory(profileId) {
  const { historyFile, lockFile } = getHistoryPaths(profileId);
  return withFileLock(lockFile, 'history.lock', () => loadHistoryUnsafe(historyFile));
}

function saveToHistory(profileId, file, title, channelNum, scheduledTime) {
  const { historyFile, lockFile } = getHistoryPaths(profileId);
  withFileLock(lockFile, 'history.lock', () => {
    const history = loadHistoryUnsafe(historyFile);
    history.uploaded.push({
      file,
      title,
      channel: channelNum,
      scheduledFor: scheduledTime,
      date: new Date().toLocaleString(),
    });
    atomicWriteJson(historyFile, history);
  });
}

export async function runFarm(slot, profileId) {
  const CURRENT_SLOT = slot;
  const directProfileId = profileId;
  console.log(`[Farm] Анти-детект: паузы 2–10с→1с, >10с→макс 5с (обновлённый main.mjs)`);
  let finalVideosDir = CONFIG.VIDEOS_DIR;
  if (!path.isAbsolute(finalVideosDir)) {
    finalVideosDir = path.join(baseDir, finalVideosDir);
  }
  if (!fs.existsSync(finalVideosDir) && finalVideosDir.includes('yt-farm\\yt-farm')) {
    finalVideosDir = finalVideosDir.replace('yt-farm\\yt-farm', 'yt-farm');
  }

  if (!fs.existsSync(finalVideosDir)) {
    console.error(`❌ Папка с video не найдена по пути: ${finalVideosDir}`);
    return;
  }

  const channelData = CONFIG.PROFILE_MAPPING?.[directProfileId];

  if (!channelData || !channelData[0]) {
    console.error(`\n❌ [ОШИБКА] Профиль Dolphin ID: ${directProfileId} не привязан ни к одному каналу в конфиге! Пропускаю этот поток.`);

    console.log(JSON.stringify({
      DATA_TYPE: "STATS_UPDATE",
      channelNum: "???",
      profileId: directProfileId,
      subs: "Ошибка",
      views: "Ошибка",
      uploaded: 0,
      status: "ОШИБКА КОНФИГУРАЦИИ"
    }));

    return;
  }

  const channelNumber = channelData[0];

  console.log(`\n📺 ================= ОБРАБОТКА КАНАЛА №${channelNumber} =================`);

  const allTitles = CONFIG.BASE_TITLES || [];
  const history = loadHistory(directProfileId);
  let availableVideos = [];

  const { discovered } = { discovered: syncChannelsFromMapping(CONFIG.PROFILE_MAPPING) };
  const isNewChannel = discovered.new.some((c) => c.channelNumber === channelNumber);

  const schedulePrep = prepareChannelSchedule(
    channelNumber,
    directProfileId,
    history,
    SCHEDULE_SETTINGS,
    CONFIG.SCHEDULE
  );

  if (isNewChannel) {
    console.log(`🆕 Канал №${channelNumber} — первый запуск, расписание с завтра 07:00`);
  } else {
    const remaining = schedulePrep.schedule.length - schedulePrep.uploadedCount;
    console.log(`📋 Канал №${channelNumber} — известный, свободных слотов: ${remaining}, всего в графике: ${schedulePrep.schedule.length}`);
  }

  const startVideoNum = (channelNumber - 1) * VIDEOS_PER_CHANNEL + 1;

  for (let i = 0; i < VIDEOS_PER_CHANNEL; i++) {
    const currentVideoIndex = startVideoNum + i;
    const filename = `part${currentVideoIndex}.mov`;
    const title = allTitles[Math.floor(Math.random() * allTitles.length)] || `Shorts Video ${currentVideoIndex}`;
    const alreadyUploaded = history.uploaded.some(item => item.file === filename);
    if (!alreadyUploaded) {
      availableVideos.push({ file: filename, title: title, channel: channelNumber });
    }
  }

  if (availableVideos.length === 0) {
    console.log(`✅ Все ${VIDEOS_PER_CHANNEL} видео для Канала №${channelNumber} уже были опубликованы ранее!`);
    console.log(JSON.stringify({
      DATA_TYPE: "STATS_UPDATE", channelNum: channelNumber, profileId: directProfileId,
      subs: "Готово", views: "100%", uploaded: VIDEOS_PER_CHANNEL, status: "АКТИВЕН"
    }));
    return;
  }

  shuffle(availableVideos);
  const currentBatch = availableVideos.slice(0, BATCH_SIZE);
  console.log(`🎯 Слот ${CURRENT_SLOT} собрал пачку из ${currentBatch.length} видео для этого пакетного захода.`);

  const batchTimeSlots = schedulePrep.batchSlots(currentBatch.length);
  if (batchTimeSlots.length < currentBatch.length) {
    console.error(`❌ Не хватает тайм-слотов в расписании канала №${channelNumber} (нужно ${currentBatch.length}, есть ${batchTimeSlots.length})`);
    return;
  }

  let browser = null;
  let context = null;

  console.log(`🔄 Слот ${CURRENT_SLOT} открывает профиль Dolphin ОДИН раз для всей пачки: ${directProfileId}...`);
  try {
    const response = await axios.get(`${CONFIG.DOLPHIN_API_URL}/v1.0/browser_profiles/${directProfileId}/start?automation=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.DOLPHIN_TOKEN}` }
    });

    if (response.data && response.data.automation) {
      const { port, wsEndpoint } = response.data.automation;
      if (!port || !wsEndpoint) throw new Error("Dolphin не отдал порт или wsEndpoint.");
      const fullWsUrl = wsEndpoint.startsWith('ws://') ? wsEndpoint : `ws://127.0.0.1:${port}${wsEndpoint}`;
      browser = await chromium.connectOverCDP(fullWsUrl);
      context = browser.contexts()[0];
    } else { throw new Error("Dolphin не вернул блок автоматизации."); }
  } catch (err) {
    console.error(`❌ Слот ${CURRENT_SLOT} не смог подключиться к Dolphin:`, err.message);
    return;
  }

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(60000);

  let isBanned = false; let browserClosed = false;
  let totalUploadedInSession = 0;

  for (let i = 0; i < currentBatch.length; i++) {
    const videoToUpload = currentBatch[i];
    const videoTimeSlot = batchTimeSlots[i];

    if (!videoTimeSlot) {
      console.log(`⚠️ Предупреждение: в расписании канала №${channelNumber} закончились тайм-слоты на шаге ${i + 1}. Остаток пачки пропускается.`);
      break;
    }

    console.log(`\n🎬 [Видео ${i + 1}/${currentBatch.length}] Начинаю процесс для: ${videoToUpload.file}`);
    console.log(`📅 Целевой тайм-слот публикации: ${videoTimeSlot}`);

    let attempts = 3;
    let success = false;

    while (attempts > 0 && !success) {
      try {
        await uploadVideo(page, videoToUpload, finalVideosDir, videoTimeSlot);

        success = true;
        totalUploadedInSession++;
        saveToHistory(directProfileId, videoToUpload.file, videoToUpload.title, channelNumber, videoTimeSlot);
        console.log(`💾 Успешно запланировано! Файл ${videoToUpload.file} закреплен за временем ${videoTimeSlot}`);
      } catch (error) {
        if (error.message === 'BAN_DETECTED') { isBanned = true; break; }
        if (error.message.includes('closed') || error.message.includes('browser has been closed')) { browserClosed = true; break; }

        attempts--;
        console.error(`⚠️ Ошибка загрузки файла ${videoToUpload.file}. Попыток осталось: ${attempts}. Ошибка: ${error.message}`);
        if (attempts > 0 && !browserClosed) {
          await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
          await new Promise(r => setTimeout(r, capDelay(5000)));
        }
      }
    }

    if (isBanned || browserClosed) {
      console.log(`🛑 Пакетный цикл экстренно прерван из-за критического статуса сессии.`);
      break;
    }

    if (!success) {
      console.log(`🔴 Файл ${videoToUpload.file} не удалось выложить за 3 попытки. Защита от сдвигов: прерываем сессию, сохраняя время ${videoTimeSlot} для следующего перезапуска.`);
      break;
    }

    if (i < currentBatch.length - 1 && !isBanned && !browserClosed) {
      await pauseBetweenUploads();
    }
  }

  let finalChannelStatus = "АКТИВЕН";
  if (isBanned) finalChannelStatus = "BAN_DETECTED";
  if (browserClosed) finalChannelStatus = "ВЫЛЕТ БРАУЗЕРА";

  let subscribersCount = "0"; let viewsCount = "0";
  if (!isBanned && !browserClosed) {
    console.log(`\n📊 [КАНАЛ №${channelNumber}] Захожу на главную https://studio.youtube.com/ для финального сбора статистики...`);
    try {
      await page.goto('https://studio.youtube.com/', { waitUntil: 'networkidle' }).catch(() => {});
      await new Promise(r => setTimeout(r, capDelay(6000)));

      const dashboardText = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('*'));
        for (const card of cards) {
          if (card.innerText && card.innerText.includes('Аналитика по каналу') && card.innerText.includes('Подписчики') && card.innerText.length < 1500) {
            return card.innerText;
          }
        }
        return document.body ? document.body.innerText : '';
      });

      if (dashboardText) {
        const lines = dashboardText.split('\n').map(l => l.trim()).filter(Boolean);
        const subIdx = lines.findIndex(l => l.toLowerCase().includes('подписчики'));
        if (subIdx !== -1 && lines[subIdx + 1]) {
          subscribersCount = lines[subIdx + 1].replace(/[^\d.KkМмMmsS  ]/g, '').trim();
        }
        const viewsIdx = lines.findIndex(l => l.toLowerCase() === 'просмотры');
        if (viewsIdx !== -1 && lines[viewsIdx + 1]) {
          viewsCount = lines[viewsIdx + 1].replace(/[^\d.KkМмMmsS  ]/g, '').trim();
        }
      }

      if (!subscribersCount || subscribersCount === "0") {
        subscribersCount = await page.$eval('#subscriber-count', el => el.innerText.trim()).catch(() => "0");
        subscribersCount = subscribersCount.replace(/[^\d.KkМмMmsS]/g, '');
      }

    } catch (statError) {
      console.error(`⚠️ Не удалось считать текст дашборда:`, statError.message);
      try { if (page.url().includes('disabled') || page.url().includes('banned')) finalChannelStatus = "BAN_DETECTED"; } catch (e) { finalChannelStatus = "ВЫЛЕТ БРАУЗЕРА"; }
    }
  }

  const finalHistory = loadHistory(directProfileId);
  const currentChannelUploads = finalHistory.uploaded.filter(item => item.channel === channelNumber).length;

  console.log(JSON.stringify({
    DATA_TYPE: "STATS_UPDATE", channelNum: channelNumber, profileId: directProfileId,
    subs: browserClosed ? "Ошибка" : (subscribersCount || "0"), views: browserClosed ? "Ошибка" : (viewsCount || "0"),
    uploaded: currentChannelUploads, status: finalChannelStatus
  }));

  if (!browserClosed) {
    await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  await axios.get(`${CONFIG.DOLPHIN_API_URL}/v1.0/browser_profiles/${directProfileId}/stop`, {
    headers: { 'Authorization': `Bearer ${CONFIG.DOLPHIN_TOKEN}` }
  }).catch(() => {});

  console.log(`🏁 [КАНАЛ №${channelNumber}] Сессия закрыта. Запланировано за этот круг: ${totalUploadedInSession} видео.`);
}

/** Запуск worker-процесса (для UI-панели вместо upload-farm.mjs) */
export function spawnFarmWorker(slot, profileId) {
  const mainScript = path.join(SCRIPT_DIR, 'main.mjs');
  return spawn(process.execPath, [mainScript, String(slot), profileId], {
    cwd: baseDir,
    stdio: 'inherit',
    shell: false,
  });
}

export { baseDir, CONFIG };

// Worker-режим: node main.mjs <slot> <profileId>
if (process.argv[2] && process.argv[3]) {
  const slot = parseInt(process.argv[2], 10);
  const profileId = process.argv[3];
  runFarm(slot, profileId).catch((err) => {
    console.error(`⚠️ Ошибка: ${err.message}`);
    process.exit(1);
  });
}
