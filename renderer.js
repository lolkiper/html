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
  chipYtdlp: document.getElementById('chip-ytdlp'),

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
  rnCopyright: document.getElementById('rn-copyright'),
  viewCopyright: document.getElementById('view-copyright'),
  ccClientId: document.getElementById('cc-client-id'),
  ccClientSecret: document.getElementById('cc-client-secret'),
  ccConnect: document.getElementById('cc-connect'),
  ccDisconnect: document.getElementById('cc-disconnect'),
  ccStatus: document.getElementById('cc-status'),
  ccDir: document.getElementById('cc-dir'),
  ccDirNote: document.getElementById('cc-dir-note'),
  ccPickDir: document.getElementById('cc-pick-dir'),
  ccEnabled: document.getElementById('cc-enabled'),
  ccAutoDelete: document.getElementById('cc-auto-delete'),
  ccWait: document.getElementById('cc-wait'),
  ccStart: document.getElementById('cc-start'),
  ccStop: document.getElementById('cc-stop'),
  ccRetry: document.getElementById('cc-retry'),
  ccRetryAll: document.getElementById('cc-retry-all'),
  ccOpen: document.getElementById('cc-open'),
  ccBadge: document.getElementById('cc-badge'),
  ccStatusLine: document.getElementById('cc-status-line'),
  ccTotal: document.getElementById('cc-total'),
  ccNoclaim: document.getElementById('cc-noclaim'),
  ccClaims: document.getElementById('cc-claims'),
  ccBlocked: document.getElementById('cc-blocked'),
  ccProcessing: document.getElementById('cc-processing'),
  ccErrors: document.getElementById('cc-errors'),
  ccKept: document.getElementById('cc-kept'),
  ccDeleted: document.getElementById('cc-deleted'),
  ccTableBody: document.getElementById('cc-table-body'),
  ccLog: document.getElementById('cc-log'),
  ccCopyLog: document.getElementById('cc-copy-log'),
  ccClearLog: document.getElementById('cc-clear-log')
};

const state = {
  running: false,
  logLines: [],
  downloading: false,
  downloadLog: [],
  renamePreview: null,
  renameReport: null,
  copyrighting: false,
  copyrightLog: []
};

const CLOSEUP_HINT = 'Для каждого следующего ролика крупный план продолжается с того места, где закончился предыдущий. Если видео кончится — начнётся сначала. Звук берётся из основного ролика.';
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
    el.percent, el.percentRange, el.encoder, el.exportMode, el.resourceUsage, el.frame, el.fit, el.useOverlay,
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
  el.splitPreviewSeam.style.flexBasis = `${Math.max(4, Math.round(feather * 0.7))}px`;

  const canvasWidth = 1080;
  const pixels = Math.round((canvasWidth * leftOffset) / 100);
  el.splitHint.textContent =
    `Итог — квадрат 1080×1080. Сдвиг ${signedPercent(leftOffset)} это ` +
    `${pixels} px; ноль ставит центр ролика в центр своей половины.`;
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
    exportMode: el.exportMode ? el.exportMode.value : 'auto',
    resourceUsage: el.resourceUsage ? el.resourceUsage.value : 'balanced',
    frame: el.frame.value,
    fit: el.fit.value,
    verbose: el.verbose.checked,
    downloadDir: el.dlDir.value.trim(),
    downloadLinks: el.dlLinks.value,
    renameDir: el.rnDir.value.trim(),
    renameTxt: el.rnTxt.value.trim(),
    renameMin: Number(el.rnMin.value),
    renameRemove: el.rnRemove.checked,
    renameReports: el.rnReports.checked,
    renameKeepTxt: el.rnKeepTxt.checked,
    copyrightDir: el.ccDir ? el.ccDir.value.trim() : '',
    copyrightClientId: el.ccClientId ? el.ccClientId.value.trim() : '',
    copyrightClientSecret: el.ccClientSecret ? el.ccClientSecret.value : '',
    copyrightCheckEnabled: el.ccEnabled ? el.ccEnabled.checked : false,
    copyrightAutoDeleteUploads: el.ccAutoDelete ? el.ccAutoDelete.checked : false,
    copyrightMaxWaitMinutes: el.ccWait ? Number(el.ccWait.value) || 15 : 15
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
  }
  el.frame.value = saved.frame && saved.frame !== 'source' ? saved.frame : 'square1080';
  if (saved.fit) el.fit.value = saved.fit;
  if (saved.downloadDir) el.dlDir.value = saved.downloadDir;
  if (saved.downloadLinks) el.dlLinks.value = saved.downloadLinks;
  if (saved.renameDir) el.rnDir.value = saved.renameDir;
  if (saved.renameTxt) el.rnTxt.value = saved.renameTxt;
  if (Number.isFinite(saved.renameMin)) el.rnMin.value = saved.renameMin;
  if (saved.renameRemove != null) el.rnRemove.checked = Boolean(saved.renameRemove);
  if (saved.renameReports != null) el.rnReports.checked = Boolean(saved.renameReports);
  if (saved.renameKeepTxt != null) el.rnKeepTxt.checked = Boolean(saved.renameKeepTxt);
  if (el.ccDir && saved.copyrightDir) el.ccDir.value = saved.copyrightDir;
  else if (el.ccDir && saved.renameDir) el.ccDir.value = saved.renameDir;
  else if (el.ccDir && saved.downloadDir) el.ccDir.value = saved.downloadDir;
  if (el.ccClientId && saved.copyrightClientId) el.ccClientId.value = saved.copyrightClientId;
  if (el.ccClientSecret && saved.copyrightClientSecret) el.ccClientSecret.value = saved.copyrightClientSecret;
  if (el.ccEnabled) el.ccEnabled.checked = Boolean(saved.copyrightCheckEnabled);
  if (el.rnCopyright) el.rnCopyright.checked = Boolean(saved.copyrightCheckEnabled);
  if (el.ccAutoDelete) el.ccAutoDelete.checked = Boolean(saved.copyrightAutoDeleteUploads);
  if (el.ccWait && Number.isFinite(saved.copyrightMaxWaitMinutes)) el.ccWait.value = saved.copyrightMaxWaitMinutes;
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
  fillSelect(el.frame, info.frames);
  fillSelect(el.fit, info.fits);

  el.encoder.value = info.defaults.encoder;
  if (el.exportMode) el.exportMode.value = info.defaults.exportMode || 'auto';
  if (el.resourceUsage) el.resourceUsage.value = info.defaults.resourceUsage || 'balanced';
  el.frame.value = info.defaults.frame;
  el.fit.value = info.defaults.fit;
  el.percent.value = info.defaults.percent;
  el.percentRange.value = info.defaults.percent;

  const hardware = info.hardware || {};
  if (el.accelNote) {
    if (hardware.gpu) {
      el.accelNote.textContent =
        `Hardware Encoder: ${hardware.gpu}. Склейка на CPU, кодирование на GPU, один ffmpeg на файл.`;
    } else if (hardware.compiledGpu && hardware.compiledGpu.length) {
      el.accelNote.textContent =
        `FFmpeg видит ${hardware.compiledGpu.join(', ')}, но тест кадра не прошёл` +
        (hardware.probeError ? ` (${hardware.probeError})` : '') +
        `. Будет software veryfast, не все ядра.`;
    } else {
      el.accelNote.textContent =
        'Видеокарта недоступна — software veryfast на нескольких потоках, без 100% всех ядер.';
    }
  }

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
  updateSplitState();
  updateSplitControls();
  updateScheme();

  el.openOutput.disabled = !el.outputDir.value.trim();
  refreshAllInfo();
  bindDownloadUi();
  bindRenameUi();
  bindCopyrightUi();
  await refreshDownloadQueue();
  await refreshCopyrightStatus();
  await refreshCopyrightQueue();

  appendLog('info', 'Приложение готово. Выберите папки и файлы, затем нажмите «Начать обработку».');
})();

// ------------------------------------------------------- Скачивание YouTube

function setDownloadRunning(running, paused = false) {
  state.downloading = running;
  el.dlStart.disabled = running;
  el.dlPause.disabled = !running || paused;
  el.dlResume.disabled = !running || !paused;
  el.dlStop.disabled = !running;
  el.dlImport.disabled = running;
  el.dlPickDir.disabled = running;
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

function renderDownloadTable(items) {
  el.dlTableBody.innerHTML = '';
  if (!items || !items.length) {
    const row = document.createElement('tr');
    row.className = 'queue-table__empty';
    row.innerHTML = '<td colspan="6">Список пуст</td>';
    el.dlTableBody.appendChild(row);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('tr');
    if (item.status === 'SUCCESS') row.className = 'is-success';
    else if (item.status === 'RETRY') row.className = 'is-retry';
    else if (item.status === 'PERMANENT_ERROR') row.className = 'is-error';
    else if (item.status === 'DOWNLOADING') row.className = 'is-run';
    const cells = [
      item.number,
      item.url,
      item.status,
      item.title || '—',
      item.quality || 'AUTO',
      item.attempts || 0
    ];
    cells.forEach((value) => {
      const td = document.createElement('td');
      td.textContent = String(value);
      row.appendChild(td);
    });
    el.dlTableBody.appendChild(row);
  });
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
  const total = progress.total || 0;
  const done = progress.completed || 0;
  el.dlOverallPercent.textContent = `${done} / ${total}`;
  el.dlOverallBar.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
  const current = progress.current;
  if (current) {
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
  renderDownloadTable(progress.items);
  renderDownloadErrors(progress.errors);
}

async function refreshDownloadQueue() {
  const folder = el.dlDir.value.trim();
  el.dlOpen.disabled = !folder;
  if (!folder || !window.api.loadDownloadQueue) return;
  const result = await window.api.loadDownloadQueue(folder);
  if (!result || !result.ok) return;
  if (result.note) el.dlDirNote.textContent = result.note;
  if (result.urls && result.urls.length && !el.dlLinks.value.trim()) {
    el.dlLinks.value = result.urls.join('\n');
  }
  applyDownloadProgress(result.progress);
}

function bindDownloadUi() {
  document.querySelectorAll('#app-tabs .tab').forEach((button) => {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      document.querySelectorAll('#app-tabs .tab').forEach((tab) => tab.classList.toggle('is-active', tab === button));
      el.viewInsert.hidden = view !== 'insert';
      el.viewDownload.hidden = view !== 'download';
      if (el.viewRename) el.viewRename.hidden = view !== 'rename';
      if (el.viewCopyright) el.viewCopyright.hidden = view !== 'copyright';
    });
  });

  el.dlLinks.addEventListener('change', saveSettings);
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
    setDownloadRunning(true, false);
    el.dlBadge.textContent = 'Скачивание';
    el.dlBadge.className = 'badge badge--running';
    el.dlStatus.textContent = 'Запускаем очередь…';
    appendDownloadLog('info', '— Запуск скачивания —');
    const result = await window.api.startDownload({ outputDir, text });
    if (!result.ok) {
      setDownloadRunning(false, false);
      el.dlBadge.textContent = 'Ошибка';
      el.dlBadge.className = 'badge badge--error';
      el.dlStatus.textContent = result.error || 'Не удалось запустить очередь.';
      appendDownloadLog('error', result.error || 'Не удалось запустить очередь.');
    }
  });

  el.dlPause.addEventListener('click', async () => {
    await window.api.pauseDownload();
    setDownloadRunning(true, true);
    el.dlBadge.textContent = 'Пауза';
  });

  el.dlResume.addEventListener('click', async () => {
    await window.api.resumeDownload();
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
  [el.rnRemove, el.rnReports, el.rnKeepTxt, el.rnCopyright].filter(Boolean).forEach((node) => {
    node.addEventListener('change', () => {
      if (node === el.rnCopyright && el.ccEnabled) el.ccEnabled.checked = el.rnCopyright.checked;
      saveSettings();
    });
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
    const checkAfter = (el.ccEnabled && el.ccEnabled.checked) || (el.rnCopyright && el.rnCopyright.checked);
    if (checkAfter && result.keptFiles && result.keptFiles.length) {
      if (el.ccDir) el.ccDir.value = directory;
      saveSettings();
      appendRenameLog('info', `Copyright Check: ${result.keptFiles.length} файл(ов) после переименования.`);
      const tab = document.querySelector('#app-tabs .tab[data-view="copyright"]');
      if (tab) tab.click();
      await startCopyrightCheck(result.keptFiles);
    }
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

function copyrightMark(status, kind) {
  if (!status || status === 'PENDING' || status === 'UNKNOWN') return kind === 'action' ? '—' : '—';
  if (status === 'SUCCESS' || status === 'READY') return '✓';
  if (status === 'UPLOADING' || status === 'PROCESSING') return '...';
  if (status === 'ERROR' || status === 'TIMEOUT' || status === 'CHECK_ERROR') return 'ERROR';
  if (status === 'NO_CLAIM') return 'No claim';
  if (status === 'CLAIM') return 'Claim';
  if (status === 'BLOCKED') return kind === 'availability' ? 'Blocked' : 'Blocked';
  if (status === 'AVAILABLE') return 'Available';
  if (status === 'KEEP') return 'KEEP';
  if (status === 'DELETE') return 'DELETE';
  if (status === 'RETRY') return 'RETRY';
  if (status === 'WAIT') return 'WAIT';
  return status;
}

function showCopyrightChannel(payload) {
  if (!el.ccStatus) return;
  if (payload && payload.connected && payload.channel) {
    el.ccStatus.className = 'cc-status is-ok';
    el.ccStatus.textContent =
      `✓ Connected\nChannel: ${payload.channel.title || '—'}\nChannel ID: ${payload.channel.id || '—'}`;
  } else if (payload && payload.connected) {
    el.ccStatus.className = 'cc-status is-ok';
    el.ccStatus.textContent = '✓ Connected';
  } else {
    el.ccStatus.className = 'cc-status';
    el.ccStatus.textContent = payload && payload.error ? payload.error : 'Канал не подключён';
  }
}

async function refreshCopyrightStatus() {
  if (!window.api.copyrightStatus) return;
  const result = await window.api.copyrightStatus();
  showCopyrightChannel(result);
}

function renderCopyrightTable(items) {
  if (!el.ccTableBody) return;
  el.ccTableBody.innerHTML = '';
  if (!items || !items.length) {
    const row = document.createElement('tr');
    row.className = 'queue-table__empty';
    row.innerHTML = '<td colspan="7">Очередь пуста</td>';
    el.ccTableBody.appendChild(row);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('tr');
    if (item.action === 'KEEP' && item.checkComplete) row.className = 'is-success';
    else if (item.action === 'DELETE' && item.deleteVerified) row.className = 'is-error';
    else if (item.action === 'RETRY' || item.copyrightStatus === 'CHECK_ERROR') row.className = 'is-retry';
    else if (item.action === 'WAIT' || item.uploadStatus === 'UPLOADING' || item.processingStatus === 'PROCESSING') {
      row.className = 'is-run';
    }
    [
      item.id,
      item.filename,
      copyrightMark(item.uploadStatus),
      copyrightMark(item.processingStatus),
      copyrightMark(item.copyrightStatus, 'copyright'),
      copyrightMark(item.availabilityStatus, 'availability'),
      copyrightMark(item.action, 'action')
    ].forEach((value) => {
      const td = document.createElement('td');
      td.textContent = String(value);
      row.appendChild(td);
    });
    el.ccTableBody.appendChild(row);
  });
}

function applyCopyrightProgress(snapshot) {
  if (!snapshot) return;
  const stats = snapshot.stats || {};
  el.ccTotal.textContent = String(stats.total || 0);
  el.ccNoclaim.textContent = String(stats.noClaims || 0);
  el.ccClaims.textContent = String(stats.claims || 0);
  el.ccBlocked.textContent = String(stats.blocked || 0);
  el.ccProcessing.textContent = String(stats.processing || 0);
  el.ccErrors.textContent = String(stats.errors || 0);
  el.ccKept.textContent = String(stats.kept || 0);
  el.ccDeleted.textContent = String(stats.deleted || 0);
  renderCopyrightTable(snapshot.items);
  if (snapshot.current) {
    el.ccStatusLine.textContent =
      `#${snapshot.current.id} ${snapshot.current.filename} · ${snapshot.current.action}`;
  }
}

async function refreshCopyrightQueue() {
  const folder = el.ccDir && el.ccDir.value.trim();
  if (el.ccOpen) el.ccOpen.disabled = !folder;
  if (!folder || !window.api.loadCopyrightQueue) return;
  const result = await window.api.loadCopyrightQueue({ directory: folder });
  if (result && result.ok) applyCopyrightProgress(result.snapshot);
}

function setCopyrightRunning(running) {
  state.copyrighting = Boolean(running);
  if (el.ccStart) el.ccStart.disabled = Boolean(running);
  if (el.ccStop) el.ccStop.disabled = !running;
  if (el.ccConnect) el.ccConnect.disabled = Boolean(running);
  if (el.ccPickDir) el.ccPickDir.disabled = Boolean(running);
}

function appendCopyrightLog(level, message) {
  const text = String(message || '');
  state.copyrightLog.push(text);
  const emptyHint = el.ccLog.querySelector('.log__empty');
  if (emptyHint) emptyHint.remove();
  const atBottom = el.ccLog.scrollHeight - el.ccLog.scrollTop - el.ccLog.clientHeight < 60;
  const row = document.createElement('div');
  row.className = `log__row log__row--${level || 'info'}`;
  const textNode = document.createElement('span');
  textNode.className = 'log__text';
  textNode.textContent = text;
  row.appendChild(textNode);
  el.ccLog.appendChild(row);
  while (el.ccLog.childElementCount > MAX_LOG_ROWS) el.ccLog.removeChild(el.ccLog.firstChild);
  if (atBottom) el.ccLog.scrollTop = el.ccLog.scrollHeight;
}

async function startCopyrightCheck(files) {
  const directory = (el.ccDir && el.ccDir.value.trim()) || (el.rnDir && el.rnDir.value.trim());
  if (!directory) {
    el.ccStatusLine.textContent = 'Не выбрана папка с видео.';
    appendCopyrightLog('error', 'Не выбрана папка с видео.');
    return;
  }
  const clientId = el.ccClientId.value.trim();
  const clientSecret = el.ccClientSecret.value;
  if (!clientId || !clientSecret) {
    el.ccStatusLine.textContent = 'Укажите OAuth Client ID и Client Secret.';
    appendCopyrightLog('error', 'Нет OAuth Client ID / Secret.');
    return;
  }
  saveSettings();
  setCopyrightRunning(true);
  el.ccBadge.textContent = 'Проверка';
  el.ccBadge.className = 'badge badge--running';
  el.ccStatusLine.textContent = 'Загружаем private и ждём обработку YouTube…';
  appendCopyrightLog('info', '— Запуск Copyright Check —');
  const result = await window.api.startCopyrightCheck({
    directory,
    files,
    enqueueDirectory: !files,
    clientId,
    clientSecret,
    autoDeleteUploads: el.ccAutoDelete.checked,
    maxWaitMinutes: Number(el.ccWait.value) || 15
  });
  if (!result.ok) {
    setCopyrightRunning(false);
    el.ccBadge.textContent = 'Ошибка';
    el.ccBadge.className = 'badge badge--error';
    el.ccStatusLine.textContent = result.error || 'Не удалось запустить проверку.';
    appendCopyrightLog('error', result.error || 'Не удалось запустить проверку.');
  }
}

function bindCopyrightUi() {
  if (!el.ccStart) return;

  [el.ccClientId, el.ccClientSecret, el.ccWait].forEach((node) => {
    node.addEventListener('change', saveSettings);
  });
  el.ccEnabled.addEventListener('change', () => {
    if (el.rnCopyright) el.rnCopyright.checked = el.ccEnabled.checked;
    saveSettings();
  });
  el.ccAutoDelete.addEventListener('change', saveSettings);
  el.ccDir.addEventListener('change', async () => {
    saveSettings();
    await refreshCopyrightQueue();
  });

  el.ccPickDir.addEventListener('click', async () => {
    const picked = await window.api.pickDirectory({
      title: 'Папка для Copyright Check',
      defaultPath: el.ccDir.value.trim() || el.rnDir.value.trim() || el.dlDir.value.trim()
    });
    if (!picked) return;
    el.ccDir.value = picked;
    saveSettings();
    await refreshCopyrightQueue();
  });

  el.ccOpen.addEventListener('click', async () => {
    const target = el.ccDir.value.trim();
    if (target) await window.api.openPath(target);
  });

  el.ccConnect.addEventListener('click', async () => {
    const clientId = el.ccClientId.value.trim();
    const clientSecret = el.ccClientSecret.value;
    if (!clientId || !clientSecret) {
      showCopyrightChannel({ connected: false, error: 'Укажите Client ID и Client Secret из Google Cloud.' });
      return;
    }
    saveSettings();
    el.ccStatus.textContent = 'Откройте окно Google и подтвердите доступ…';
    const result = await window.api.connectCopyright({ clientId, clientSecret });
    showCopyrightChannel(result);
    if (!result.ok) appendCopyrightLog('error', result.error);
    else appendCopyrightLog('success', `Подключён канал ${result.channel && result.channel.title}`);
  });

  el.ccDisconnect.addEventListener('click', async () => {
    const result = await window.api.disconnectCopyright();
    showCopyrightChannel(result);
    appendCopyrightLog('info', 'Тестовый канал отключён. Токены удалены.');
  });

  el.ccStart.addEventListener('click', async () => {
    await startCopyrightCheck(null);
  });

  el.ccStop.addEventListener('click', async () => {
    await window.api.stopCopyrightCheck();
    el.ccStatusLine.textContent = 'Останавливаем проверку…';
  });

  el.ccRetry.addEventListener('click', async () => {
    const directory = el.ccDir.value.trim();
    const result = await window.api.retryCopyright({ directory });
    if (result && result.ok) applyCopyrightProgress(result.snapshot);
    await startCopyrightCheck(null);
  });

  el.ccRetryAll.addEventListener('click', async () => {
    const directory = el.ccDir.value.trim();
    const result = await window.api.retryCopyright({ directory });
    if (result && result.ok) applyCopyrightProgress(result.snapshot);
    await startCopyrightCheck(null);
  });

  el.ccCopyLog.addEventListener('click', async () => {
    if (!state.copyrightLog.length) return;
    try {
      await navigator.clipboard.writeText(state.copyrightLog.join('\n'));
      appendCopyrightLog('info', 'Лог скопирован в буфер обмена.');
    } catch (err) {
      appendCopyrightLog('error', `Не удалось скопировать лог: ${err.message}`);
    }
  });

  el.ccClearLog.addEventListener('click', () => {
    state.copyrightLog = [];
    el.ccLog.innerHTML = '<p class="log__empty">Лог очищен.</p>';
  });

  window.api.onCopyrightLog(({ level, message }) => appendCopyrightLog(level, message));
  window.api.onCopyrightProgress((snapshot) => applyCopyrightProgress(snapshot));
  window.api.onCopyrightState(({ running }) => setCopyrightRunning(Boolean(running)));
  window.api.onCopyrightDone((payload) => {
    setCopyrightRunning(false);
    if (payload && payload.ok) {
      el.ccBadge.textContent = 'Готово';
      el.ccBadge.className = 'badge badge--done';
      const s = payload.summary || {};
      el.ccStatusLine.textContent =
        `Total checked: ${s.total || 0} · Kept: ${s.kept || 0} · Deleted: ${s.deleted || 0}`;
      appendCopyrightLog('success', '— Copyright Check завершён —');
    } else {
      el.ccBadge.textContent = 'Ошибка';
      el.ccBadge.className = 'badge badge--error';
      el.ccStatusLine.textContent = (payload && payload.error) || 'Проверка прервана.';
    }
  });
}
