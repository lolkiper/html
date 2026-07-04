import path from 'path';
import fs from 'fs';

// =============================================================================
// АНТИ-ДЕТЕКТ: человеческие паузы и движение курсора
// =============================================================================

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Минимальные паузы: >10с→1с, 2–10с→500мс, 0.5–2с→200мс */
function capDelay(ms) {
  if (ms > 10000) return 1000;
  if (ms >= 2000) return 500;
  if (ms >= 500) return 200;
  return ms;
}

function humanDelay(minMs = 80, maxMs = 200) {
  return new Promise((r) => setTimeout(r, capDelay(randomBetween(minMs, maxMs))));
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, capDelay(ms)));
}

/** Случайно 1–10: заменяет последнюю цифру минут стандартного слота (00/15/30/45). */
function computeMinuteFuzz(standardMinute) {
  const rand = randomBetween(1, 10);
  const prefix = String(standardMinute).padStart(2, '0').slice(0, -1);
  const fuzzMinute = rand === 10
    ? parseInt(prefix, 10) * 10 + 10
    : parseInt(prefix + String(rand), 10);
  return { rand, minute: Math.min(fuzzMinute, 59) };
}

function buildTimeLabels(hour, minute) {
  const time24 = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const time24Short = `${hour}:${String(minute).padStart(2, '0')}`;
  const period = hour >= 12 ? 'PM' : 'AM';
  let hour12 = hour % 12;
  if (hour12 === 0) hour12 = 12;
  const time12 = `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
  const time12Padded = `${String(hour12).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${period}`;
  // 24ч формат первым — у большинства аккаунтов Studio именно он (07:15, не 7:15 AM)
  return [...new Set([time24, time24Short, time12, time12Padded])];
}

async function humanMouseMove(page, targetX, targetY) {
  const start = await page.evaluate(() => ({
    x: window.__farmMouseX ?? (80 + Math.floor(Math.random() * 320)),
    y: window.__farmMouseY ?? (80 + Math.floor(Math.random() * 220)),
  })).catch(() => ({ x: 200, y: 200 }));

  const steps = randomBetween(10, 22);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    const x = start.x + (targetX - start.x) * ease + randomBetween(-3, 3);
    const y = start.y + (targetY - start.y) * ease + randomBetween(-3, 3);
    await page.mouse.move(x, y);
    await page.waitForTimeout(randomBetween(3, 10));
  }

  await page.evaluate(({ x, y }) => {
    window.__farmMouseX = x;
    window.__farmMouseY = y;
  }, { x: targetX, y: targetY }).catch(() => {});
}

async function humanClick(page, target, options = {}) {
  if (typeof target === 'string') {
    return humanClick(page, page.locator(target).first(), options);
  }

  // Locator
  if (target && typeof target.scrollIntoViewIfNeeded === 'function') {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await humanDelay(50, 150);

    if (typeof target.boundingBox === 'function') {
      const box = await target.boundingBox().catch(() => null);
      if (box) {
        const x = box.x + box.width * (0.28 + Math.random() * 0.44);
        const y = box.y + box.height * (0.28 + Math.random() * 0.44);
        await humanMouseMove(page, x, y);
        await page.waitForTimeout(randomBetween(20, 60));
        await page.mouse.click(x, y, { delay: randomBetween(20, 60) });
        return;
      }
    }

    await target.click({ delay: randomBetween(50, 140), force: true, ...options });
    return;
  }

  // ElementHandle (waitForSelector / page.$)
  if (target && typeof target.click === 'function') {
    if (typeof target.boundingBox === 'function') {
      const box = await target.boundingBox().catch(() => null);
      if (box) {
        const x = box.x + box.width * (0.28 + Math.random() * 0.44);
        const y = box.y + box.height * (0.28 + Math.random() * 0.44);
        await humanMouseMove(page, x, y);
        await page.waitForTimeout(randomBetween(20, 60));
        await page.mouse.click(x, y, { delay: randomBetween(20, 60) });
        return;
      }
    }
    await target.click({ delay: randomBetween(50, 140), ...options });
    return;
  }

  throw new Error('humanClick: не удалось кликнуть — неизвестный тип элемента');
}

async function humanType(page, text, delayRange = [55, 130]) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomBetween(delayRange[0], delayRange[1]) });
    if (Math.random() < 0.04) await page.waitForTimeout(randomBetween(180, 520));
  }
}

/**
 * Функция загрузки и планирования Shorts на YouTube (С чистыми CSS-селекторами)
 * @param {object} page - Объект страницы Playwright
 * @param {object} videoToUpload - Объект с данными видео { file: "...", title: "..." }
 * @param {string} videosDir - Корневая папка с видеороликами
 * @param {string|null} scheduledTime - Время планирования в формате "DD.MM.YYYY HH:MM" (если null — публикует сразу)
 */
export async function uploadVideo(page, videoToUpload, videosDir, scheduledTime = null) {
  // Высчитываем точный абсолютный путь к видеофайлу на ПК
  const absoluteVideoPath = path.isAbsolute(videoToUpload.file) 
    ? videoToUpload.file 
    : path.join(videosDir, videoToUpload.file);

  if (!fs.existsSync(absoluteVideoPath)) {
    throw new Error(`Файл не найден по пути: ${absoluteVideoPath}`);
  }

  console.log(`[Робот] Перехожу по прямой ссылке загрузки https://www.youtube.com/upload ...`);
  await page.goto('https://www.youtube.com/upload', { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Проверяем, не вылетела ли собака-ошибка интерфейса
  let checkText = await page.innerText('body').catch(() => '');
  if (checkText.toLowerCase().includes('something went wrong')) {
    console.log('⚠️ Ютуб выдал ошибку интерфейса. Перезагружаю страницу...');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, capDelay(1000)));
  }

  if (page.url().includes('disabled') || page.url().includes('banned')) {
    throw new Error('BAN_DETECTED');
  }

  console.log(`[Робот] Ожидаю появление поля выбора файла в коде страницы...`);
  try {
    await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 });
  } catch (e) {
    console.log(`⚠️ Окно загрузки не определилось автоматом. Включаю резервный кликер по кнопке "Создать"...`);
    try {
      await humanClick(page, '#create-icon, button:has-text("Создать"), button:has-text("Create"), button:has-text("Crear")');
      await humanDelay(100, 250);
      await humanClick(page, '#upload-item, ytcp-text-menu-item:has-text("Добавить видео"), ytcp-text-menu-item:has-text("Upload videos"), ytcp-text-menu-item:has-text("Subir vídeos")');
      
      await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 10000 });
    } catch (manualError) {
      throw new Error(`Ютуб не дал открыть окно загрузки ни одним из способов: ${manualError.message}`);
    }
  }

  const fileInput = await page.$('input[type="file"]');
  console.log(`[Робот] Файл обнаружен. Загружаю на server YouTube...`);
  
  try {
    await fileInput.setInputFiles(absoluteVideoPath);
  } catch (err) {
    if (err.message.includes('larger than 100Mb') || err.message.includes('transfer files')) {
      console.log(`⚠️ Файл тяжелее 100МБ. Включаю экстренный обход через CDP-сессию Chromium...`);
      const cdpSession = await page.context().newCDPSession(page);
      // ФИКС: Runtime.evaluate возвращает { result: { objectId, ... }, exceptionDetails? } —
      // ключа "object" в ответе нет вообще. Из-за этого деструктуризация "{ object }"
      // всегда давала undefined, а следующая строка падала на "object.objectId"
      // с точно такой же ошибкой, как в логе: "Cannot read properties of
      // undefined (reading 'objectId')".
      const { result } = await cdpSession.send('Runtime.evaluate', {
        expression: 'document.querySelector(\'input[type="file"]\')'
      });
      if (!result || !result.objectId) {
        throw new Error('CDP Runtime.evaluate не нашёл input[type="file"] на странице (result.objectId отсутствует).');
      }
      const { node } = await cdpSession.send('DOM.describeNode', { objectId: result.objectId });
      await cdpSession.send('DOM.setFileInputFiles', {
        files: [absoluteVideoPath],
        backendNodeId: node.backendNodeId
      });
      console.log(`✅ Тяжелый файл успешно передан напрямую через CDP!`);
    } else {
      throw err;
    }
  }

  console.log(`[Робот] Ожидаю загрузку модального окна и ищу поле заголовка...`);
  
  const titleSelectors = [
    '#textbox[local-id="title-textbox"]',
    '#title-textarea #textbox',
    'ytcp-video-title #textbox',
    'ytcp-social-suggestions-textbox div#textbox',
    'ytcp-video-metadata-editor div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="название"]',
    'div[contenteditable="true"][aria-label*="Title"]',
    'div[contenteditable="true"][aria-label*="Título"]'
  ];
  let titleField = null;
  const maxWaitTitle = 40000; 
  const startTitleTime = Date.now();
  while (!titleField && (Date.now() - startTitleTime < maxWaitTitle)) {
    for (const selector of titleSelectors) {
      const element = await page.$(selector).catch(() => null);
      if (element && await element.isVisible()) {
        titleField = element;
        console.log(`[Робот] Поле ввода названия найдено через: ${selector}`);
        break;
      }
    }
    if (!titleField) {
      await new Promise(r => setTimeout(r, capDelay(1000)));
    }
  }

  if (!titleField) {
    throw new Error('Не удалось найти поле ввода названия видео.');
  }
  await humanDelay(100, 250);

  await titleField.focus();
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await humanType(page, videoToUpload.title);
  console.log(`[Робот] Перехожу к пошаговому прохождению вкладок...`);
  
  for (let i = 0; i < 3; i++) {
    if (i === 0) {
      console.log("🔍 Ищем настройку 'Возрастные ограничения (Не для детей)'...");
      
      const kidsRadio = page.locator([
        'tp-yt-paper-radio-button[name="NOT_MADE_FOR_KIDS"]',
        '#not-made-for-kids-radio-button',
        '#not-made-for-kids',
        'tp-yt-paper-radio-button:has-text("No,")',
        'tp-yt-paper-radio-button:has-text("Нет,")',
        '[role="radio"]:has-text("No,")'
      ].join(', ')).first();

      let kidsSelected = false;

      try {
        await kidsRadio.waitFor({ state: 'visible', timeout: 10000 });
        await kidsRadio.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(capDelay(200));

        // ФИКС: обычный click() у tp-yt-paper-radio-button часто виснет в
        // Timeout, а не падает с "элемент не найден" — Playwright ждёт,
        // что элемент гарантированно получит клик, но поверх радио-кнопки
        // лежит слой material-ripple, который перехватывает pointer-события
        // и никогда не "стабилизируется". force: true отключает эту проверку
        // и кликает напрямую по центру элемента.
        await kidsRadio.click({ force: true, timeout: 8000 }).catch(() => humanClick(page, kidsRadio));
        console.log("✅ Успешно отмечено: 'Нет, это видео не для детей'");
        await page.waitForTimeout(capDelay(200));
        kidsSelected = true;
      } catch (kidsErr) {
        console.log(`⚠️ Предупреждение: Кнопка "Не для детей" не поддалась (${kidsErr.message}), пробуем текст...`);

        const backupTextClick = page.locator([
          'text="No, it\'s not made for kids"',
          'text="Нет, это видео не для детей"',
          'text="No, no es contenido creado para niños"'
        ].join(', ')).first();

        try {
          await backupTextClick.scrollIntoViewIfNeeded().catch(() => {});
          // ФИКС: тот же force: true — та же причина зависания на клике
          await backupTextClick.click({ force: true, timeout: 8000 }).catch(() => humanClick(page, backupTextClick));
          console.log("✅ Сработал запасной клик по тексту 'Не для детей'");
          await page.waitForTimeout(capDelay(200));
          kidsSelected = true;
        } catch (err) {
          console.log(`⚠️ Резервный текстовый клик тоже не сработал (${err.message}). Пробую прямой клик через JS...`);
        }
      }

      // ФИКС: последний резерв — обходим Playwright-actionability целиком и
      // кликаем по нативному DOM-элементу через page.evaluate. Это надёжно
      // "прошибает" ripple-перехватчики, потому что не проверяет, что именно
      // находится в точке клика на экране, а просто вызывает .click()
      // на найденном элементе/его внутреннем input.
      if (!kidsSelected) {
        kidsSelected = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll(
            'tp-yt-paper-radio-button[name="NOT_MADE_FOR_KIDS"], #not-made-for-kids-radio-button, #not-made-for-kids, [role="radio"]'
          )).filter(el => {
            const t = (el.innerText || el.textContent || '').trim();
            return t.startsWith('No,') || t.startsWith('Нет,') || el.id.includes('not-made-for-kids') || el.getAttribute('name') === 'NOT_MADE_FOR_KIDS';
          });
          const target = candidates[0];
          if (!target) return false;
          const inner = target.shadowRoot ? target.shadowRoot.querySelector('input, #radioContainer, .radioContainer') : null;
          (inner || target).click();
          return true;
        }).catch(() => false);

        if (kidsSelected) {
          console.log("✅ Аудитория выбрана прямым JS-кликом (обход Playwright actionability)");
          await page.waitForTimeout(capDelay(200));
        } else {
          console.log(`❌ Не удалось выбрать аудиторию ни одним из трёх способов. Пробую идти дальше...`);
        }
      }
    }
    
    await page.waitForSelector('#next-button', { timeout: 15000 });
    await humanClick(page, '#next-button');
    await humanDelay(100, 250);
  }

  await page.waitForTimeout(capDelay(300));

  // =========================================================================
  // 🔥 НАЧАЛО ШАГА №4: ЗАЩИЩЕННОЕ ПЛАНИРОВАНИЕ (ФИКС ПО РЕКОМЕНДАЦИЯМ)
  // =========================================================================
  if (scheduledTime) {
    console.log(`[Робот] Включен режим отложенной публикации. Парсим тайм-слот: ${scheduledTime}`);
    
    const [datePart, timePartRaw] = scheduledTime.split(' ');
    const [day, month, year] = datePart.split('.');

    const [rawH] = timePartRaw.split(':').map(Number);
    const targetH = rawH;
    const standardLabels = buildTimeLabels(targetH, 0);

    function parseHourFromField(value) {
      const norm = (value || '').replace(/\u202f/g, ' ').trim();
      let m = norm.match(/^(\d{1,2}):(\d{2})$/);
      if (m) return parseInt(m[1], 10);
      m = norm.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (m) {
        let h = parseInt(m[1], 10);
        const p = m[3].toUpperCase();
        if (p === 'PM' && h !== 12) h += 12;
        if (p === 'AM' && h === 12) h = 0;
        return h;
      }
      return null;
    }

    async function verifyFieldHour(timeInput, expectedH) {
      const val = await timeInput.inputValue().catch(() => '');
      const h = parseHourFromField(val);
      return h === expectedH;
    }

    // Клик :00 в списке → backspace последней цифры → вписать rand 1–10
    async function applyMinuteFuzz(timeInput) {
      const fieldBefore = await timeInput.inputValue().catch(() => '');
      if (!(await verifyFieldHour(timeInput, targetH))) {
        throw new Error(`Перед fuzz в поле "${fieldBefore}", ожидался час ${String(targetH).padStart(2, '0')}:00`);
      }

      const { rand, minute: fuzzMinute } = computeMinuteFuzz(0);
      const finalTime = `${String(targetH).padStart(2, '0')}:${String(fuzzMinute).padStart(2, '0')}`;

      await timeInput.focus();
      await humanDelay(150, 300);
      await page.keyboard.press('End');

      if (rand === 10) {
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await page.keyboard.type('10', { delay: randomBetween(40, 90) });
      } else {
        await page.keyboard.press('Backspace');
        await page.keyboard.type(String(rand), { delay: randomBetween(40, 90) });
      }

      await page.keyboard.press('Tab').catch(() => page.keyboard.press('Enter').catch(() => {}));
      console.log(`✅ Fuzz: клик ${String(targetH).padStart(2, '0')}:00 → rand ${rand} → ${finalTime}`);
      return finalTime;
    }

    async function clickStandardTimeInList(timeListbox) {
      const labelPattern = standardLabels
        .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');

      const clicked = await page.evaluate((labels) => {
        const norm = (text) => (text || '').replace(/\u202f/g, ' ').replace(/\s+/g, ' ').trim();
        const listboxes = Array.from(document.querySelectorAll('ytcp-time-of-day-picker tp-yt-paper-listbox'));
        const listbox = listboxes[listboxes.length - 1];
        if (!listbox) return { ok: false, reason: 'listbox not found' };

        const scrollEl = listbox.querySelector('iron-list #items')
          || listbox.querySelector('#items')
          || listbox.querySelector('iron-list')
          || listbox;

        const sample = listbox.querySelector('tp-yt-paper-item');
        const itemHeight = sample?.getBoundingClientRect().height || 36;

        const tryClick = () => {
          for (const item of listbox.querySelectorAll('tp-yt-paper-item')) {
            const text = norm(item.innerText || item.textContent);
            if (labels.some((label) => text === label)) {
              item.scrollIntoView({ block: 'center', behavior: 'instant' });
              item.click();
              return text;
            }
          }
          return null;
        };

        let matched = tryClick();
        if (matched) return { ok: true, matched };

        for (let top = 0; top <= (scrollEl.scrollHeight || 4000); top += itemHeight) {
          scrollEl.scrollTop = top;
          scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));
          matched = tryClick();
          if (matched) return { ok: true, matched };
        }

        const visible = Array.from(listbox.querySelectorAll('tp-yt-paper-item'))
          .slice(0, 10)
          .map((i) => norm(i.innerText || i.textContent));
        return { ok: false, reason: 'exact label not found', visible };
      }, standardLabels);

      if (clicked.ok) return clicked;

      // Playwright fallback — точное совпадение текста
      const item = timeListbox.locator('tp-yt-paper-item').filter({
        hasText: new RegExp(`^\\s*(${labelPattern})\\s*$`),
      }).first();

      if (await item.count()) {
        await item.scrollIntoViewIfNeeded().catch(() => {});
        await humanClick(page, item);
        const text = await item.innerText().catch(() => standardLabels[0]);
        return { ok: true, matched: text.trim() };
      }

      return clicked;
    }

    async function selectTimeByClick(timeInput) {
      console.log(`[Робот] Ищу в списке: ${standardLabels.join(' / ')}`);

      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await timeInput.scrollIntoViewIfNeeded().catch(() => {});
          await humanClick(page, timeInput);
          await humanDelay(400, 700);

          const timeListbox = page.locator('ytcp-time-of-day-picker tp-yt-paper-listbox').last();
          await timeListbox.waitFor({ state: 'visible', timeout: 10000 });

          const result = await clickStandardTimeInList(timeListbox);
          if (!result.ok) {
            console.log(`⚠️ Попытка ${attempt}/5: ${result.reason}${result.visible?.length ? `, видно: ${result.visible.join(', ')}` : ''}`);
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(capDelay(400));
            continue;
          }

          await humanDelay(200, 400);
          const fieldVal = await timeInput.inputValue().catch(() => '');
          if (!(await verifyFieldHour(timeInput, targetH))) {
            console.log(`⚠️ Попытка ${attempt}/5: кликнули "${result.matched}", но в поле "${fieldVal}" (нужен час ${targetH})`);
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(capDelay(400));
            continue;
          }

          console.log(`✅ Стандартный слот: ${result.matched} (поле: ${fieldVal})`);
          await applyMinuteFuzz(timeInput);
          return;
        } catch (err) {
          console.log(`⚠️ Попытка ${attempt}/5: ${err.message}`);
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(capDelay(400));
        }
      }

      await page.screenshot({ path: 'time-list-error.png', fullPage: true }).catch(() => {});
      throw new Error(`Не удалось выбрать ${standardLabels[0]} в списке. См. time-list-error.png`);
    }

    const monthsEn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthIndex = parseInt(month) - 1;
    const formattedDate = `${monthsEn[monthIndex]} ${parseInt(day)}, ${year}`;

    try {
      // === 1. РАЗВОРАЧИВАЕМ СЕКЦИЮ "SCHEDULE" ===
      // ВАЖНО: в текущей верстке YouTube Studio нет радиокнопки name="SCHEDULE".
      // "Schedule" — это отдельная сворачиваемая секция (#second-container) рядом
      // с блоком "Save or publish" (#first-container, там лежат PUBLIC/UNLISTED/PRIVATE).
      // По умолчанию секция Schedule свёрнута, и её нужно раскрыть кликом по шеврону.
      console.log(`[Робот] Разворачиваю секцию "Schedule"...`);

      const scheduleExpandButton = page.locator([
        '#second-container-expand-button',
        '#second-container ytcp-icon-button',
        'ytcp-video-visibility-select #second-container'
      ].join(', ')).first();

      await scheduleExpandButton.waitFor({ state: 'attached', timeout: 15000 });
      await scheduleExpandButton.scrollIntoViewIfNeeded().catch(() => {});
      await humanClick(page, scheduleExpandButton);
      await humanDelay(100, 250);

      const datetimePickerProbe = page.locator('ytcp-visibility-scheduler ytcp-datetime-picker').first();
      const pickerVisible = await datetimePickerProbe.isVisible({ timeout: 3000 }).catch(() => false);
      if (!pickerVisible) {
        console.log(`⚠️ Пикер даты/времени не появился после первого клика, пробую ещё раз...`);
        await page.locator('#second-container').first().click({ force: true }).catch(() => humanClick(page, '#second-container'));
        await humanDelay(100, 200);
      }

      // === 1.5 УСТАНОВКА ЧАСОВОГО ПОЯСА GMT+03:00 ===
      // Время из config.json ("07:00", "13:00"...) не содержит часовой пояс —
      // без явной установки YouTube будет интерпретировать его в том поясе,
      // что стоит в аккаунте по умолчанию. Фиксируем GMT+3 перед вводом даты/времени.
      //
      // ФИКС: разметка попапа подтверждена реальным timezone-opened.html —
      // это компонент ytcp-text-menu > tp-yt-paper-listbox#paper-list >
      // tp-yt-paper-item > yt-formatted-string.item-text с текстом вида
      // "(GMT+03:00) Moscow". Строки поиска в этом попапе НЕТ (это просто
      // прокручиваемый список) — раньше код ждал несуществующее поле поиска
      // до 3с впустую. Убрал этот шаг и сузил селекторы под точную разметку.
      console.log(`[Робот] Устанавливаю часовой пояс GMT+03:00...`);
      try {
        const tzButton = page.locator(
          '#timezone-select-button, ytcp-button[label="Time zone"], button[aria-label="Time zone"]'
        ).first();
        await tzButton.waitFor({ state: 'visible', timeout: 10000 });
        await tzButton.scrollIntoViewIfNeeded().catch(() => {});
        await humanClick(page, tzButton);
        await humanDelay(100, 200);

        // Список часовых поясов: ytcp-text-menu > tp-yt-paper-listbox#paper-list.
        // Селектор жёстко привязан к ytcp-text-menu (а не общий tp-yt-paper-listbox),
        // т.к. цикл грузит до 10 видео на одной странице подряд — попапы от
        // предыдущих видео могут оставаться в DOM скрытыми, и общий селектор
        // мог бы схватить не тот список (та же причина, что ломала выбор времени).
        const tzListbox = page.locator('ytcp-text-menu tp-yt-paper-listbox').last();
        await tzListbox.waitFor({ state: 'visible', timeout: 5000 });

        const tzOption = tzListbox
          .locator('tp-yt-paper-item')
          .filter({ hasText: /GMT\+0?3:00/ })
          .first();

        await tzOption.waitFor({ state: 'attached', timeout: 5000 });
        await tzOption.scrollIntoViewIfNeeded().catch(() => {});
        await humanClick(page, tzOption);
        console.log(`✅ Часовой пояс установлен: GMT+03:00`);

        // Ждём, пока попап реально закроется, чтобы он не мешал следующему
        // клику по календарю (гонка анимации закрытия — частая причина того,
        // что следующий клик "проваливается в пустоту").
        await tzListbox.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(capDelay(200));
      } catch (tzErr) {
        await page.screenshot({ path: 'timezone-error.png', fullPage: true }).catch(() => {});
        console.log(`⚠️ Не удалось выставить часовой пояс автоматически: ${tzErr.message}. Проверьте timezone-opened.html/timezone-error.png и пришлите мне — подберу точные селекторы. Продолжаю с текущим (возможно неверным) часовым поясом аккаунта.`);
        // Если попап всё же был открыт, но выбор не удался — закрываем его,
        // чтобы не мешать вводу даты/времени дальше.
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(capDelay(200));
      }

      // === 2. ВВОД ДАТЫ ===
      // Точная структура (подтверждена реальным HTML):
      // ytcp-visibility-scheduler > ytcp-datetime-picker
      //   #datepicker-trigger      — КНОПКА-триггер ("Jul 2, 2026"), открывает календарь-попап
      //   #time-of-day-container   — поле времени, открывает выпадающий список по клику
      const dateTrigger = page.locator('ytcp-visibility-scheduler ytcp-datetime-picker #datepicker-trigger').first();
      await dateTrigger.waitFor({ state: 'visible', timeout: 10000 });
      await dateTrigger.scrollIntoViewIfNeeded().catch(() => {});
      await humanClick(page, dateTrigger);
      await humanDelay(100, 200);

      // Пытаемся выбрать день кликом по нужной ячейке.
      // ФИКС: реальная разметка календаря — это НЕ кнопки и НЕ [role="gridcell"],
      // а <span class="calendar-day">N</span> внутри <div class="calendar-month">
      // (подтверждено calendar-opened.html). Старые селекторы (button/[role=dialog]/
      // [role=gridcell]) ничего не находили, поэтому клик по дню никогда не срабатывал
      // и дата оставалась дефолтной (см. after-schedule-expand.png == before-final-save.png,
      // они идентичны — "Jul 2, 2026, 12:00 AM").
      //
      // Так как в попапе одновременно отрендерено несколько месяцев подряд
      // (Jul/Aug/Sep...) с одинаковыми номерами дней, сначала находим контейнер
      // нужного месяца по подписи ".calendar-month-label" (например "Jul 2026"),
      // и только внутри него ищем нужный день — иначе можно случайно кликнуть
      // "2" не того месяца.
      // ФИКС: текст внутри <span class="calendar-day"> окружён переводами
      // строк и отступами ("\n                2\n              "), поэтому
      // "^2$" без "\s*" вокруг не матчился НИКОГДА (проверено в Node) — клик
      // по дню всегда проваливался, просто это маскировалось тем, что целевой
      // день почти всегда совпадал с уже выбранным по умолчанию "сегодня".
      const targetDay = String(parseInt(day));
      const targetMonthLabel = `${monthsEn[monthIndex]} ${year}`;
      let dayClicked = false;
      try {
        const monthContainer = page.locator('.calendar-month').filter({
          has: page.locator('.calendar-month-label', { hasText: targetMonthLabel })
        }).first();
        await monthContainer.waitFor({ state: 'visible', timeout: 5000 });
        await monthContainer.scrollIntoViewIfNeeded().catch(() => {});

        const dayCell = monthContainer
          .locator('span.calendar-day:not(.invisible)')
          .filter({ hasText: new RegExp(`^\\s*${targetDay}\\s*$`) })
          .first();
        await dayCell.waitFor({ state: 'visible', timeout: 5000 });
        await dayCell.scrollIntoViewIfNeeded().catch(() => {});
        await humanClick(page, dayCell);
        dayClicked = true;
      } catch (dayErr) {
        console.log(`⚠️ Не смог кликнуть день ${targetDay} месяца ${targetMonthLabel}: ${dayErr.message}`);
      }

      if (dayClicked) {
        console.log(`✅ Дата установлена: ${formattedDate} (клик по дню ${targetDay} в календаре)`);
      } else {
        console.log(`❌ Не удалось выбрать день в календаре автоматически. См. calendar-opened.html/png — по ним подберу точный селектор.`);
      }
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(capDelay(200));

      // === 3. ВЫБОР ВРЕМЕНИ (клик + прокрутка списка, 24ч и 12ч форматы) ===
      const timeInput = page.locator('ytcp-visibility-scheduler ytcp-datetime-picker #time-of-day-container input').first();
      await timeInput.waitFor({ state: 'visible', timeout: 10000 });

      await selectTimeByClick(timeInput);
      await page.keyboard.press('Escape').catch(() => {});

      console.log(`[Робот] Ожидаю валидации формы серверами YouTube...`);
      await page.waitForTimeout(capDelay(500));

    } catch (scheduleUiError) {
      // Скриншот ошибки: Если что-то упало внутри try
      await page.screenshot({ path: 'schedule-error.png', fullPage: true }).catch(() => {});
      throw new Error(`Ошибка при заполнении календаря: ${scheduleUiError.message}`);
    }

  } else {
    console.log(`[Робот] Время публикации не передано. Выбираю публичный доступ...`);
    await page.waitForSelector('[name="PUBLIC"], #public-radio-button', { timeout: 15000 });
    await humanClick(page, '[name="PUBLIC"], #public-radio-button');
  }

  // =========================================================================
  // 🔥 ФИНАЛЬНЫЙ КЛИК С ПРОВЕРКОЙ АКТИВНОСТИ КНОПКИ
  // =========================================================================
  console.log(`[Робот] Нажимаю финальную кнопку финализации...`);
  
  const finalBtnSelector = [
    'button:has-text("Schedule")',
    'button:has-text("Publish")',
    '#done-button',
    '#publish-button',
    '#save-button'
  ].join(', ');

  await page.waitForSelector(finalBtnSelector, { timeout: 15000 });
  const doneBtn = page.locator(finalBtnSelector).first();
  
  // Проверяем, активна ли кнопка
  const isDisabled = await doneBtn.getAttribute('disabled') !== null;
  if (isDisabled) {
    await page.screenshot({ path: 'disabled-button-error.png', fullPage: true }).catch(() => {});
    throw new Error('Кнопка финализации заблокирована! Скорее всего, YouTube не принял формат даты или времени.');
  }
  
  await humanClick(page, doneBtn);
  console.log(`⏳ [Робот] Кнопка нажата успешно! Мониторю прогресс загрузки...`);
  
  let isFullyUploaded = false;
  const maxUploadTimeout =100000; 
  const startTime = Date.now();
  
  while (!isFullyUploaded && (Date.now() - startTime < maxUploadTimeout)) {
    const closeButton = await page.$('#close-button, ytcp-button[label="Закрыть"], ytcp-home-button, ytcp-button[label="Close"], ytcp-button[label="Cerrar"]');
    if (closeButton && await closeButton.isVisible()) {
      console.log(`[Робот] Обнаружено окно успешного завершения! Закрываю.`);
      await humanClick(page, '#close-button, ytcp-button[label="Закрыть"], ytcp-home-button, ytcp-button[label="Close"], ytcp-button[label="Cerrar"]').catch(() => closeButton.click());
      isFullyUploaded = true;
      break;
    }
    
    const progressText = await page.evaluate(() => {
      const el = document.querySelector('ytcp-video-upload-progress, .progress-label, .status-area');
      return el ? el.innerText.trim() : '';
    });
    
    if (progressText) {
      const textLower = progressText.toLowerCase();
      console.log(`[Прогресс загрузки]: ${progressText}`);
      if (
        textLower.includes('завершена') || 
        textLower.includes('обработ') || 
        textLower.includes('проверк') || 
        textLower.includes('complete') || 
        textLower.includes('process') || 
        textLower.includes('saved') ||
        textLower.includes('guardo') ||
        textLower.includes('готово')
      ) {
        console.log(`✅ [Робот] Загрузка успешно зафиксирована на стороне YouTube!`);
        isFullyUploaded = true;
        break;
      }
    }
    await sleepMs(500);
  }
  console.log(`🚀 [Робот] Видео успешно и полностью село на сервера YouTube!`);
  await sleepMs(500);
}