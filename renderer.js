'use strict';

/**
 * renderer.js — интерфейс. Доступ к файловой системе и FFmpeg только через
 * window.api (preload.js), напрямую Node в этом процессе не используется.
 */

const STORAGE_KEY = 'shorts-inserter:settings';
const MAX_LOG_ROWS = 2000;

const el = {
  chipVersion: document.getElementById('chip-version'),
  chipFfmpeg: document.getElementById('chip-ffmpeg'),

  sourceDir: document.getElementById('source-dir'),
  sourceDirNote: document.getElementById('source-dir-note'),
  shortsFile: document.getElementById('shorts-file'),
  shortsFileNote: document.getElementById('shorts-file-note'),

  useOverlay: document.getElementById('use-overlay'),
  overlayBody: document.getElementById('overlay-body'),
  overlayFile: document.getElementById('overlay-file'),
  overlayFileNote: document.getElementById('overlay-file-note'),
  overlayOpacity: document.getElementById('overlay-opacity'),
  overlayOpacityValue: document.getElementById('overlay-opacity-value'),

  useSplit: document.getElementById('use-split'),
  splitBody: document.getElementById('split-body'),
  closeupFile: document.getElementById('closeup-file'),
  closeupFileNote: document.getElementById('closeup-file-note'),
  leftShare: document.getElementById('left-share'),
  leftShareValue: document.getElementById('left-share-value'),
  feather: document.getElementById('feather'),
  featherValue: document.getElementById('feather-value'),
  leftZoom: document.getElementById('left-zoom'),
  leftZoomValue: document.getElementById('left-zoom-value'),
  leftOffset: document.getElementById('left-offset'),
  leftOffsetValue: document.getElementById('left-offset-value'),
  rightZoom: document.getElementById('right-zoom'),
  rightZoomValue: document.getElementById('right-zoom-value'),
  rightOffset: document.getElementById('right-offset'),
  rightOffsetValue: document.getElementById('right-offset-value'),
  splitPreviewLeft: document.getElementById('split-preview-left'),
  splitPreviewSeam: document.getElementById('split-preview-seam'),
  splitHint: document.getElementById('split-hint'),

  outputDir: document.getElementById('output-dir'),
  percent: document.getElementById('percent'),
  percentRange: document.getElementById('percent-range'),
  encoder: document.getElementById('encoder'),
  verbose: document.getElementById('verbose'),

  schemeHead: document.getElementById('scheme-head'),
  schemeTail: document.getElementById('scheme-tail'),
  schemeOverlay: document.getElementById('scheme-overlay'),

  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  openOutput: document.getElementById('open-output'),

  badgeState: document.getElementById('badge-state'),
  status: document.getElementById('status'),
  fileBar: document.getElementById('file-bar'),
  filePercent: document.getElementById('file-percent'),
  overallBar: document.getElementById('overall-bar'),
  overallPercent: document.getElementById('overall-percent'),
  counterDone: document.getElementById('counter-done'),
  counterFailed: document.getElementById('counter-failed'),
  counterTotal: document.getElementById('counter-total'),

  log: document.getElementById('log'),
  copyLog: document.getElementById('copy-log'),
  clearLog: document.getElementById('clear-log')
};

const state = {
  running: false,
  logLines: []
};

const CLOSEUP_HINT = 'Короткое видео зациклится, длинное — обрежется. Звук берётся из основного ролика.';
const OVERLAY_HINT = 'Короткий оверлей зациклится, длинный — обрежется по длине результата.';

// ------------------------------------------------------------------ Утилиты

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function baseName(filePath) {
  if (!filePath) return '';
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function timeLabel(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  return date.toLocaleTimeString('ru-RU', { hour12: false });
}

// ---------------------------------------------------------------------- Лог

function appendLog(level, message) {
  const time = timeLabel();
  state.logLines.push(`[${time}] ${message}`);

  const emptyHint = el.log.querySelector('.log__empty');
  if (emptyHint) emptyHint.remove();

  const atBottom = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 60;

  const row = document.createElement('div');
  row.className = `log__row log__row--${level || 'info'}`;

  const timeNode = document.createElement('span');
  timeNode.className = 'log__time';
  timeNode.textContent = time;

  const textNode = document.createElement('span');
  textNode.className = 'log__text';
  textNode.textContent = message;

  row.append(timeNode, textNode);
  el.log.appendChild(row);

  while (el.log.childElementCount > MAX_LOG_ROWS) {
    el.log.removeChild(el.log.firstElementChild);
  }
  if (state.logLines.length > MAX_LOG_ROWS) {
    state.logLines.splice(0, state.logLines.length - MAX_LOG_ROWS);
  }

  if (atBottom) el.log.scrollTop = el.log.scrollHeight;
}

function clearLog() {
  state.logLines = [];
  el.log.innerHTML = '';
  const hint = document.createElement('div');
  hint.className = 'log__empty';
  hint.textContent = 'Лог пуст.';
  el.log.appendChild(hint);
}

// ------------------------------------------------------------- Состояние UI

function setBadge(text, modifier) {
  el.badgeState.textContent = text;
  el.badgeState.className = `badge${modifier ? ` badge--${modifier}` : ''}`;
}

function setProgress(filePercent, overallPercent) {
  const file = clamp(Number(filePercent) || 0, 0, 100);
  const overall = clamp(Number(overallPercent) || 0, 0, 100);
  el.fileBar.style.width = `${file}%`;
  el.overallBar.style.width = `${overall}%`;
  el.filePercent.textContent = `${file.toFixed(0)}%`;
  el.overallPercent.textContent = `${overall.toFixed(0)}%`;
}

function setRunning(running) {
  state.running = running;
  el.start.disabled = running;
  el.stop.disabled = !running;
  el.start.textContent = running ? 'Обработка…' : 'Начать обработку';

  const lockable = [
    el.sourceDir, el.shortsFile, el.overlayFile, el.outputDir,
    el.percent, el.percentRange, el.encoder, el.useOverlay,
    el.overlayOpacity, el.verbose,
    el.useSplit, el.closeupFile, el.leftShare, el.feather,
    el.leftZoom, el.leftOffset, el.rightZoom, el.rightOffset
  ];
  lockable.forEach((node) => {
    node.disabled = running;
  });
  document.querySelectorAll('[data-pick]').forEach((button) => {
    button.disabled = running;
  });
}

function updateOverlayState() {
  const enabled = el.useOverlay.checked;
  el.overlayBody.dataset.disabled = String(!enabled);
  el.schemeOverlay.dataset.off = String(!enabled);
}

function signedPercent(value) {
  const number = Number(value);
  if (number === 0) return '0%';
  return `${number > 0 ? '+' : '−'}${Math.abs(number)}%`;
}

function updateSplitState() {
  el.splitBody.dataset.disabled = String(!el.useSplit.checked);
}

/** Подписи ползунков и мини-схема раскладки. */
function updateSplitControls() {
  const share = Number(el.leftShare.value);
  const feather = Number(el.feather.value);
  const leftOffset = Number(el.leftOffset.value);

  el.leftShareValue.textContent = `${share}%`;
  el.featherValue.textContent = feather ? `${feather} px` : 'чёткая';
  el.leftZoomValue.textContent = `${Number(el.leftZoom.value).toFixed(2)}×`;
  el.rightZoomValue.textContent = `${Number(el.rightZoom.value).toFixed(2)}×`;
  el.leftOffsetValue.textContent = signedPercent(leftOffset);
  el.rightOffsetValue.textContent = signedPercent(el.rightOffset.value);

  el.splitPreviewLeft.style.flexBasis = `${share}%`;
  el.splitPreviewSeam.style.flexBasis = `${Math.max(2, feather / 3)}px`;

  const pixels = Math.round((1920 * leftOffset) / 100);
  el.splitHint.textContent =
    `Сдвиг задан в процентах от ширины кадра: ${signedPercent(leftOffset)} это ` +
    `${pixels} px при ширине 1920.`;
}

function updateScheme() {
  const percent = clamp(Number(el.percent.value) || 90, 50, 99);
  // Shorts на схеме занимает фиксированную долю, остальное делится по проценту.
  const shortsShare = 22;
  const headShare = ((100 - shortsShare) * percent) / 100;
  el.schemeHead.style.flexBasis = `${headShare}%`;
  el.schemeHead.textContent = `Исходник ${percent}%`;
  el.schemeTail.textContent = `${100 - percent}%`;
}

// ------------------------------------------------------------- Сохранение

function collectSettings() {
  return {
    sourceDir: el.sourceDir.value.trim(),
    shortsFile: el.shortsFile.value.trim(),
    useOverlay: el.useOverlay.checked,
    overlayFile: el.overlayFile.value.trim(),
    overlayOpacity: Number(el.overlayOpacity.value),
    useSplit: el.useSplit.checked,
    closeupFile: el.closeupFile.value.trim(),
    split: {
      leftShare: Number(el.leftShare.value),
      feather: Number(el.feather.value),
      leftZoom: Number(el.leftZoom.value),
      leftOffset: Number(el.leftOffset.value),
      rightZoom: Number(el.rightZoom.value),
      rightOffset: Number(el.rightOffset.value)
    },
    outputDir: el.outputDir.value.trim(),
    percent: clamp(Number(el.percent.value) || 90, 50, 99),
    encoder: el.encoder.value,
    verbose: el.verbose.checked
  };
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectSettings()));
  } catch (err) {
    /* приватный режим / нет доступа к storage — не критично */
  }
}

function restoreSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch (err) {
    saved = null;
  }
  if (!saved) return;

  el.sourceDir.value = saved.sourceDir || '';
  el.shortsFile.value = saved.shortsFile || '';
  el.overlayFile.value = saved.overlayFile || '';
  el.closeupFile.value = saved.closeupFile || '';
  el.outputDir.value = saved.outputDir || '';
  el.useOverlay.checked = Boolean(saved.useOverlay);
  el.useSplit.checked = Boolean(saved.useSplit);
  el.verbose.checked = Boolean(saved.verbose);

  const split = saved.split || {};
  const restoreRange = (node, value) => {
    if (Number.isFinite(Number(value))) node.value = value;
  };
  restoreRange(el.leftShare, split.leftShare);
  restoreRange(el.feather, split.feather);
  restoreRange(el.leftZoom, split.leftZoom);
  restoreRange(el.leftOffset, split.leftOffset);
  restoreRange(el.rightZoom, split.rightZoom);
  restoreRange(el.rightOffset, split.rightOffset);

  if (Number.isFinite(saved.percent)) {
    el.percent.value = clamp(saved.percent, 50, 99);
    el.percentRange.value = el.percent.value;
  }
  if (Number.isFinite(saved.overlayOpacity)) {
    el.overlayOpacity.value = clamp(saved.overlayOpacity, 5, 100);
    el.overlayOpacityValue.textContent = `${el.overlayOpacity.value}%`;
  }
  if (saved.encoder) el.encoder.value = saved.encoder;
}

// ------------------------------------------------------- Проверка выбранного

async function refreshSourceInfo() {
  const directory = el.sourceDir.value.trim();
  if (!directory) {
    el.sourceDirNote.textContent = 'Выберите папку — покажем количество найденных видео.';
    el.sourceDirNote.className = 'field__note';
    return;
  }

  const result = await window.api.scanSources({
    directory,
    outputDir: el.outputDir.value.trim()
  });

  if (result.error) {
    el.sourceDirNote.textContent = result.error;
    el.sourceDirNote.className = 'field__note field__note--error';
    return;
  }

  if (!result.count) {
    el.sourceDirNote.textContent = 'В папке нет видеофайлов.';
    el.sourceDirNote.className = 'field__note field__note--error';
    return;
  }

  const preview = result.files.slice(0, 3).join(', ');
  const more = result.count > 3 ? ` и ещё ${result.count - 3}` : '';
  el.sourceDirNote.textContent = `Найдено видео: ${result.count} — ${preview}${more}`;
  el.sourceDirNote.className = 'field__note field__note--ok';
}

async function refreshMediaInfo(inputNode, noteNode, fallbackText) {
  const file = inputNode.value.trim();
  if (!file) {
    noteNode.textContent = fallbackText;
    noteNode.className = 'field__note';
    return;
  }

  const info = await window.api.describeMedia(file);
  if (!info.ok) {
    noteNode.textContent = info.error;
    noteNode.className = 'field__note field__note--error';
    return;
  }

  noteNode.textContent =
    `${baseName(file)} — ${info.width}×${info.height}, ${info.durationText}, ` +
    `${info.fps} fps${info.hasAudio ? '' : ', без звука'}`;
  noteNode.className = 'field__note field__note--ok';
}

function refreshAllInfo() {
  refreshSourceInfo();
  refreshMediaInfo(el.shortsFile, el.shortsFileNote, 'Один видеофайл любого формата.');
  if (el.useOverlay.checked) {
    refreshMediaInfo(el.overlayFile, el.overlayFileNote, OVERLAY_HINT);
  }
  if (el.useSplit.checked) {
    refreshMediaInfo(el.closeupFile, el.closeupFileNote, CLOSEUP_HINT);
  }
}

// ------------------------------------------------------------------ События

const PICKERS = {
  'source-dir': async () => window.api.pickDirectory({
    title: 'Папка с исходными видео',
    defaultPath: el.sourceDir.value.trim()
  }),
  'output-dir': async () => window.api.pickDirectory({
    title: 'Папка для сохранения результата',
    defaultPath: el.outputDir.value.trim()
  }),
  'shorts-file': async () => window.api.pickVideo({
    title: 'Выберите файл Shorts',
    defaultPath: el.shortsFile.value.trim()
  }),
  'overlay-file': async () => window.api.pickVideo({
    title: 'Выберите видео-оверлей',
    defaultPath: el.overlayFile.value.trim()
  }),
  'closeup-file': async () => window.api.pickVideo({
    title: 'Выберите видео для правой половины',
    defaultPath: el.closeupFile.value.trim()
  })
};

document.querySelectorAll('[data-pick]').forEach((button) => {
  button.addEventListener('click', async () => {
    const key = button.dataset.pick;
    const picked = await PICKERS[key]();
    if (!picked) return;

    document.getElementById(key).value = picked;
    saveSettings();

    if (key === 'source-dir' || key === 'output-dir') {
      refreshSourceInfo();
      el.openOutput.disabled = !el.outputDir.value.trim();
    }
    if (key === 'shorts-file') {
      refreshMediaInfo(el.shortsFile, el.shortsFileNote, 'Один видеофайл любого формата.');
    }
    if (key === 'overlay-file') {
      refreshMediaInfo(el.overlayFile, el.overlayFileNote, OVERLAY_HINT);
    }
    if (key === 'closeup-file') {
      refreshMediaInfo(el.closeupFile, el.closeupFileNote, CLOSEUP_HINT);
    }
  });
});

['source-dir', 'output-dir', 'shorts-file', 'overlay-file', 'closeup-file'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    saveSettings();
    refreshAllInfo();
    el.openOutput.disabled = !el.outputDir.value.trim();
  });
});

el.useOverlay.addEventListener('change', () => {
  updateOverlayState();
  saveSettings();
  if (el.useOverlay.checked) {
    refreshMediaInfo(el.overlayFile, el.overlayFileNote, OVERLAY_HINT);
  }
});

el.useSplit.addEventListener('change', () => {
  updateSplitState();
  saveSettings();
  if (el.useSplit.checked) {
    refreshMediaInfo(el.closeupFile, el.closeupFileNote, CLOSEUP_HINT);
  }
});

[el.leftShare, el.feather, el.leftZoom, el.leftOffset, el.rightZoom, el.rightOffset].forEach((node) => {
  node.addEventListener('input', updateSplitControls);
  node.addEventListener('change', saveSettings);
});

el.overlayOpacity.addEventListener('input', () => {
  el.overlayOpacityValue.textContent = `${el.overlayOpacity.value}%`;
  saveSettings();
});

el.percent.addEventListener('input', () => {
  const value = clamp(Number(el.percent.value) || 90, 50, 99);
  el.percentRange.value = value;
  updateScheme();
});

el.percent.addEventListener('change', () => {
  el.percent.value = clamp(Number(el.percent.value) || 90, 50, 99);
  el.percentRange.value = el.percent.value;
  updateScheme();
  saveSettings();
});

el.percentRange.addEventListener('input', () => {
  el.percent.value = el.percentRange.value;
  updateScheme();
});

el.percentRange.addEventListener('change', saveSettings);
el.encoder.addEventListener('change', saveSettings);
el.verbose.addEventListener('change', saveSettings);

el.clearLog.addEventListener('click', clearLog);

el.copyLog.addEventListener('click', async () => {
  if (!state.logLines.length) return;
  try {
    await navigator.clipboard.writeText(state.logLines.join('\n'));
    appendLog('info', 'Лог скопирован в буфер обмена.');
  } catch (err) {
    appendLog('error', `Не удалось скопировать лог: ${err.message}`);
  }
});

el.openOutput.addEventListener('click', async () => {
  const target = el.outputDir.value.trim();
  if (!target) return;
  const result = await window.api.openPath(target);
  if (!result.ok) appendLog('error', `Не удалось открыть папку: ${result.error}`);
});

el.stop.addEventListener('click', async () => {
  el.stop.disabled = true;
  el.status.textContent = 'Останавливаем обработку…';
  const result = await window.api.stopProcessing();
  if (!result.ok) appendLog('warn', result.error);
});

el.start.addEventListener('click', async () => {
  if (state.running) return;

  const settings = collectSettings();
  const problems = [];
  if (!settings.sourceDir) problems.push('Не выбрана папка с исходными видео.');
  if (!settings.shortsFile) problems.push('Не выбран файл Shorts.');
  if (!settings.outputDir) problems.push('Не выбрана папка для сохранения.');
  if (settings.useOverlay && !settings.overlayFile) problems.push('Включён оверлей, но файл не выбран.');
  if (settings.useSplit && !settings.closeupFile) {
    problems.push('Включён сплит-скрин, но видео для правой половины не выбрано.');
  }
  if (problems.length) {
    problems.forEach((message) => appendLog('error', message));
    setBadge('Ошибка', 'error');
    el.status.textContent = problems[0];
    return;
  }

  saveSettings();
  setRunning(true);
  setBadge('Обработка', 'running');
  setProgress(0, 0);
  el.counterDone.textContent = '0';
  el.counterFailed.textContent = '0';
  el.counterTotal.textContent = '0';
  el.status.textContent = 'Готовим очередь…';
  appendLog('info', '— Запуск обработки —');

  await window.api.startProcessing(settings);
});

// ---------------------------------------------------------- Подписки на main

window.api.onLog(({ level, message }) => appendLog(level, message));

window.api.onProgress((progress) => {
  setProgress(progress.filePercent, progress.overallPercent);
  if (progress.status) el.status.textContent = progress.status;
  if (Number.isFinite(progress.total)) el.counterTotal.textContent = String(progress.total);
});

window.api.onState(({ running }) => setRunning(running));

window.api.onDone((payload) => {
  setRunning(false);
  el.openOutput.disabled = !el.outputDir.value.trim();

  if (!payload.ok) {
    setBadge('Ошибка', 'error');
    el.status.textContent = payload.error || 'Обработка завершилась с ошибкой.';
    setProgress(0, 0);
    return;
  }

  const summary = payload.summary || {};
  el.counterDone.textContent = String(summary.done || 0);
  el.counterFailed.textContent = String(summary.failed || 0);
  el.counterTotal.textContent = String(summary.total || 0);

  const seconds = Math.round((summary.elapsedMs || 0) / 1000);
  const minutes = Math.floor(seconds / 60);
  const timeText = minutes ? `${minutes} мин ${seconds % 60} с` : `${seconds} с`;

  if (summary.cancelled) {
    setBadge('Остановлено', 'error');
    el.status.textContent = `Остановлено. Готово файлов: ${summary.done} из ${summary.total}.`;
    appendLog('warn', `Обработка остановлена. Готово: ${summary.done}, ошибок: ${summary.failed}.`);
  } else {
    setBadge(summary.failed ? 'С ошибками' : 'Готово', summary.failed ? 'error' : 'done');
    setProgress(100, 100);
    el.status.textContent = `Готово: ${summary.done} из ${summary.total} за ${timeText}.`;
    appendLog(
      summary.failed ? 'warn' : 'success',
      `— Обработка завершена за ${timeText}. Готово: ${summary.done}, ошибок: ${summary.failed} —`
    );
  }
});

// ----------------------------------------------------------------- Старт UI

(async function init() {
  clearLog();
  updateScheme();
  updateOverlayState();
  updateSplitState();

  const info = await window.api.getAppInfo();

  info.encoders.forEach((encoder) => {
    const option = document.createElement('option');
    option.value = encoder.value;
    option.textContent = encoder.label;
    el.encoder.appendChild(option);
  });
  el.encoder.value = info.defaults.encoder;
  el.percent.value = info.defaults.percent;
  el.percentRange.value = info.defaults.percent;

  const splitDefaults = info.defaults.split || {};
  el.leftShare.value = splitDefaults.leftShare;
  el.feather.value = splitDefaults.feather;
  el.leftZoom.value = splitDefaults.leftZoom;
  el.leftOffset.value = splitDefaults.leftOffset;
  el.rightZoom.value = splitDefaults.rightZoom;
  el.rightOffset.value = splitDefaults.rightOffset;

  el.chipVersion.textContent = `v${info.version}`;
  el.chipFfmpeg.textContent = `FFmpeg: ${info.ffmpegPath}`;
  el.chipFfmpeg.title = `FFmpeg: ${info.ffmpegPath}\nFFprobe: ${info.ffprobePath}`;

  restoreSettings();
  updateOverlayState();
  updateSplitState();
  updateSplitControls();
  updateScheme();

  el.openOutput.disabled = !el.outputDir.value.trim();
  refreshAllInfo();

  appendLog('info', 'Приложение готово. Выберите папки и файлы, затем нажмите «Начать обработку».');
})();
