import { uploadVideo } from './youtube-studio.mjs';
import { ChannelStateStore } from './schedule-manager.mjs';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const baseDir = process.cwd();
const configPath = path.join(baseDir, 'config.json');

if (!fs.existsSync(configPath)) {
  console.error(`❌ Критическая ошибка: Файл конфигурации не найден по пути: ${configPath}`);
  process.exit(1);
}

const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const CURRENT_SLOT = process.argv[2] ? parseInt(process.argv[2]) : 1; 
const directProfileId = process.argv[3];                               

const HISTORY_FILE = path.join(baseDir, `history_profile_${directProfileId}.json`);
const SCHEDULE_SETTINGS = CONFIG.SCHEDULE_SETTINGS || {};
const VIDEOS_PER_CHANNEL = SCHEDULE_SETTINGS.VIDEOS_PER_CHANNEL ?? 16;
const BATCH_SIZE = SCHEDULE_SETTINGS.BATCH_SIZE ?? 10;
const channelState = new ChannelStateStore(baseDir);

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return { uploaded: [] };
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } 
  catch (e) { return { uploaded: [] }; }
}

function saveToHistory(file, title, channelNum, scheduledTime) {
  const history = loadHistory();
  history.uploaded.push({
    file: file, 
    title: title, 
    channel: channelNum, 
    scheduledFor: scheduledTime, // Фиксируем время расписания в историю
    date: new Date().toLocaleString()
  });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

async function startFarm() {
  // 🔥 АВТОМАТИЧЕСКОЕ ИСПРАВЛЕНИЕ ДВОЙНЫХ ПУТЕЙ (Защита от ошибки "Файл не найден")
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

// 🔥 ПРОВЕРКА: Ищем канал в маппинге конфига по ID профиля Dolphin
  const channelData = CONFIG.PROFILE_MAPPING?.[directProfileId];
  
  if (!channelData || !channelData[0]) {
    console.error(`\n❌ [ОШИБКА] Профиль Dolphin ID: ${directProfileId} не привязан ни к одному каналу в config.json! Пропускаю этот поток.`);
    
    // Команда UI панели, чтобы она увидела ошибку конфигурации, а слот освободился для других каналов
    console.log(JSON.stringify({
      DATA_TYPE: "STATS_UPDATE", 
      channelNum: "???", 
      profileId: directProfileId,
      subs: "Ошибка", 
      views: "Ошибка", 
      uploaded: 0, 
      status: "ОШИБКА КОНФИГУРАЦИИ"
    }));
    
    return; // Экстренно завершаем выполнение startFarm() для этого канала. Система пойдет дальше.
  }

  // Если всё хорошо — присваиваем реальный номер канала
  const channelNumber = channelData[0];

  console.log(`\n📺 ================= ОБРАБОТКА КАНАЛА №${channelNumber} =================`);

  const allTitles = CONFIG.BASE_TITLES || [];
  const history = loadHistory();
  let availableVideos = [];

  // Синхронизируем все каналы из конфига и готовим per-channel расписание
  const { discovered } = channelState.syncFromProfileMapping(CONFIG.PROFILE_MAPPING);
  const isNewChannel = discovered.new.some((c) => c.channelNumber === channelNumber);

  const schedulePrep = channelState.prepareChannelSchedule({
    channelNumber,
    profileId: directProfileId,
    history,
    settings: SCHEDULE_SETTINGS,
    legacySchedule: CONFIG.SCHEDULE,
  });

  if (isNewChannel) {
    console.log(`🆕 Канал №${channelNumber} — первый запуск, расписание с завтра 07:00`);
  } else {
    const remaining = schedulePrep.schedule.length - schedulePrep.uploadedCount;
    console.log(`📋 Канал №${channelNumber} — известный, свободных слотов: ${remaining}, всего в графике: ${schedulePrep.schedule.length}`);
  }

  // 🔥 ДИНАМИЧЕСКИЙ РАСЧЕТ ДИАПАЗОНА НА ОСНОВЕ НОМЕРА КАНАЛА
  const startVideoNum = (channelNumber - 1) * VIDEOS_PER_CHANNEL + 1;

  // Собираем пулл видео, предназначенных конкретно для этого канала
  for (let i = 0; i < VIDEOS_PER_CHANNEL; i++) {
    const currentVideoIndex = startVideoNum + i;
    const filename = `part${currentVideoIndex}.mov`;
    
    // Берем рандомное название из твоего списка 160 строк
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

  // 1. БАТЧИНГ: Перемешиваем и отрезаем пачку
  shuffle(availableVideos);
  const currentBatch = availableVideos.slice(0, BATCH_SIZE);
  console.log(`🎯 Слот ${CURRENT_SLOT} собрал пачку из ${currentBatch.length} видео для этого пакетного захода.`);

  // Per-channel слоты: начинаем с индекса = уже загружено, не с нуля
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

  // =========================================================================
  // 🔥 2. ПАКЕТНЫЙ ЦИКЛ ЗАЛИВКИ (Один старт Dolphin — до 10 публикаций)
  // =========================================================================
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
        // Вызываем обновленную функцию из youtube-studio.mjs передавая четвертым аргументом тайм-слот
        await uploadVideo(page, videoToUpload, finalVideosDir, videoTimeSlot);
        
        success = true;
        totalUploadedInSession++;
        saveToHistory(videoToUpload.file, videoToUpload.title, channelNumber, videoTimeSlot);
        console.log(`💾 Успешно запланировано! Файл ${videoToUpload.file} закреплен за временем ${videoTimeSlot}`);
      } catch (error) {
        if (error.message === 'BAN_DETECTED') { isBanned = true; break; }
        if (error.message.includes('closed') || error.message.includes('browser has been closed')) { browserClosed = true; break; }
        
        attempts--;
        console.error(`⚠️ Ошибка загрузки файла ${videoToUpload.file}. Попыток осталось: ${attempts}. Ошибка: ${error.message}`);
        if (attempts > 0 && !browserClosed) {
          // Возвращаем страницу в корень загрузки перед повторной попыткой
          await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }

    // Защита от сдвигов таймлайна: Если поймали бан или критический вылет браузера — рубим весь пачечный цикл
    if (isBanned || browserClosed) {
      console.log(`🛑 Пакетный цикл экстренно прерван из-за критического статуса сессии.`);
      break;
    }

    // Если попытки на один файл закончились неудачей (например плохой прокси)
    if (!success) {
      console.log(`🔴 Файл ${videoToUpload.file} не удалось выложить за 3 попытки. Защита от сдвигов: прерываем сессию, сохраняя время ${videoTimeSlot} для следующего перезапуска.`);
      break;
    }
  }

  // Настройка статуса по итогам прохода пачки
  let finalChannelStatus = "АКТИВЕН";
  if (isBanned) finalChannelStatus = "BAN_DETECTED";
  if (browserClosed) finalChannelStatus = "ВЫЛЕТ БРАУЗЕРА";

  // 🔥 ОБНОВЛЕННЫЙ И НАДЕЖНЫЙ СБОР СТАТИСТИКИ С ГЛАВНОГО ДАШБОРДА (Вызывается 1 раз в конце всей сессии)
  let subscribersCount = "0"; let viewsCount = "0";
  if (!isBanned && !browserClosed) {
    console.log(`\n📊 [КАНАЛ №${channelNumber}] Захожу на главную https://studio.youtube.com/ для финального сбора статистики...`);
    try {
      await page.goto('https://studio.youtube.com/', { waitUntil: 'networkidle' }).catch(() => {});
      await new Promise(r => setTimeout(r, 6000));
      
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

  const finalHistory = loadHistory();
  const currentChannelUploads = finalHistory.uploaded.filter(item => item.channel === channelNumber).length;

  // Отправляем финальный агрегированный отчет на UI панель управления фермы
  console.log(JSON.stringify({
    DATA_TYPE: "STATS_UPDATE", channelNum: channelNumber, profileId: directProfileId,
    subs: browserClosed ? "Ошибка" : (subscribersCount || "0"), views: browserClosed ? "Ошибка" : (viewsCount || "0"),
    uploaded: currentChannelUploads, status: finalChannelStatus
  }));

  if (!browserClosed) {
    await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
  
  // Отдаем команду Dolphin на закрытие профиля
  await axios.get(`${CONFIG.DOLPHIN_API_URL}/v1.0/browser_profiles/${directProfileId}/stop`, {
    headers: { 'Authorization': `Bearer ${CONFIG.DOLPHIN_TOKEN}` }
  }).catch(() => {});
  
  console.log(`🏁 [КАНАЛ №${channelNumber}] Сессия закрыта. Запланировано за этот круг: ${totalUploadedInSession} видео.`);
}

startFarm().catch(console.error);