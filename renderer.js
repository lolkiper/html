'use strict';

/**
 * renderer.js — интерфейс. Доступ к файловой системе и FFmpeg только через
 * window.api (preload.js), напрямую Node в этом процессе не используется.
 */

/**
 * Каждая языковая вкладка — отдельная копия этой страницы (index.html?ws=ws1…ws5)
 * в своём WebContentsView. Настройки хранятся под ключом своей вкладки, а
 * main-процесс по отправителю запроса понимает, чьи это папки и очереди.
 */
const WS_ID = new URLSearchParams(window.location.search).get('ws') || 'ws1';
const LEGACY_STORAGE_KEY = 'shorts-inserter:settings';
const LEGACY_IMPORTED_KEY = 'shorts-inserter:legacy-imported';
const STORAGE_KEY = `shorts-inserter:settings:${WS_ID}`;
const MAX_LOG_ROWS = 2000;
const FOLDER_REPORT_DELAY_MS = 250;

const el = {
  wsTitle: document.getElementById('ws-title'),
  wsSubtitle: document.getElementById('ws-subtitle'),
  wsSettingsToggle: document.getElementById('ws-settings-toggle'),
  wsSettings: document.getElementById('ws-settings'),
  wsName: document.getElementById('ws-name'),
  wsFlag: document.getElementById('ws-flag'),
  wsCode: document.getElementById('ws-code'),
  wsSave: document.getElementById('ws-save'),
  wsSettingsNote: document.getElementById('ws-settings-note'),
  wsMakeFolders: document.getElementById('ws-make-folders'),
  wsReset: document.getElementById('ws-reset'),
  wsFoldersExample: document.getElementById('ws-folders-example'),
  wsFoldersExampleOut: document.getElementById('ws-folders-example-out'),
  exportHint: document.getElementById('export-hint'),
  parallelJobs: document.getElementById('parallel-jobs'),
  fileLabel: document.getElementById('file-label'),
  conflictNotes: {
    sourceDir: document.getElementById('conflict-sourceDir'),
    outputDir: document.getElementById('conflict-outputDir'),
    downloadDir: document.getElementById('conflict-downloadDir'),
    renameDir: document.getElementById('conflict-renameDir')
  },

  chipVersion: document.getElementById('chip-version'),
  chipFfmpeg: document.getElementById('chip-ffmpeg'),
  chipYtdlp: document.getElementById('chip-ytdlp'),

  sourceDir: document.getElementById('source-dir'),
  sourceDirNote: document.getElementById('source-dir-note'),
  shortsFile: document.getElementById('shorts-file'),
  shortsFileNote: document.getElementById('shorts-file-note'),
  useShorts: document.getElementById('use-shorts'),
  shortsBody: document.getElementById('shorts-body'),
  percentField: document.getElementById('percent-field'),
  percentTime: document.getElementById('percent-time'),

  useFreeze: document.getElementById('use-freeze'),
  freezeBody: document.getElementById('freeze-body'),
  freezeFile: document.getElementById('freeze-file'),
  freezeFileNote: document.getElementById('freeze-file-note'),
  freezePercent: document.getElementById('freeze-percent'),
  freezePercentRange: document.getElementById('freeze-percent-range'),
  freezeAtValue: document.getElementById('freeze-at-value'),
  freezeAtNote: document.getElementById('freeze-at-note'),
  freezeSize: document.getElementById('freeze-size'),
  freezeSizeValue: document.getElementById('freeze-size-value'),

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
  exportMode: document.getElementById('export-mode'),
  resourceUsage: document.getElementById('resource-usage'),
  accelNote: document.getElementById('accel-note'),
  encodeMeta: document.getElementById('encode-meta'),
  frame: document.getElementById('frame'),
  fit: document.getElementById('fit'),
  verbose: document.getElementById('verbose'),

  schemeHead: document.getElementById('scheme-head'),
  schemeTail: document.getElementById('scheme-tail'),
  schemeOverlay: document.getElementById('scheme-overlay'),
  schemeShorts: document.getElementById('scheme-shorts'),
  schemeFreeze: document.getElementById('scheme-freeze'),

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
  clearLog: document.getElementById('clear-log'),

  viewInsert: document.getElementById('view-insert'),
  viewDownload: document.getElementById('view-download'),
  viewRename: document.getElementById('view-rename'),
  dlLinks: document.getElementById('dl-links'),
  dlLinksNote: document.getElementById('dl-links-note'),
  dlImport: document.getElementById('dl-import'),
  dlClear: document.getElementById('dl-clear'),
  dlDir: document.getElementById('dl-dir'),
  dlParallel: document.getElementById('dl-parallel'),
  dlDirNote: document.getElementById('dl-dir-note'),
  dlPickDir: document.getElementById('dl-pick-dir'),
  dlStart: document.getElementById('dl-start'),
  dlPause: document.getElementById('dl-pause'),
  dlResume: document.getElementById('dl-resume'),
  dlStop: document.getElementById('dl-stop'),
  dlOpen: document.getElementById('dl-open'),
  dlBadge: document.getElementById('dl-badge'),
  dlStatus: document.getElementById('dl-status'),
  dlCurrentLabel: document.getElementById('dl-current-label'),
  dlFilePercent: document.getElementById('dl-file-percent'),
  dlFileBar: document.getElementById('dl-file-bar'),
  dlOverallPercent: document.getElementById('dl-overall-percent'),
  dlOverallBar: document.getElementById('dl-overall-bar'),
  dlSpeedNote: document.getElementById('dl-speed-note'),
  dlQualityNote: document.getElementById('dl-quality-note'),
  dlTotal: document.getElementById('dl-total'),
  dlDone: document.getElementById('dl-done'),
  dlActive: document.getElementById('dl-active'),
  dlWait: document.getElementById('dl-wait'),
  dlRetry: document.getElementById('dl-retry'),
  dlPerm: document.getElementById('dl-perm'),
  dlSkipNote: document.getElementById('dl-skip-note'),
  dlAudioLang: document.getElementById('dl-audio-lang'),
  dlAudioLangOther: document.getElementById('dl-audio-lang-other'),
  dlAudioDetect: document.getElementById('dl-audio-detect'),
  dlAudioDetectNow: document.getElementById('dl-audio-detect-now'),
  dlSelectAll: document.getElementById('dl-select-all'),
  dlSelectAllBtn: document.getElementById('dl-select-all-btn'),
  dlSelectNone: document.getElementById('dl-select-none'),
  dlSelectLang: document.getElementById('dl-select-lang'),
  dlBulkLang: document.getElementById('dl-bulk-lang'),
  dlSetLang: document.getElementById('dl-set-lang'),
  dlTableBody: document.getElementById('dl-table-body'),
  dlErrors: document.getElementById('dl-errors'),
  dlLog: document.getElementById('dl-log'),
  dlCopyLog: document.getElementById('dl-copy-log'),
  dlClearLog: document.getElementById('dl-clear-log'),

  rnDir: document.getElementById('rn-dir'),
  rnDirNote: document.getElementById('rn-dir-note'),
  rnPickDir: document.getElementById('rn-pick-dir'),
  rnTxt: document.getElementById('rn-txt'),
  rnTxtNote: document.getElementById('rn-txt-note'),
  rnPickTxt: document.getElementById('rn-pick-txt'),
  rnMin: document.getElementById('rn-min'),
  rnMinValue: document.getElementById('rn-min-value'),
  rnRemove: document.getElementById('rn-remove'),
  rnReports: document.getElementById('rn-reports'),
  rnKeepTxt: document.getElementById('rn-keep-txt'),
  rnPreview: document.getElementById('rn-preview'),
  rnApply: document.getElementById('rn-apply'),
  rnOpenReport: document.getElementById('rn-open-report'),
  rnOpenDir: document.getElementById('rn-open-dir'),
  rnBadge: document.getElementById('rn-badge'),
  rnStatus: document.getElementById('rn-status'),
  rnTitles: document.getElementById('rn-titles'),
  rnVideos: document.getElementById('rn-videos'),
  rnMatched: document.getElementById('rn-matched'),
  rnLow: document.getElementById('rn-low'),
  rnConflict: document.getElementById('rn-conflict'),
  rnMissing: document.getElementById('rn-missing'),
  rnDeleteNote: document.getElementById('rn-delete-note'),
  rnTableBody: document.getElementById('rn-table-body'),
  rnLog: document.getElementById('rn-log'),
  clearRenderQueue: document.getElementById('clear-render-queue'),
  dlClearQueue: document.getElementById('dl-clear-queue')
};

const state = {
  workspace: { id: WS_ID, name: '', code: 'es', flag: '' },
  conflicts: [],
  folderReportTimer: null,
  downloadTableSignature: '',
  running: false,
  logLines: [],
  downloading: false,
  downloadLog: [],
  downloadItems: [],
  dlSelection: new Set(),
  audioLangByNumber: {},
  renamePreview: null,
  renameReport: null,
  /** Первый ролик папки — шкала ползунков момента Shorts и Overlay. */
  reference: null,
  freezePercent: 50
};

const FREEZE_FILE_HINT = 'Любой видеофайл; без звука — на время вставки тишина.';

/** 32 -> "00:32.000" */
function formatClock(seconds) {
  const ms = Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : 0) * 1000);
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${mm}:${ss}.${String(ms % 1000).padStart(3, '0')}`;
}

const CLOSEUP_HINT = 'Для каждого следующего ролика крупный план продолжается с того места, где закончился предыдущий. Если видео кончится — начнётся сначала. Звук берётся из основного ролика.';
const OVERLAY_HINT = 'Короткий оверлей зациклится, длинный — обрежется по длине результата.';

// Языки аудио для выпадающих списков в строках очереди (зеркало downloader.js,
// при старте перезаписывается списком из main-процесса).
let AUDIO_LANG_OPTIONS = [
  { value: 'auto', label: 'Авто', flag: '🎧' },
  { value: 'original', label: 'Original', flag: '🌎' },
  { value: 'ru', label: 'Русский', flag: '🇷🇺' },
  { value: 'en', label: 'English', flag: '🇬🇧' },
  { value: 'es', label: 'Español', flag: '🇪🇸' },
  { value: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { value: 'fr', label: 'Français', flag: '🇫🇷' },
  { value: 'it', label: 'Italiano', flag: '🇮🇹' },
  { value: 'pt', label: 'Português', flag: '🇵🇹' }
];

const DL_STATUS_LABEL = {
  WAITING: 'Ожидание',
  DOWNLOADING: 'Скачивание',
  SUCCESS: 'Готово',
  RETRY: 'Повтор',
  PERMANENT_ERROR: 'Ошибка',
  SKIPPED: 'Пропущено'
};

function audioLangOption(value) {
  const code = String(value == null || value === '' ? 'auto' : value).toLowerCase();
  return AUDIO_LANG_OPTIONS.find((option) => option.value === code) || null;
}

function audioLangLabel(value) {
  const option = audioLangOption(value);
  if (option) return option.label;
  return String(value || 'auto').toUpperCase();
}

function audioLangFlag(value) {
  const option = audioLangOption(value);
  return (option && option.flag) || '🌐';
}

function describeAudioLang(value) {
  return `${audioLangFlag(value)} ${audioLangLabel(value)}`;
}

/** Глобальный язык по умолчанию с учётом варианта «Другой». */
function currentDefaultAudioLang() {
  if (!el.dlAudioLang) return 'auto';
  const value = el.dlAudioLang.value || 'auto';
  if (value !== 'other') return value;
  const custom = el.dlAudioLangOther ? el.dlAudioLangOther.value.trim().toLowerCase() : '';
  return custom || 'auto';
}

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
    el.percent, el.percentRange, el.encoder, el.exportMode, el.resourceUsage, el.parallelJobs,
    el.frame, el.fit, el.useOverlay,
    el.overlayOpacity, el.verbose,
    el.useShorts, el.useFreeze, el.freezeFile, el.freezePercent, el.freezePercentRange, el.freezeSize,
    el.useSplit, el.closeupFile, el.leftShare, el.feather,
    el.leftZoom, el.leftOffset, el.rightZoom, el.rightOffset
  ];
  lockable.filter(Boolean).forEach((node) => {
    node.disabled = running;
  });
  document.querySelectorAll('[data-pick]').forEach((button) => {
    button.disabled = running;
  });
  if (el.wsCode) el.wsCode.disabled = running;
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
  el.splitPreviewSeam.style.flexBasis = `${Math.max(4, Math.round(feather * 0.7))}px`;

  const canvasWidth = 1080;
  const pixels = Math.round((canvasWidth * leftOffset) / 100);
  el.splitHint.textContent =
    `Итог — квадрат 1080×1080. Сдвиг ${signedPercent(leftOffset)} это ` +
    `${pixels} px; ноль ставит центр ролика в центр своей половины.`;
}

function updateScheme() {
  const percent = clamp(Number(el.percent.value) || 90, 50, 99);
  const shortsOn = el.useShorts.checked;
  // Shorts на схеме занимает фиксированную долю, остальное делится по проценту.
  const shortsShare = shortsOn ? 22 : 0;
  const headShare = ((100 - shortsShare) * percent) / 100;
  el.schemeHead.style.flexBasis = shortsOn ? `${headShare}%` : '100%';
  el.schemeHead.textContent = shortsOn ? `Исходник ${percent}%` : 'Исходник целиком';
  el.schemeTail.textContent = `${100 - percent}%`;
  el.schemeTail.hidden = !shortsOn;
  el.schemeShorts.dataset.off = String(!shortsOn);

  const ref = state.reference;
  el.percentTime.textContent = ref && ref.duration > 0
    ? `${formatClock((ref.duration * percent) / 100)} из ${formatClock(ref.duration)}`
    : `${percent}%`;

  el.schemeFreeze.dataset.off = String(!el.useFreeze.checked);
  el.schemeFreeze.textContent = el.useFreeze.checked
    ? `Overlay-вставка: стоп-кадр после ${state.freezePercent}% ролика, основное видео ждёт, затем продолжается`
    : 'Overlay-вставка выключена';
}

function updateShortsState() {
  const enabled = el.useShorts.checked;
  el.shortsBody.dataset.disabled = String(!enabled);
  el.percentField.dataset.disabled = String(!enabled);
  updateScheme();
}

function updateFreezeState() {
  el.freezeBody.dataset.disabled = String(!el.useFreeze.checked);
  updateScheme();
}

/** Процент Overlay: 0..100, шаг 0.1; синхронизирует поле, ползунок и подписи. */
function setFreezePercent(value, { fromInput = false } = {}) {
  const number = Number(value);
  const percent = Number.isFinite(number) ? Math.round(clamp(number, 0, 100) * 10) / 10 : 50;
  state.freezePercent = percent;
  el.freezePercentRange.value = String(percent);
  if (!fromInput || document.activeElement !== el.freezePercent) el.freezePercent.value = String(percent);
  const ref = state.reference;
  if (ref && ref.duration > 0) {
    const seconds = (ref.duration * percent) / 100;
    el.freezeAtValue.textContent = `${percent}% · ${formatClock(seconds)} из ${formatClock(ref.duration)}`;
    const frame = ref.fps > 0 ? `, кадр ${Math.round(seconds * ref.fps)} при ${ref.fps} fps` : '';
    el.freezeAtNote.textContent =
      `Один процент для всех роликов: у каждого момент считается от его длины, как у Shorts. ` +
      `Пример — ${ref.name}: ${formatClock(seconds)}${frame}.`;
  } else {
    el.freezeAtValue.textContent = `${percent}%`;
    el.freezeAtNote.textContent =
      'Один процент для всех роликов: у каждого момент считается от его длины, как у Shorts.';
  }
  updateScheme();
}

// ------------------------------------------------------------- Сохранение

function collectSettings() {
  return {
    sourceDir: el.sourceDir.value.trim(),
    shortsFile: el.shortsFile.value.trim(),
    useShorts: el.useShorts.checked,
    useFreeze: el.useFreeze.checked,
    freezeFile: el.freezeFile.value.trim(),
    freezePercent: state.freezePercent,
    freezeSize: Number(el.freezeSize.value),
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
    exportMode: el.exportMode ? el.exportMode.value : 'auto',
    resourceUsage: el.resourceUsage ? el.resourceUsage.value : 'max',
    parallelJobs: el.parallelJobs ? el.parallelJobs.value : 'auto',
    frame: el.frame.value,
    fit: el.fit.value,
    verbose: el.verbose.checked,
    downloadDir: el.dlDir.value.trim(),
    downloadLinks: el.dlLinks.value,
    downloadParallel: el.dlParallel ? Number(el.dlParallel.value) : 3,
    downloadAudioLang: el.dlAudioLang ? el.dlAudioLang.value : 'auto',
    downloadAudioLangOther: el.dlAudioLangOther ? el.dlAudioLangOther.value.trim() : '',
    downloadAudioDetect: el.dlAudioDetect ? el.dlAudioDetect.checked : false,
    downloadAudioLangs: state.audioLangByNumber,
    renameDir: el.rnDir.value.trim(),
    renameTxt: el.rnTxt.value.trim(),
    renameMin: Number(el.rnMin.value),
    renameRemove: el.rnRemove.checked,
    renameReports: el.rnReports.checked,
    renameKeepTxt: el.rnKeepTxt.checked
  };
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectSettings()));
  } catch (err) {
    /* приватный режим / нет доступа к storage — не критично */
  }
  scheduleFolderReport();
}

function currentFolders() {
  return {
    sourceDir: el.sourceDir.value.trim(),
    outputDir: el.outputDir.value.trim(),
    downloadDir: el.dlDir.value.trim(),
    renameDir: el.rnDir.value.trim()
  };
}

/** main-процесс знает папки всех вкладок и не даёт двум вкладкам взять одну папку. */
function scheduleFolderReport() {
  if (state.folderReportTimer) clearTimeout(state.folderReportTimer);
  state.folderReportTimer = setTimeout(reportFolders, FOLDER_REPORT_DELAY_MS);
}

async function reportFolders() {
  if (state.folderReportTimer) clearTimeout(state.folderReportTimer);
  state.folderReportTimer = null;
  const result = await window.api.setWorkspaceFolders(currentFolders());
  if (result && result.ok) applyConflicts(result.conflicts);
  return result;
}

function applyConflicts(conflicts) {
  state.conflicts = Array.isArray(conflicts) ? conflicts : [];
  Object.entries(el.conflictNotes).forEach(([field, node]) => {
    if (!node) return;
    const conflict = state.conflicts.find((item) => item.field === field);
    node.hidden = !conflict;
    node.textContent = conflict
      ? `⚠ Эта папка уже занята вкладкой ${conflict.otherName} (${conflict.otherLabel}). Выберите другую — вкладки не должны пересекаться.`
      : '';
  });
}

function conflictFor(...fields) {
  return state.conflicts.find((item) => fields.includes(item.field)) || null;
}

function readSavedSettings() {
  try {
    const own = localStorage.getItem(STORAGE_KEY);
    if (own) return JSON.parse(own);
    // Настройки версии с одной вкладкой переезжают в первую вкладку один раз.
    if (WS_ID === 'ws1' && !localStorage.getItem(LEGACY_IMPORTED_KEY)) {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
      localStorage.setItem(LEGACY_IMPORTED_KEY, '1');
      if (legacy) return { ...legacy, resourceUsage: 'max', parallelJobs: 'auto' };
    }
  } catch (err) {
    /* повреждённые настройки — начинаем с чистых */
  }
  return null;
}

function restoreSettings() {
  const saved = readSavedSettings();
  if (!saved) return;

  el.sourceDir.value = saved.sourceDir || '';
  el.shortsFile.value = saved.shortsFile || '';
  el.overlayFile.value = saved.overlayFile || '';
  el.closeupFile.value = saved.closeupFile || '';
  el.outputDir.value = saved.outputDir || '';
  el.useOverlay.checked = Boolean(saved.useOverlay);
  el.useShorts.checked = saved.useShorts !== false;
  el.useFreeze.checked = Boolean(saved.useFreeze);
  el.freezeFile.value = saved.freezeFile || '';
  if (saved.freezePercent != null && Number.isFinite(Number(saved.freezePercent))) {
    setFreezePercent(Number(saved.freezePercent));
  }
  if (Number.isFinite(Number(saved.freezeSize))) {
    el.freezeSize.value = clamp(Number(saved.freezeSize), 30, 100);
  }
  el.freezeSizeValue.textContent = `${el.freezeSize.value}%`;
  el.useSplit.checked = Boolean(saved.useSplit);
  el.verbose.checked = Boolean(saved.verbose);

  const split = saved.split || {};
  const oldLayout =
    Number(split.leftOffset) === -25 &&
    Number(split.rightOffset) === 25 &&
    (Number(split.feather) === 8 || saved.frame === undefined || saved.frame === 'source');
  const restoreRange = (node, value) => {
    if (Number.isFinite(Number(value))) node.value = value;
  };
  restoreRange(el.leftShare, split.leftShare);
  restoreRange(el.feather, oldLayout ? 48 : split.feather);
  restoreRange(el.leftZoom, split.leftZoom);
  restoreRange(el.leftOffset, oldLayout ? 0 : split.leftOffset);
  restoreRange(el.rightZoom, split.rightZoom);
  restoreRange(el.rightOffset, oldLayout ? 0 : split.rightOffset);

  if (Number.isFinite(saved.percent)) {
    el.percent.value = clamp(saved.percent, 50, 99);
    el.percentRange.value = el.percent.value;
  }
  if (Number.isFinite(saved.overlayOpacity)) {
    el.overlayOpacity.value = clamp(saved.overlayOpacity, 5, 100);
    el.overlayOpacityValue.textContent = `${el.overlayOpacity.value}%`;
  }
  if (saved.encoder) el.encoder.value = saved.encoder;
  if (el.exportMode && saved.exportMode) el.exportMode.value = saved.exportMode;
  if (el.resourceUsage) {
    if (saved.resourceUsage) el.resourceUsage.value = saved.resourceUsage;
    else if (saved.accel === 'gpu') el.resourceUsage.value = 'high';
    else if (saved.accel === 'cpu') el.resourceUsage.value = 'low';
    else el.resourceUsage.value = 'balanced';
    if (!el.resourceUsage.value) el.resourceUsage.value = 'max';
  }
  if (el.parallelJobs && saved.parallelJobs != null) {
    el.parallelJobs.value = String(saved.parallelJobs);
    if (!el.parallelJobs.value) el.parallelJobs.value = 'auto';
  }
  el.frame.value = saved.frame && saved.frame !== 'source' ? saved.frame : 'square1080';
  if (saved.fit) el.fit.value = saved.fit;
  if (saved.downloadDir) el.dlDir.value = saved.downloadDir;
  if (saved.downloadLinks) el.dlLinks.value = saved.downloadLinks;
  if (el.dlParallel && saved.downloadParallel) {
    const value = String(saved.downloadParallel);
    if (Array.from(el.dlParallel.options).some((option) => option.value === value)) el.dlParallel.value = value;
  }
  if (el.dlAudioLang && saved.downloadAudioLang) el.dlAudioLang.value = saved.downloadAudioLang;
  if (el.dlAudioLangOther && saved.downloadAudioLangOther) {
    el.dlAudioLangOther.value = saved.downloadAudioLangOther;
  }
  if (el.dlAudioLangOther && el.dlAudioLang) {
    el.dlAudioLangOther.hidden = el.dlAudioLang.value !== 'other';
  }
  if (el.dlAudioDetect && saved.downloadAudioDetect != null) {
    el.dlAudioDetect.checked = Boolean(saved.downloadAudioDetect);
  }
  if (saved.downloadAudioLangs && typeof saved.downloadAudioLangs === 'object') {
    state.audioLangByNumber = { ...saved.downloadAudioLangs };
  }
  if (el.dlBulkLang && saved.downloadAudioLang && saved.downloadAudioLang !== 'other') {
    el.dlBulkLang.value = saved.downloadAudioLang;
  }
  if (saved.renameDir) el.rnDir.value = saved.renameDir;
  if (saved.renameTxt) el.rnTxt.value = saved.renameTxt;
  if (Number.isFinite(saved.renameMin)) el.rnMin.value = saved.renameMin;
  if (saved.renameRemove != null) el.rnRemove.checked = Boolean(saved.renameRemove);
  if (saved.renameReports != null) el.rnReports.checked = Boolean(saved.renameReports);
  if (saved.renameKeepTxt != null) el.rnKeepTxt.checked = Boolean(saved.renameKeepTxt);
}

// ------------------------------------------------------- Проверка выбранного

async function refreshSourceInfo() {
  const directory = el.sourceDir.value.trim();
  if (!directory) {
    el.sourceDirNote.textContent = 'Выберите папку — покажем количество найденных видео.';
    el.sourceDirNote.className = 'field__note';
    setReference(null);
    return;
  }

  const result = await window.api.scanSources({
    directory,
    outputDir: el.outputDir.value.trim()
  });
  setReference(result && result.first && result.first.duration > 0 ? result.first : null);

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

function setReference(first) {
  state.reference = first;
  setFreezePercent(state.freezePercent);
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
  if (el.useFreeze.checked) {
    refreshMediaInfo(el.freezeFile, el.freezeFileNote, FREEZE_FILE_HINT);
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
  }),
  'freeze-file': async () => window.api.pickVideo({
    title: 'Выберите overlay-видео',
    defaultPath: el.freezeFile.value.trim() || el.shortsFile.value.trim()
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
    if (key === 'freeze-file') {
      refreshMediaInfo(el.freezeFile, el.freezeFileNote, FREEZE_FILE_HINT);
    }
  });
});

['source-dir', 'output-dir', 'shorts-file', 'overlay-file', 'closeup-file', 'freeze-file'].forEach((id) => {
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

el.useShorts.addEventListener('change', () => {
  updateShortsState();
  saveSettings();
});

el.useFreeze.addEventListener('change', () => {
  updateFreezeState();
  saveSettings();
  if (el.useFreeze.checked) refreshMediaInfo(el.freezeFile, el.freezeFileNote, FREEZE_FILE_HINT);
});

el.freezePercentRange.addEventListener('input', () => setFreezePercent(el.freezePercentRange.value));
el.freezePercentRange.addEventListener('change', saveSettings);

el.freezePercent.addEventListener('input', () => {
  if (el.freezePercent.value.trim() === '') return;
  setFreezePercent(el.freezePercent.value, { fromInput: true });
});
el.freezePercent.addEventListener('change', () => {
  setFreezePercent(el.freezePercent.value.trim() === '' ? state.freezePercent : el.freezePercent.value);
  saveSettings();
});

el.freezeSize.addEventListener('input', () => {
  el.freezeSizeValue.textContent = `${el.freezeSize.value}%`;
});
el.freezeSize.addEventListener('change', saveSettings);

el.useSplit.addEventListener('change', () => {
  if (el.useSplit.checked) {
    el.frame.value = 'square1080';
    refreshMediaInfo(el.closeupFile, el.closeupFileNote, CLOSEUP_HINT);
  }
  updateSplitState();
  saveSettings();
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
if (el.exportMode) el.exportMode.addEventListener('change', saveSettings);
if (el.resourceUsage) el.resourceUsage.addEventListener('change', saveSettings);
el.frame.addEventListener('change', saveSettings);
el.fit.addEventListener('change', saveSettings);
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
  if (state.running || state.starting) return;
  state.starting = true;
  try {
    await startProcessing();
  } finally {
    state.starting = false;
  }
});

async function startProcessing() {
  const settings = collectSettings();
  const problems = [];
  if (!settings.sourceDir) problems.push('Не выбрана папка с исходными видео.');
  if (settings.useShorts && !settings.shortsFile) problems.push('Shorts включён, но файл Shorts не выбран.');
  if (settings.useFreeze && !settings.freezeFile && !settings.shortsFile) {
    problems.push('Overlay-вставка включена, но видео для неё не выбрано.');
  }
  if (!settings.outputDir) problems.push('Не выбрана папка для сохранения.');
  if (settings.useOverlay && !settings.overlayFile) problems.push('Включён оверлей, но файл не выбран.');
  if (settings.useSplit && !settings.closeupFile) {
    problems.push('Включён сплит-скрин, но видео для правой половины не выбрано.');
  }
  await reportFolders();
  const conflict = conflictFor('sourceDir', 'outputDir');
  if (conflict) {
    problems.push(`Папка «${conflict.path}» занята вкладкой ${conflict.otherName}. Выберите для этой вкладки свою папку.`);
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
  appendLog('info', `— Запуск обработки (${state.workspace.flag} ${state.workspace.name}, файлы ${state.workspace.code}N) —`);

  const result = await window.api.startProcessing(settings);
  if (result && !result.ok && !result.reported) {
    setRunning(false);
    setBadge('Ошибка', 'error');
    el.status.textContent = result.error || 'Не удалось запустить обработку.';
    appendLog('error', result.error || 'Не удалось запустить обработку.');
  }
}

// ---------------------------------------------------------- Подписки на main

window.api.onLog(({ level, message }) => appendLog(level, message));

function applyRenderProgress(progress) {
  if (!progress) return;
  setProgress(progress.filePercent, progress.overallPercent);
  if (el.fileLabel && Number.isFinite(progress.active)) {
    el.fileLabel.textContent = progress.active > 1
      ? `Текущие файлы (${progress.active} одновременно, среднее)`
      : 'Текущий файл';
  }
  if (progress.status) el.status.textContent = progress.status;
  if (Number.isFinite(progress.total)) el.counterTotal.textContent = String(progress.total);
  if (Number.isFinite(progress.done)) el.counterDone.textContent = String(progress.done);
  if (Number.isFinite(progress.failed)) el.counterFailed.textContent = String(progress.failed);
  if (el.encodeMeta) {
    const bits = [
      progress.encoderName ? `Кодек: ${progress.encoderName}` : null,
      progress.resolution ? `Кадр: ${progress.resolution}` : null,
      progress.fps ? `FPS: ${Math.round(progress.fps)}` : null,
      progress.eta && progress.eta !== '—' ? `ETA: ${progress.eta}` : null,
      progress.estimatedSize ? `~${progress.estimatedSize}` : null
    ].filter(Boolean);
    if (bits.length) el.encodeMeta.textContent = bits.join(' · ');
  }
}

window.api.onProgress(applyRenderProgress);

window.api.onState(({ running }) => setRunning(running));

window.api.onDone((payload) => {
  setRunning(false);
  el.openOutput.disabled = !el.outputDir.value.trim();
  if (el.fileLabel) el.fileLabel.textContent = 'Текущий файл';

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

function describeHardware(hardware) {
  if (!hardware || !hardware.ok) return 'Не удалось проверить видеокарту — будет software-кодирование.';
  if (hardware.gpu) {
    return `Hardware Encoder: ${hardware.gpu}. Склейка на CPU (${hardware.cores} ядер), кодирование на GPU.`;
  }
  if (hardware.compiledGpu && hardware.compiledGpu.length) {
    return `FFmpeg видит ${hardware.compiledGpu.join(', ')}, но тест кадра не прошёл` +
      (hardware.probeError ? ` (${hardware.probeError})` : '') +
      `. Будет software-кодирование на ${hardware.cores} ядрах.`;
  }
  return `Видеокарта недоступна — software-кодирование на ${hardware.cores} ядрах.`;
}

function applyWorkspaceInfo(workspace) {
  if (!workspace) return;
  state.workspace = { ...state.workspace, ...workspace };
  const { name, code, flag } = state.workspace;
  document.title = `${flag} ${name} — Shorts Inserter`;
  el.wsTitle.textContent = `${flag} ${name}`;
  el.wsSubtitle.textContent =
    `Вкладка ${state.workspace.index + 1} из 5 · свои папки, очереди и настройки · готовые ролики: ${code}1.mp4, ${code}2.mp4…`;
  if (el.exportHint) el.exportHint.textContent = `Результат: ${code}1.mp4, ${code}2.mp4, …`;
  if (el.wsFoldersExample) el.wsFoldersExample.textContent = `${code}/download`;
  if (el.wsFoldersExampleOut) el.wsFoldersExampleOut.textContent = `${code}/montage`;
  if (document.activeElement !== el.wsName) el.wsName.value = name;
  if (document.activeElement !== el.wsFlag) el.wsFlag.value = flag;
  if (document.activeElement !== el.wsCode) el.wsCode.value = code;
}

/** Вкладка могла перезагрузиться посреди работы — забираем текущее состояние из main. */
function applyRuntimeState(runtimeState) {
  if (!runtimeState) return;
  if (runtimeState.rendering) {
    setRunning(true);
    setBadge('Обработка', 'running');
    applyRenderProgress(runtimeState.lastRender);
  }
  if (runtimeState.downloading) {
    setDownloadRunning(true, runtimeState.downloadPaused);
    el.dlBadge.textContent = runtimeState.downloadPaused ? 'Пауза' : 'Скачивание';
    el.dlBadge.className = `badge ${runtimeState.downloadPaused ? 'badge--error' : 'badge--running'}`;
    if (runtimeState.lastDownload) applyDownloadProgress(runtimeState.lastDownload);
  }
}

(async function init() {
  clearLog();
  updateScheme();
  updateOverlayState();
  updateSplitState();

  const [info, wsInfo] = await Promise.all([window.api.getAppInfo(), window.api.getWorkspace()]);
  if (wsInfo && wsInfo.ok) applyWorkspaceInfo(wsInfo.workspace);

  const fillSelect = (node, items) => {
    items.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      node.appendChild(option);
    });
  };

  fillSelect(el.encoder, info.encoders);
  if (el.exportMode) fillSelect(el.exportMode, info.exportModes || []);
  if (el.resourceUsage) fillSelect(el.resourceUsage, info.resourceModes || []);
  if (el.parallelJobs) fillSelect(el.parallelJobs, info.parallelModes || []);
  fillSelect(el.frame, info.frames);
  fillSelect(el.fit, info.fits);

  el.encoder.value = info.defaults.encoder;
  if (el.exportMode) el.exportMode.value = info.defaults.exportMode || 'auto';
  if (el.resourceUsage) el.resourceUsage.value = info.defaults.resourceUsage || 'max';
  if (el.parallelJobs) el.parallelJobs.value = String(info.defaults.parallelJobs || 'auto');
  el.frame.value = info.defaults.frame;
  el.fit.value = info.defaults.fit;
  el.percent.value = info.defaults.percent;
  el.percentRange.value = info.defaults.percent;

  window.api.getHardware().then((hardware) => {
    if (el.accelNote) el.accelNote.textContent = describeHardware(hardware);
  });

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
  if (el.chipYtdlp) {
    el.chipYtdlp.textContent = `yt-dlp: ${info.ytdlpPath || '—'}`;
    el.chipYtdlp.title = info.ytdlpOk
      ? `yt-dlp: ${info.ytdlpPath}`
      : 'yt-dlp не найден. При сборке он должен лежать в vendor/yt-dlp.';
  }

  restoreSettings();
  updateOverlayState();
  updateShortsState();
  updateFreezeState();
  updateSplitState();
  updateSplitControls();
  updateScheme();

  el.openOutput.disabled = !el.outputDir.value.trim();
  bindWorkspaceUi();
  bindDownloadUi();
  bindRenameUi();
  bindQueueCleanupUi();
  await reportFolders();
  refreshAllInfo();
  applyRuntimeState(wsInfo && wsInfo.state);
  await refreshDownloadQueue();

  appendLog(
    'info',
    `Вкладка ${state.workspace.flag} ${state.workspace.name} готова. Выберите папки и файлы, затем нажмите «Начать обработку».`
  );
})();

// ------------------------------------------------------- Настройки вкладки

function bindWorkspaceUi() {
  window.api.onWorkspaceInfo(applyWorkspaceInfo);
  window.api.onWorkspaceConflicts(applyConflicts);

  el.wsSettingsToggle.addEventListener('click', () => {
    const open = el.wsSettings.hidden;
    el.wsSettings.hidden = !open;
    el.wsSettingsToggle.setAttribute('aria-expanded', String(open));
  });

  el.wsSave.addEventListener('click', async () => {
    const result = await window.api.updateWorkspace({
      name: el.wsName.value,
      flag: el.wsFlag.value,
      code: el.wsCode.value
    });
    if (!result || !result.ok) {
      el.wsSettingsNote.textContent = (result && result.error) || 'Не удалось сохранить.';
      el.wsSettingsNote.className = 'field__note field__note--error';
      return;
    }
    applyWorkspaceInfo(result.workspace);
    el.wsSettingsNote.textContent =
      `Сохранено. Готовые ролики этой вкладки: ${result.workspace.code}1.mp4, ${result.workspace.code}2.mp4…`;
    el.wsSettingsNote.className = 'field__note field__note--ok';
    refreshSourceInfo();
  });

  el.wsMakeFolders.addEventListener('click', async () => {
    const result = await window.api.makeWorkspaceFolders();
    if (!result || !result.ok) {
      if (result && result.error) {
        el.wsSettingsNote.textContent = result.error;
        el.wsSettingsNote.className = 'field__note field__note--error';
      }
      return;
    }
    const { folders } = result;
    if (!state.running) {
      el.sourceDir.value = folders.sourceDir;
      el.outputDir.value = folders.outputDir;
    }
    if (!state.downloading) el.dlDir.value = folders.downloadDir;
    el.rnDir.value = folders.renameDir;
    const titles = await window.api.detectRenameTxt(folders.renameDir);
    el.rnTxt.value = titles && titles.ok ? titles.file : '';
    saveSettings();
    await reportFolders();
    el.openOutput.disabled = !el.outputDir.value.trim();
    el.rnOpenDir.disabled = false;
    refreshAllInfo();
    await refreshDownloadQueue();
    el.wsSettingsNote.textContent =
      `Папки вкладки готовы: скачивание, переименование и исходники — ${folders.downloadDir}; ` +
      `готовые ролики — ${folders.outputDir}.`;
    el.wsSettingsNote.className = 'field__note field__note--ok';
  });

  el.wsReset.addEventListener('click', async () => {
    if (state.running || state.downloading) {
      el.wsSettingsNote.textContent = 'Сначала остановите монтаж и скачивание в этой вкладке.';
      el.wsSettingsNote.className = 'field__note field__note--error';
      return;
    }
    const ok = window.confirm(
      `Очистить вкладку «${state.workspace.name}»? Сбросятся пути, список ссылок и настройки только этой вкладки. ` +
        'Видео и файлы на диске не удаляются, другие вкладки не затрагиваются.'
    );
    if (!ok) return;
    const result = await window.api.resetWorkspace();
    if (!result || !result.ok) {
      el.wsSettingsNote.textContent = (result && result.error) || 'Не удалось очистить вкладку.';
      el.wsSettingsNote.className = 'field__note field__note--error';
      return;
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
      if (WS_ID === 'ws1') localStorage.setItem(LEGACY_IMPORTED_KEY, '1');
    } catch (err) {
      /* storage недоступен — перезагрузка всё равно сбросит интерфейс */
    }
    window.location.reload();
  });
}

// ------------------------------------------------------- Скачивание YouTube

function setDownloadRunning(running, paused = false) {
  state.downloading = running;
  el.dlStart.disabled = running;
  el.dlPause.disabled = !running || paused;
  el.dlResume.disabled = !running || !paused;
  el.dlStop.disabled = !running;
  el.dlImport.disabled = running;
  el.dlPickDir.disabled = running;
  if (el.dlParallel) el.dlParallel.disabled = running;
}

function appendDownloadLog(level, message) {
  const time = timeLabel();
  state.downloadLog.push(`[${time}] ${message}`);
  const emptyHint = el.dlLog.querySelector('.log__empty');
  if (emptyHint) emptyHint.remove();
  const atBottom = el.dlLog.scrollHeight - el.dlLog.scrollTop - el.dlLog.clientHeight < 60;
  const row = document.createElement('div');
  row.className = `log__row log__row--${level || 'info'}`;
  const timeNode = document.createElement('span');
  timeNode.className = 'log__time';
  timeNode.textContent = time;
  const textNode = document.createElement('span');
  textNode.className = 'log__text';
  textNode.textContent = message;
  row.append(timeNode, textNode);
  el.dlLog.appendChild(row);
  while (el.dlLog.children.length > MAX_LOG_ROWS) el.dlLog.removeChild(el.dlLog.firstChild);
  if (atBottom) el.dlLog.scrollTop = el.dlLog.scrollHeight;
}

/** Язык элемента очереди с учётом локальных правок до первого запуска. */
function itemAudioLang(item) {
  const local = state.audioLangByNumber[String(item.number)];
  return local || item.audioLang || 'auto';
}

/** Колонка «Доступно». */
function audioAvailabilityText(item) {
  const lang = itemAudioLang(item);
  if (item.audioMissing) return `⚠ ${audioLangLabel(lang)} недоступен`;
  const langs = Array.isArray(item.audioLanguages) ? item.audioLanguages : [];
  if (!langs.length) return item.audioChecked ? '—' : 'не проверено';
  if (lang !== 'auto') return `🌐 ${audioLangLabel(lang)} ✓`;
  return `🌐 Языки: ${langs.join(', ')}`;
}

/** Есть ли у видео дорожка на указанном языке (по результатам проверки). */
function itemHasAudioLang(item, lang) {
  if (!lang || lang === 'auto') return true;
  const tracks = Array.isArray(item.audioTracks) ? item.audioTracks : null;
  if (tracks && tracks.length) {
    if (lang === 'original') return tracks.some((track) => track && track.isOriginal);
    return tracks.some((track) => track && track.language === lang);
  }
  const langs = Array.isArray(item.audioLanguages) ? item.audioLanguages : [];
  const needle = lang === 'original' ? 'original' : audioLangLabel(lang).toLowerCase();
  return langs.some((text) => String(text).toLowerCase().includes(needle));
}

function buildAudioLangSelect(item) {
  const select = document.createElement('select');
  select.className = 'dl-lang';
  select.dataset.number = String(item.number);
  const value = itemAudioLang(item);
  let matched = false;
  AUDIO_LANG_OPTIONS.forEach((option) => {
    if (option.value === 'other') return;
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = `${option.flag} ${option.label}`;
    if (option.value === value) matched = true;
    select.appendChild(node);
  });
  if (!matched) {
    // Язык из варианта «Другой» — добавляем как отдельный пункт.
    const node = document.createElement('option');
    node.value = value;
    node.textContent = `🌐 ${audioLangLabel(value)}`;
    select.appendChild(node);
  }
  select.value = value;
  select.addEventListener('change', async () => {
    await setAudioLangFor([Number(item.number)], select.value);
  });
  return select;
}

function syncSelectAllCheckbox() {
  if (!el.dlSelectAll) return;
  const total = state.downloadItems.length;
  const picked = state.dlSelection.size;
  el.dlSelectAll.checked = total > 0 && picked === total;
  el.dlSelectAll.indeterminate = picked > 0 && picked < total;
}

function downloadTableSignature(items) {
  return JSON.stringify((items || []).map((item) => [
    item.number, item.status, item.title, item.url, item.audioLang, item.audioLanguages,
    item.audioMissing, item.audioChecked, item.quality, item.attempts, item.lastError,
    state.audioLangByNumber[String(item.number)] || null
  ]));
}

/**
 * Прогресс скачивания приходит несколько раз в секунду. Таблица на сотни
 * строк с выпадающими списками пересобирается только если в ней что-то
 * поменялось — иначе интерфейс подтормаживал на длинных очередях.
 */
function renderDownloadTableIfChanged(items) {
  const signature = downloadTableSignature(items);
  if (signature === state.downloadTableSignature) {
    state.downloadItems = Array.isArray(items) ? items : [];
    return;
  }
  renderDownloadTable(items);
}

function renderDownloadTable(items) {
  el.dlTableBody.innerHTML = '';
  state.downloadItems = Array.isArray(items) ? items : [];
  state.downloadTableSignature = downloadTableSignature(state.downloadItems);
  const known = new Set(state.downloadItems.map((item) => Number(item.number)));
  Array.from(state.dlSelection).forEach((number) => {
    if (!known.has(number)) state.dlSelection.delete(number);
  });
  if (!state.downloadItems.length) {
    const row = document.createElement('tr');
    row.className = 'queue-table__empty';
    row.innerHTML = '<td colspan="8">Список пуст</td>';
    el.dlTableBody.appendChild(row);
    syncSelectAllCheckbox();
    return;
  }
  state.downloadItems.forEach((item) => {
    const row = document.createElement('tr');
    if (item.status === 'SUCCESS') row.className = 'is-success';
    else if (item.status === 'RETRY') row.className = 'is-retry';
    else if (item.status === 'PERMANENT_ERROR') row.className = 'is-error';
    else if (item.status === 'DOWNLOADING') row.className = 'is-run';
    else if (item.status === 'SKIPPED') row.className = 'is-skip';

    const tdCheck = document.createElement('td');
    tdCheck.className = 'cell--check';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'dl-check';
    check.dataset.number = String(item.number);
    check.checked = state.dlSelection.has(Number(item.number));
    check.addEventListener('change', () => {
      if (check.checked) state.dlSelection.add(Number(item.number));
      else state.dlSelection.delete(Number(item.number));
      syncSelectAllCheckbox();
    });
    tdCheck.appendChild(check);
    row.appendChild(tdCheck);

    const tdNumber = document.createElement('td');
    tdNumber.textContent = String(item.number);
    row.appendChild(tdNumber);

    const tdVideo = document.createElement('td');
    tdVideo.textContent = item.title || item.url;
    tdVideo.title = item.url;
    row.appendChild(tdVideo);

    const tdLang = document.createElement('td');
    tdLang.appendChild(buildAudioLangSelect(item));
    row.appendChild(tdLang);

    const tdAvailable = document.createElement('td');
    tdAvailable.textContent = audioAvailabilityText(item);
    if (item.audioMissing) tdAvailable.className = 'cell--miss';
    row.appendChild(tdAvailable);

    const tdStatus = document.createElement('td');
    tdStatus.textContent = DL_STATUS_LABEL[item.status] || item.status;
    tdStatus.title = item.lastError || item.status;
    row.appendChild(tdStatus);

    const tdQuality = document.createElement('td');
    tdQuality.textContent = item.quality || 'AUTO';
    row.appendChild(tdQuality);

    const tdAttempts = document.createElement('td');
    tdAttempts.textContent = String(item.attempts || 0);
    row.appendChild(tdAttempts);

    el.dlTableBody.appendChild(row);
  });
  syncSelectAllCheckbox();
}

/**
 * Установка языка аудио для списка видео (одно или много).
 * Сохраняется и в очереди на диске, и локально (если очередь ещё не создана).
 */
async function setAudioLangFor(numbers, lang) {
  const list = (numbers || []).map(Number).filter((value) => Number.isFinite(value));
  if (!list.length) {
    el.dlStatus.textContent = 'Сначала отметьте видео галочками.';
    return;
  }
  list.forEach((number) => {
    state.audioLangByNumber[String(number)] = lang;
  });
  state.downloadItems.forEach((item) => {
    if (!list.includes(Number(item.number))) return;
    item.audioLang = lang;
    item.audioMissing = lang !== 'auto' && item.audioChecked ? !itemHasAudioLang(item, lang) : false;
  });
  saveSettings();
  appendDownloadLog('info', `🎧 ${audioLangLabel(lang)} — видео: ${list.length}`);

  const outputDir = el.dlDir.value.trim();
  if (outputDir && window.api.setDownloadAudioLang) {
    const result = await window.api.setDownloadAudioLang({ outputDir, numbers: list, lang });
    if (result && result.ok && result.progress) {
      applyDownloadProgress(result.progress);
      return;
    }
    if (result && !result.ok && result.error) appendDownloadLog('warn', result.error);
  }
  renderDownloadTable(state.downloadItems);
}

function renderDownloadErrors(errors) {
  el.dlErrors.innerHTML = '';
  if (!errors || !errors.length) {
    const empty = document.createElement('p');
    empty.className = 'log__empty';
    empty.textContent = 'Пока нет ошибок.';
    el.dlErrors.appendChild(empty);
    return;
  }
  errors.forEach((item) => {
    const node = document.createElement('div');
    node.className = 'error-item';
    const retry = item.nextRetry ? new Date(item.nextRetry).toLocaleTimeString('ru-RU', { hour12: false }) : '—';
    node.textContent =
      `#${item.number}  ${item.url}\nStatus: ${item.status}  Attempts: ${item.attempts || 0}\n` +
      `Error: ${item.lastError || '—'}\nNext retry: ${retry}`;
    el.dlErrors.appendChild(node);
  });
}

function applyDownloadProgress(progress) {
  if (!progress) return;
  el.dlTotal.textContent = String(progress.total || 0);
  el.dlDone.textContent = String(progress.completed || 0);
  el.dlActive.textContent = String(progress.downloading || 0);
  el.dlWait.textContent = String(progress.waiting || 0);
  el.dlRetry.textContent = String(progress.retry || 0);
  el.dlPerm.textContent = String(progress.permanent || 0);
  if (el.dlSkipNote) {
    el.dlSkipNote.textContent = `Пропущено из-за языка аудио: ${progress.skipped || 0}`;
  }
  const total = progress.total || 0;
  const done = progress.completed || 0;
  el.dlOverallPercent.textContent = `${done} / ${total}`;
  el.dlOverallBar.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
  const active = Array.isArray(progress.active) ? progress.active : [];
  const current = progress.current;
  if (active.length > 1) {
    const avg = active.reduce((sum, entry) => sum + (Number(entry.percent) || 0), 0) / active.length;
    el.dlCurrentLabel.textContent =
      `Качается ${active.length}: ` +
      active.map((entry) => `#${entry.number} ${Math.round(entry.percent || 0)}%`).join(' · ');
    el.dlFilePercent.textContent = `${Math.round(avg)}%`;
    el.dlFileBar.style.width = `${Math.min(100, avg)}%`;
    el.dlSpeedNote.textContent =
      `Скорость: ${progress.totalSpeed || '—'} суммарно · потоков ${active.length} из ${progress.concurrency || active.length}`;
  } else if (current) {
    el.dlCurrentLabel.textContent = `Downloading #${current.number}  ${current.title || ''}`;
    el.dlFilePercent.textContent = `${Math.round(current.percent || 0)}%`;
    el.dlFileBar.style.width = `${Math.min(100, current.percent || 0)}%`;
    el.dlSpeedNote.textContent = `Скорость: ${current.speed || '—'} · ETA: ${current.eta || '—'}`;
    if (current.resolution || current.quality) {
      el.dlQualityNote.textContent =
        `Качество сейчас: ${current.resolution || current.quality}${current.fps ? ` ${current.fps}FPS` : ''}`;
    }
  }
  if (progress.status) el.dlStatus.textContent = progress.status;
  const lastOk = (progress.items || []).slice().reverse().find((item) => item.status === 'SUCCESS');
  if (lastOk) {
    el.dlQualityNote.textContent =
      `✓ SUCCESS  ${lastOk.resolution || lastOk.quality || ''}  ` +
      `${lastOk.fps ? `${lastOk.fps} FPS` : ''}  ` +
      `${lastOk.videoCodec || ''} / ${lastOk.audioCodec || ''}  ` +
      `${lastOk.fileSize ? `${Math.round(lastOk.fileSize / 1024 / 1024 * 10) / 10} MB` : ''}`.replace(/\s+/g, ' ').trim();
  }
  renderDownloadTableIfChanged(progress.items);
  const errorsSignature = JSON.stringify(progress.errors || []);
  if (errorsSignature !== state.downloadErrorsSignature) {
    state.downloadErrorsSignature = errorsSignature;
    renderDownloadErrors(progress.errors);
  }
}

async function refreshDownloadQueue() {
  const folder = el.dlDir.value.trim();
  el.dlOpen.disabled = !folder;
  if (!folder || !window.api.loadDownloadQueue) return;
  const result = await window.api.loadDownloadQueue(folder);
  if (!result || !result.ok) {
    if (result && result.error) el.dlDirNote.textContent = result.error;
    return;
  }
  if (result.note) el.dlDirNote.textContent = result.note;
  if (result.urls && result.urls.length && !el.dlLinks.value.trim()) {
    el.dlLinks.value = result.urls.join('\n');
  }
  if (Array.isArray(result.audioOptions) && result.audioOptions.length) {
    AUDIO_LANG_OPTIONS = result.audioOptions;
  }
  applyDownloadProgress(result.progress);

  // «Определять автоматически»: для новых видео сразу узнаём доступные дорожки.
  if (el.dlAudioDetect && el.dlAudioDetect.checked && !state.downloading && window.api.detectDownloadAudio) {
    const pending = state.downloadItems.filter((item) => !item.audioChecked);
    if (pending.length) {
      el.dlStatus.textContent = `Проверяем аудиодорожки: ${pending.length}…`;
      const detected = await window.api.detectDownloadAudio({ outputDir: folder, onlyUnchecked: true });
      if (detected && detected.ok && detected.progress) applyDownloadProgress(detected.progress);
      else if (detected && detected.error) appendDownloadLog('warn', detected.error);
    }
  }
}

function bindDownloadUi() {
  document.querySelectorAll('#app-tabs .tab').forEach((button) => {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      document.querySelectorAll('#app-tabs .tab').forEach((tab) => tab.classList.toggle('is-active', tab === button));
      el.viewInsert.hidden = view !== 'insert';
      el.viewDownload.hidden = view !== 'download';
      if (el.viewRename) el.viewRename.hidden = view !== 'rename';
    });
  });

  el.dlLinks.addEventListener('change', saveSettings);

  if (el.dlAudioLang) {
    el.dlAudioLang.addEventListener('change', () => {
      if (el.dlAudioLangOther) el.dlAudioLangOther.hidden = el.dlAudioLang.value !== 'other';
      if (el.dlBulkLang && el.dlAudioLang.value !== 'other') el.dlBulkLang.value = el.dlAudioLang.value;
      saveSettings();
      el.dlStatus.textContent = `Язык аудио по умолчанию: ${audioLangLabel(currentDefaultAudioLang())} (для новых ссылок)`;
    });
  }
  if (el.dlAudioLangOther) el.dlAudioLangOther.addEventListener('change', saveSettings);
  if (el.dlAudioDetect) el.dlAudioDetect.addEventListener('change', saveSettings);
  if (el.dlParallel) el.dlParallel.addEventListener('change', saveSettings);

  if (el.dlAudioDetectNow) {
    el.dlAudioDetectNow.addEventListener('click', async () => {
      const outputDir = el.dlDir.value.trim();
      if (!outputDir) {
        el.dlStatus.textContent = 'Сначала выберите папку для скачивания.';
        return;
      }
      if (!window.api.detectDownloadAudio) return;
      const numbers = Array.from(state.dlSelection);
      el.dlAudioDetectNow.disabled = true;
      el.dlStatus.textContent = 'Проверяем доступные аудиодорожки…';
      try {
        const result = await window.api.detectDownloadAudio({ outputDir, numbers });
        if (!result || !result.ok) {
          appendDownloadLog('error', (result && result.error) || 'Не удалось проверить аудиодорожки.');
          return;
        }
        if (result.progress) applyDownloadProgress(result.progress);
      } finally {
        el.dlAudioDetectNow.disabled = false;
      }
    });
  }

  if (el.dlSelectAll) {
    el.dlSelectAll.addEventListener('change', () => {
      state.dlSelection.clear();
      if (el.dlSelectAll.checked) {
        state.downloadItems.forEach((item) => state.dlSelection.add(Number(item.number)));
      }
      renderDownloadTable(state.downloadItems);
    });
  }
  if (el.dlSelectAllBtn) {
    el.dlSelectAllBtn.addEventListener('click', () => {
      state.downloadItems.forEach((item) => state.dlSelection.add(Number(item.number)));
      renderDownloadTable(state.downloadItems);
    });
  }
  if (el.dlSelectNone) {
    el.dlSelectNone.addEventListener('click', () => {
      state.dlSelection.clear();
      renderDownloadTable(state.downloadItems);
    });
  }
  if (el.dlSelectLang) {
    el.dlSelectLang.addEventListener('click', () => {
      const lang = el.dlBulkLang ? el.dlBulkLang.value : 'auto';
      state.dlSelection.clear();
      state.downloadItems.forEach((item) => {
        if (itemHasAudioLang(item, lang)) state.dlSelection.add(Number(item.number));
      });
      renderDownloadTable(state.downloadItems);
      el.dlStatus.textContent = `Отмечено видео с языком ${audioLangLabel(lang)}: ${state.dlSelection.size}`;
    });
  }
  if (el.dlSetLang) {
    el.dlSetLang.addEventListener('click', async () => {
      const lang = el.dlBulkLang ? el.dlBulkLang.value : 'auto';
      await setAudioLangFor(Array.from(state.dlSelection), lang);
    });
  }
  el.dlDir.addEventListener('change', async () => {
    saveSettings();
    await refreshDownloadQueue();
  });

  el.dlClear.addEventListener('click', () => {
    el.dlLinks.value = '';
    saveSettings();
    el.dlLinksNote.textContent = 'Список очищен.';
  });

  el.dlImport.addEventListener('click', async () => {
    const result = await window.api.importDownloadTxt();
    if (!result || !result.ok) return;
    const current = el.dlLinks.value.trim();
    el.dlLinks.value = current ? `${current}\n${result.text}` : result.text;
    const parsed = await window.api.parseDownloadLinks(el.dlLinks.value);
    if (parsed && parsed.ok) {
      el.dlLinks.value = parsed.urls.join('\n');
      el.dlLinksNote.textContent = `Импортировано ссылок: ${parsed.urls.length}`;
    }
    saveSettings();
  });

  el.dlPickDir.addEventListener('click', async () => {
    const picked = await window.api.pickDirectory({
      title: 'Папка для скачанных видео',
      defaultPath: el.dlDir.value.trim()
    });
    if (!picked) return;
    el.dlDir.value = picked;
    saveSettings();
    await refreshDownloadQueue();
  });

  el.dlOpen.addEventListener('click', async () => {
    const target = el.dlDir.value.trim();
    if (!target) return;
    const result = await window.api.openPath(target);
    if (!result.ok) appendDownloadLog('error', `Не удалось открыть папку: ${result.error}`);
  });

  el.dlStart.addEventListener('click', async () => {
    if (state.downloading || state.dlStarting) return;
    state.dlStarting = true;
    try {
      await startDownload();
    } finally {
      state.dlStarting = false;
    }
  });

  async function startDownload() {
    const outputDir = el.dlDir.value.trim();
    const text = el.dlLinks.value;
    if (!outputDir) {
      el.dlStatus.textContent = 'Не выбрана папка для сохранения.';
      appendDownloadLog('error', 'Не выбрана папка для сохранения.');
      return;
    }
    if (!text.trim()) {
      el.dlStatus.textContent = 'Список ссылок пуст.';
      appendDownloadLog('error', 'Список ссылок пуст.');
      return;
    }
    saveSettings();
    await reportFolders();
    const conflict = conflictFor('downloadDir');
    if (conflict) {
      const message = `Папка «${conflict.path}» занята вкладкой ${conflict.otherName}. Выберите для этой вкладки свою папку.`;
      el.dlStatus.textContent = message;
      appendDownloadLog('error', message);
      return;
    }
    setDownloadRunning(true, false);
    el.dlBadge.textContent = 'Скачивание';
    el.dlBadge.className = 'badge badge--running';
    el.dlStatus.textContent = 'Запускаем очередь…';
    appendDownloadLog('info', '— Запуск скачивания —');
    const result = await window.api.startDownload({
      outputDir,
      text,
      defaultAudioLang: currentDefaultAudioLang(),
      audioLangs: state.audioLangByNumber,
      concurrency: el.dlParallel ? Number(el.dlParallel.value) : 3
    });
    if (result && !result.ok && !result.reported) {
      setDownloadRunning(false, false);
      el.dlBadge.textContent = 'Ошибка';
      el.dlBadge.className = 'badge badge--error';
      el.dlStatus.textContent = result.error || 'Не удалось запустить очередь.';
      appendDownloadLog('error', result.error || 'Не удалось запустить очередь.');
    }
  }

  el.dlPause.addEventListener('click', async () => {
    const result = await window.api.pauseDownload();
    if (!result || !result.ok) return;
    setDownloadRunning(true, true);
    el.dlBadge.textContent = 'Пауза';
    el.dlBadge.className = 'badge badge--error';
  });

  el.dlResume.addEventListener('click', async () => {
    const result = await window.api.resumeDownload();
    if (!result || !result.ok) return;
    setDownloadRunning(true, false);
    el.dlBadge.textContent = 'Скачивание';
    el.dlBadge.className = 'badge badge--running';
  });

  el.dlStop.addEventListener('click', async () => {
    await window.api.stopDownload();
    el.dlStatus.textContent = 'Останавливаем очередь…';
  });

  el.dlCopyLog.addEventListener('click', async () => {
    if (!state.downloadLog.length) return;
    try {
      await navigator.clipboard.writeText(state.downloadLog.join('\n'));
      appendDownloadLog('info', 'Лог скопирован в буфер обмена.');
    } catch (err) {
      appendDownloadLog('error', `Не удалось скопировать лог: ${err.message}`);
    }
  });

  el.dlClearLog.addEventListener('click', () => {
    state.downloadLog = [];
    el.dlLog.innerHTML = '<p class="log__empty">Лог очищен.</p>';
  });

  window.api.onDownloadLog(({ level, message }) => appendDownloadLog(level, message));
  window.api.onDownloadProgress((progress) => applyDownloadProgress(progress));
  window.api.onDownloadState(({ running, paused }) => setDownloadRunning(Boolean(running), Boolean(paused)));
  window.api.onDownloadDone((payload) => {
    const summary = payload.summary || {};
    const paused = Boolean(summary.cancelled);
    setDownloadRunning(false, false);
    el.dlStop.disabled = true;
    if (!payload.ok) {
      el.dlBadge.textContent = 'Ошибка';
      el.dlBadge.className = 'badge badge--error';
      el.dlStatus.textContent = payload.error || 'Очередь завершилась с ошибкой.';
      return;
    }
    if (summary.complete) {
      el.dlBadge.textContent = 'Готово';
      el.dlBadge.className = 'badge badge--done';
      el.dlStatus.textContent =
        `DOWNLOAD COMPLETE  Success: ${summary.completed} / ${summary.total}` +
        `${summary.permanent ? `  Permanent: ${summary.permanent}` : ''}`;
      appendDownloadLog('success', `— Скачивание завершено. Готово: ${summary.completed}, постоянных ошибок: ${summary.permanent || 0} —`);
    } else if (paused) {
      el.dlBadge.textContent = 'Остановлено';
      el.dlBadge.className = 'badge badge--error';
      el.dlStatus.textContent = `Остановлено. Готово: ${summary.completed} из ${summary.total}.`;
    } else {
      el.dlBadge.textContent = 'Retry';
      el.dlBadge.className = 'badge badge--running';
      el.dlStatus.textContent = `${summary.retry || 0} videos waiting for automatic retry...`;
    }
  });
}

function appendRenameLog(level, message) {
  const time = timeLabel();
  const emptyHint = el.rnLog.querySelector('.log__empty');
  if (emptyHint) emptyHint.remove();
  const row = document.createElement('div');
  row.className = `log__row log__row--${level || 'info'}`;
  const timeNode = document.createElement('span');
  timeNode.className = 'log__time';
  timeNode.textContent = time;
  const textNode = document.createElement('span');
  textNode.className = 'log__text';
  textNode.textContent = message;
  row.append(timeNode, textNode);
  el.rnLog.appendChild(row);
  el.rnLog.scrollTop = el.rnLog.scrollHeight;
}

function renderRenameTable(rows) {
  el.rnTableBody.innerHTML = '';
  if (!rows || !rows.length) {
    const empty = document.createElement('tr');
    empty.className = 'queue-table__empty';
    empty.innerHTML = '<td colspan="5">Сначала сделайте предпросмотр</td>';
    el.rnTableBody.appendChild(empty);
    return;
  }
  rows.forEach((item) => {
    const tr = document.createElement('tr');
    if (item.status === 'MATCH' || item.status === 'ALREADY_OK') tr.className = 'is-success';
    else if (item.status === 'LOW_SCORE') tr.className = 'is-retry';
    else if (item.status === 'CONFLICT') tr.className = 'is-error';
    [item.video, item.txtNumber || '—', item.txtTitle || '—', `${item.score}%`, item.status]
      .forEach((value) => {
        const td = document.createElement('td');
        td.textContent = String(value);
        tr.appendChild(td);
      });
    el.rnTableBody.appendChild(tr);
  });
}

function showRenameAnalysis(analysis) {
  const summary = analysis.summary || {};
  el.rnTitles.textContent = String(summary.titles || 0);
  el.rnVideos.textContent = String(summary.videos || 0);
  el.rnMatched.textContent = String(summary.matched || 0);
  el.rnLow.textContent = String(summary.lowSimilarity || 0);
  el.rnConflict.textContent = String(summary.conflicts || 0);
  el.rnMissing.textContent = String(summary.missing || 0);
  el.rnDirNote.textContent = `Видео найдено: ${summary.videos || 0}`;
  el.rnTxtNote.textContent = `Названий в TXT: ${summary.titles || 0}`;
  const toDelete = el.rnRemove.checked ? (summary.unmatched || 0) : 0;
  el.rnDeleteNote.textContent = toDelete
    ? `Будет удалено видео без совпадения: ${toDelete}. Исходный nazvaniya.txt не трогаем.`
    : 'Несопоставленные видео не удаляются. Исходный nazvaniya.txt не трогаем.';
  renderRenameTable(analysis.rows);
  el.rnApply.disabled = !(summary.matched || summary.unmatched);
  el.rnOpenDir.disabled = !el.rnDir.value.trim();
}

function bindRenameUi() {
  const updateMin = () => {
    el.rnMinValue.textContent = `${el.rnMin.value}%`;
  };
  updateMin();
  el.rnMin.addEventListener('input', () => {
    updateMin();
    saveSettings();
  });
  [el.rnRemove, el.rnReports, el.rnKeepTxt, el.rnDir, el.rnTxt].filter(Boolean).forEach((node) => {
    node.addEventListener('change', saveSettings);
  });

  el.rnPickDir.addEventListener('click', async () => {
    const picked = await window.api.pickDirectory({
      title: 'Папка с видео для умного переименования',
      defaultPath: el.rnDir.value.trim()
    });
    if (!picked) return;
    el.rnDir.value = picked;
    const detected = await window.api.detectRenameTxt(picked);
    if (detected && detected.ok && detected.file && !el.rnTxt.value.trim()) {
      el.rnTxt.value = detected.file;
    }
    saveSettings();
    el.rnOpenDir.disabled = false;
    appendRenameLog('info', `Папка: ${picked}`);
  });

  el.rnPickTxt.addEventListener('click', async () => {
    const picked = await window.api.pickRenameTxt({ defaultPath: el.rnTxt.value.trim() || el.rnDir.value.trim() });
    if (!picked) return;
    el.rnTxt.value = picked;
    saveSettings();
    appendRenameLog('info', `TXT: ${picked}`);
  });

  el.rnPreview.addEventListener('click', async () => {
    const directory = el.rnDir.value.trim();
    const titlesFile = el.rnTxt.value.trim();
    if (!directory || !titlesFile) {
      el.rnStatus.textContent = 'Выберите папку и nazvaniya.txt.';
      appendRenameLog('error', 'Не выбрана папка или TXT.');
      return;
    }
    saveSettings();
    el.rnStatus.textContent = 'Считаем совпадения…';
    const result = await window.api.analyzeRename({
      directory,
      titlesFile,
      minScore: Number(el.rnMin.value)
    });
    if (!result.ok) {
      el.rnBadge.textContent = 'Ошибка';
      el.rnBadge.className = 'badge badge--error';
      el.rnStatus.textContent = result.error;
      appendRenameLog('error', result.error);
      return;
    }
    state.renamePreview = result.analysis;
    showRenameAnalysis(result.analysis);
    el.rnBadge.textContent = 'Предпросмотр';
    el.rnBadge.className = 'badge badge--running';
    el.rnStatus.textContent =
      `Предпросмотр: совпало ${result.analysis.summary.matched}, слабо ${result.analysis.summary.lowSimilarity}, ` +
      `конфликтов ${result.analysis.summary.conflicts}, нет видео для ${result.analysis.summary.missing} названий.`;
    appendRenameLog('info', `Предпросмотр готов. Совпало ${result.analysis.summary.matched} из ${result.analysis.summary.videos}.`);
    (result.analysis.rows || []).forEach((row) => {
      if (row.status === 'MATCH' || row.status === 'ALREADY_OK') {
        appendRenameLog('success', `✓ ${row.video} → ${row.newName} (${row.score}%)`);
      } else if (row.status === 'CONFLICT') {
        appendRenameLog('error', `✗ ${row.video} — ${row.reason}`);
      } else if (row.status === 'LOW_SCORE') {
        appendRenameLog('warn', `⚠ ${row.video} — low similarity ${row.score}%`);
      } else {
        appendRenameLog('warn', `⚠ ${row.video} — not matched`);
      }
    });
    (result.analysis.missing || []).forEach((title) => {
      appendRenameLog('warn', `⚠ ${title.number} — video not found`);
    });
  });

  el.rnApply.addEventListener('click', async () => {
    const directory = el.rnDir.value.trim();
    const titlesFile = el.rnTxt.value.trim();
    if (!directory || !titlesFile) return;
    if (el.rnRemove.checked) {
      const unmatched = state.renamePreview && state.renamePreview.summary
        ? state.renamePreview.summary.unmatched
        : 0;
      if (unmatched && !window.confirm(`Удалить ${unmatched} видео без совпадения? Это нельзя отменить.`)) {
        return;
      }
    }
    el.rnApply.disabled = true;
    el.rnStatus.textContent = 'Переименовываем…';
    const result = await window.api.applyRename({
      directory,
      titlesFile,
      minScore: Number(el.rnMin.value),
      removeUnmatchedVideos: el.rnRemove.checked,
      createReports: el.rnReports.checked,
      keepOriginalTxt: el.rnKeepTxt.checked
    });
    if (!result.ok) {
      el.rnApply.disabled = false;
      el.rnBadge.textContent = 'Ошибка';
      el.rnBadge.className = 'badge badge--error';
      el.rnStatus.textContent = result.error;
      appendRenameLog('error', result.error);
      return;
    }
    state.renameReport = result.reportFile;
    showRenameAnalysis(result.analysis);
    el.rnBadge.textContent = 'Готово';
    el.rnBadge.className = 'badge badge--done';
    const s = result.summary || {};
    el.rnStatus.textContent =
      `RESULT  TXT: ${s.titles}  Videos: ${s.videos}  Matched: ${s.matched}  Renamed: ${s.renamed}  ` +
      `Low: ${s.lowSimilarity}  Conflicts: ${s.conflicts}  Missing: ${s.missing}  Unmatched: ${s.unmatched}`;
    (result.logs || []).forEach((line) => {
      const level = line.startsWith('✓') ? 'success' : line.startsWith('✗') ? 'error' : 'warn';
      appendRenameLog(level, line);
    });
    el.rnOpenReport.disabled = !result.reportFile;
    el.rnOpenDir.disabled = false;
    el.rnApply.disabled = false;
  });

  el.rnOpenReport.addEventListener('click', async () => {
    if (!state.renameReport) return;
    await window.api.openPath(state.renameReport);
  });

  el.rnOpenDir.addEventListener('click', async () => {
    const target = el.rnDir.value.trim();
    if (target) await window.api.openPath(target);
  });
}

// ------------------------------------------------------- Очистка очередей

function resetRenderQueueUi() {
  setProgress(0, 0);
  el.counterDone.textContent = '0';
  el.counterFailed.textContent = '0';
  el.counterTotal.textContent = '0';
  if (el.encodeMeta) el.encodeMeta.textContent = 'Кодек: — · Формат: — · FPS: — · ETA: —';
  setBadge('Ожидание');
  el.status.textContent = 'Очередь рендера очищена.';
}

async function clearRenderQueue() {
  if (state.running) {
    appendLog('warn', 'Сначала остановите обработку — очередь рендера занята.');
    return;
  }
  const ok = window.confirm('Очистить очередь рендера? Счётчики и лог будут сброшены, незавершённые файлы результата удалены. Готовые видео останутся на месте.');
  if (!ok) return;
  el.clearRenderQueue.disabled = true;
  try {
    const result = await window.api.clearRenderQueue({
      outputDir: el.outputDir.value.trim()
    });
    if (!result || !result.ok) {
      appendLog('error', (result && result.error) || 'Не удалось очистить очередь рендера.');
      return;
    }
    clearLog();
    resetRenderQueueUi();
    appendLog('info', `Очередь рендера очищена. Удалено незавершённых/временных файлов: ${result.removed || 0}.`);
    await refreshAllInfo();
  } catch (err) {
    appendLog('error', `Ошибка очистки очереди рендера: ${err.message}`);
  } finally {
    el.clearRenderQueue.disabled = false;
  }
}

async function clearDownloadQueue() {
  if (state.downloading) {
    appendDownloadLog('warn', 'Сначала остановите скачивание — очередь занята.');
    return;
  }
  const outputDir = el.dlDir.value.trim();
  if (!outputDir) {
    appendDownloadLog('error', 'Не выбрана папка для скачивания.');
    return;
  }
  const ok = window.confirm('Очистить очередь скачивания? Список ссылок, download_queue.json и лог будут удалены. Скачанные видео и nazvaniya.txt останутся на месте.');
  if (!ok) return;
  el.dlClearQueue.disabled = true;
  try {
    const result = await window.api.clearDownloadQueue({ outputDir, clearLog: true });
    if (!result || !result.ok) {
      appendDownloadLog('error', (result && result.error) || 'Не удалось очистить очередь.');
      return;
    }
    el.dlLinks.value = '';
    saveSettings();
    applyDownloadProgress({
      total: 0,
      completed: 0,
      downloading: 0,
      waiting: 0,
      retry: 0,
      permanent: 0,
      overallPercent: 0,
      items: [],
      errors: [],
      status: 'Очередь очищена.'
    });
    el.dlFileBar.style.width = '0%';
    el.dlFilePercent.textContent = '0%';
    el.dlCurrentLabel.textContent = 'Текущее видео';
    el.dlSpeedNote.textContent = 'Скорость: — · ETA: —';
    el.dlQualityNote.textContent = 'Качество последнего файла: —';
    el.dlBadge.textContent = 'Ожидание';
    el.dlBadge.className = 'badge';
    el.dlLinksNote.textContent = 'Очередь и список ссылок очищены.';
    state.downloadLog = [];
    el.dlLog.innerHTML = '<p class="log__empty">Лог очищен.</p>';
    appendDownloadLog('info', `Очередь скачивания очищена. Удалено файлов очереди: ${result.removedFiles || 0}.`);
  } catch (err) {
    appendDownloadLog('error', `Ошибка очистки очереди: ${err.message}`);
  } finally {
    el.dlClearQueue.disabled = false;
  }
}

function bindQueueCleanupUi() {
  if (el.clearRenderQueue) el.clearRenderQueue.addEventListener('click', clearRenderQueue);
  if (el.dlClearQueue) el.dlClearQueue.addEventListener('click', clearDownloadQueue);
}
