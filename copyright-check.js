'use strict';

/**
 * copyright-check.js — проверка copyright через официальный YouTube Data API.
 *
 * Загружает видео на тестовый канал только как PRIVATE, ждёт обработки,
 * классифицирует claim vs block. Удаляет локальный файл только при
 * подтверждённом BLOCKED. CLAIM ≠ BLOCK. Не обходит Content ID.
 *
 * Модуль не зависит от Electron (см. scripts/copyright-smoke-test.js).
 */

const fs = require('fs');
const path = require('path');

const { listVideos } = require('./renamer');

const QUEUE_FILE = 'copyright_queue.json';
const LOG_FILE = 'copyright_check.log';
const QUEUE_VERSION = 1;
const MAX_COPYRIGHT_CHECKS = 1;
const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 15_000;

const UPLOAD = {
  PENDING: 'PENDING',
  UPLOADING: 'UPLOADING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR'
};

const PROCESSING = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR'
};

const COPYRIGHT = {
  UNKNOWN: 'UNKNOWN',
  NO_CLAIM: 'NO_CLAIM',
  CLAIM: 'CLAIM',
  BLOCKED: 'BLOCKED',
  PROCESSING: 'PROCESSING',
  CHECK_ERROR: 'CHECK_ERROR'
};

const AVAILABILITY = {
  UNKNOWN: 'UNKNOWN',
  AVAILABLE: 'AVAILABLE',
  BLOCKED: 'BLOCKED'
};

const ACTION = {
  WAIT: 'WAIT',
  KEEP: 'KEEP',
  DELETE: 'DELETE',
  RETRY: 'RETRY'
};

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function stamp(nowMs) {
  return new Date(nowMs).toLocaleTimeString('ru-RU', { hour12: false });
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWorldwideRestriction(regionRestriction) {
  if (!regionRestriction || typeof regionRestriction !== 'object') return false;
  if (Array.isArray(regionRestriction.allowed) && regionRestriction.allowed.length === 0) return true;
  const blocked = Array.isArray(regionRestriction.blocked)
    ? regionRestriction.blocked.map((code) => String(code).toLowerCase())
    : [];
  if (blocked.includes('all') || blocked.includes('zz')) return true;
  return false;
}

function processingFlag(video) {
  const details = (video && video.processingDetails) || {};
  const status = (video && video.status) || {};
  const proc = String(details.processingStatus || '').toLowerCase();
  if (proc === 'processing' || proc === 'pending') return 'processing';
  if (proc === 'failed' || proc === 'terminated') return 'failed';
  if (proc === 'succeeded') return 'ready';
  const upload = String(status.uploadStatus || '').toLowerCase();
  if (upload === 'uploaded') return 'processing';
  if (upload === 'processed' || upload === 'rejected') return 'ready';
  if (upload === 'failed') return 'failed';
  return 'unknown';
}

/**
 * Официальные сигналы Data API v3 для обычного канала (не CMS Content ID API).
 * licensedContent = claim, не block.
 * Block только при rejected / мировой regionRestriction.
 */
function classifyFromYoutubeVideo(video) {
  if (!video) {
    return {
      copyrightStatus: COPYRIGHT.CHECK_ERROR,
      availabilityStatus: AVAILABILITY.UNKNOWN,
      claim: false,
      blocked: false,
      processing: false,
      claimInfo: 'Видео не найдено в API после загрузки'
    };
  }

  const phase = processingFlag(video);
  if (phase === 'processing') {
    return {
      copyrightStatus: COPYRIGHT.PROCESSING,
      availabilityStatus: AVAILABILITY.UNKNOWN,
      claim: false,
      blocked: false,
      processing: true,
      claimInfo: 'YouTube ещё обрабатывает видео'
    };
  }
  if (phase === 'failed') {
    const reason = (video.status && (video.status.failureReason || video.status.rejectionReason)) || 'processing failed';
    return {
      copyrightStatus: COPYRIGHT.CHECK_ERROR,
      availabilityStatus: AVAILABILITY.UNKNOWN,
      claim: false,
      blocked: false,
      processing: false,
      claimInfo: String(reason)
    };
  }

  const status = video.status || {};
  const details = video.contentDetails || {};
  const upload = String(status.uploadStatus || '').toLowerCase();
  const rejection = String(status.rejectionReason || '').toLowerCase();
  const licensed = details.licensedContent === true;
  const worldwide = isWorldwideRestriction(details.regionRestriction);
  const rejected = upload === 'rejected' || Boolean(rejection);

  const blocked = rejected || worldwide;
  const claim = licensed || rejection === 'claim' || rejection === 'copyright';

  let copyrightStatus = COPYRIGHT.NO_CLAIM;
  if (blocked && !claim) copyrightStatus = COPYRIGHT.BLOCKED;
  else if (claim) copyrightStatus = COPYRIGHT.CLAIM;
  else copyrightStatus = COPYRIGHT.NO_CLAIM;

  const bits = [];
  if (licensed) bits.push('licensedContent=true');
  if (rejection) bits.push(`rejectionReason=${status.rejectionReason}`);
  if (upload) bits.push(`uploadStatus=${status.uploadStatus}`);
  if (worldwide) bits.push('regionRestriction=worldwide');
  if (details.regionRestriction && !worldwide) bits.push('regionRestriction=partial');

  return {
    copyrightStatus,
    availabilityStatus: blocked ? AVAILABILITY.BLOCKED : AVAILABILITY.AVAILABLE,
    claim,
    blocked,
    processing: false,
    claimInfo: bits.join('; ') || (claim ? 'claim detected' : 'no claim signals')
  };
}

function decideAction({ uploadStatus, processingStatus, copyrightStatus, availabilityStatus }) {
  if (uploadStatus === UPLOAD.ERROR) {
    return { action: ACTION.RETRY, deleteLocal: false, reason: 'upload failed' };
  }
  if (
    processingStatus === PROCESSING.PROCESSING ||
    copyrightStatus === COPYRIGHT.PROCESSING
  ) {
    return { action: ACTION.WAIT, deleteLocal: false, reason: 'processing' };
  }
  if (
    processingStatus === PROCESSING.TIMEOUT ||
    processingStatus === PROCESSING.ERROR ||
    copyrightStatus === COPYRIGHT.CHECK_ERROR ||
    copyrightStatus === COPYRIGHT.UNKNOWN
  ) {
    return { action: ACTION.RETRY, deleteLocal: false, reason: 'check error' };
  }
  if (availabilityStatus === AVAILABILITY.BLOCKED && processingStatus === PROCESSING.READY && uploadStatus === UPLOAD.SUCCESS) {
    return { action: ACTION.DELETE, deleteLocal: true, reason: 'blocked' };
  }
  if (copyrightStatus === COPYRIGHT.NO_CLAIM) {
    return { action: ACTION.KEEP, deleteLocal: false, reason: 'no claim' };
  }
  if (copyrightStatus === COPYRIGHT.CLAIM && availabilityStatus === AVAILABILITY.AVAILABLE) {
    return { action: ACTION.KEEP, deleteLocal: false, reason: 'claim available' };
  }
  if (copyrightStatus === COPYRIGHT.CLAIM && availabilityStatus === AVAILABILITY.BLOCKED) {
    return { action: ACTION.DELETE, deleteLocal: true, reason: 'claim blocked' };
  }
  return { action: ACTION.KEEP, deleteLocal: false, reason: 'unknown keep' };
}

function emptyItem(partial, nowMs) {
  return {
    id: partial.id,
    filename: partial.filename,
    filePath: partial.filePath,
    youtubeVideoId: partial.youtubeVideoId || '',
    title: partial.title || partial.filename,
    uploadStatus: partial.uploadStatus || UPLOAD.PENDING,
    processingStatus: partial.processingStatus || PROCESSING.PENDING,
    copyrightStatus: partial.copyrightStatus || COPYRIGHT.UNKNOWN,
    availabilityStatus: partial.availabilityStatus || AVAILABILITY.UNKNOWN,
    action: partial.action || ACTION.WAIT,
    timestamp: partial.timestamp || new Date(nowMs).toISOString(),
    uploadTimestamp: partial.uploadTimestamp || '',
    lastError: partial.lastError || '',
    claimInfo: partial.claimInfo || '',
    checkComplete: Boolean(partial.checkComplete),
    deleteVerified: Boolean(partial.deleteVerified),
    youtubeDeleted: Boolean(partial.youtubeDeleted)
  };
}

function isFinished(item) {
  if (item.checkComplete && item.action === ACTION.KEEP) return true;
  if (item.checkComplete && item.action === ACTION.DELETE && item.deleteVerified) return true;
  return false;
}

function needsWork(item) {
  if (isFinished(item)) return false;
  return true;
}

function summarizeItems(items) {
  const stats = {
    total: items.length,
    noClaims: 0,
    claims: 0,
    blocked: 0,
    processing: 0,
    errors: 0,
    kept: 0,
    deleted: 0
  };
  items.forEach((item) => {
    if (item.copyrightStatus === COPYRIGHT.NO_CLAIM) stats.noClaims += 1;
    if (item.copyrightStatus === COPYRIGHT.CLAIM) stats.claims += 1;
    if (item.availabilityStatus === AVAILABILITY.BLOCKED || item.copyrightStatus === COPYRIGHT.BLOCKED) {
      stats.blocked += 1;
    }
    if (
      item.action === ACTION.WAIT ||
      item.processingStatus === PROCESSING.PROCESSING ||
      item.copyrightStatus === COPYRIGHT.PROCESSING
    ) {
      stats.processing += 1;
    }
    if (
      item.action === ACTION.RETRY ||
      item.copyrightStatus === COPYRIGHT.CHECK_ERROR ||
      item.uploadStatus === UPLOAD.ERROR ||
      item.processingStatus === PROCESSING.TIMEOUT ||
      item.processingStatus === PROCESSING.ERROR
    ) {
      stats.errors += 1;
    }
    if (item.action === ACTION.KEEP && item.checkComplete) stats.kept += 1;
    if (item.action === ACTION.DELETE && item.deleteVerified) stats.deleted += 1;
  });
  return stats;
}

function publicItem(item) {
  return {
    id: item.id,
    filename: item.filename,
    filePath: item.filePath,
    youtubeVideoId: item.youtubeVideoId || '',
    title: item.title || item.filename,
    uploadStatus: item.uploadStatus,
    processingStatus: item.processingStatus,
    copyrightStatus: item.copyrightStatus,
    availabilityStatus: item.availabilityStatus,
    action: item.action,
    timestamp: item.timestamp,
    uploadTimestamp: item.uploadTimestamp || '',
    lastError: item.lastError || '',
    claimInfo: item.claimInfo || '',
    checkComplete: Boolean(item.checkComplete),
    deleteVerified: Boolean(item.deleteVerified)
  };
}

class CopyrightChecker {
  constructor(options = {}) {
    this.directory = options.directory;
    this.client = options.client;
    this.maxWaitMs = Number(options.maxWaitMs) > 0 ? Number(options.maxWaitMs) : DEFAULT_MAX_WAIT_MS;
    this.pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : DEFAULT_POLL_MS;
    this.autoDeleteUploads = Boolean(options.autoDeleteUploads);
    this.now = options.now || (() => Date.now());
    this.sleep = options.sleep || sleepMs;
    this.hooks = options.hooks || {};
    this.items = [];
    this.running = false;
    this.stopped = false;
    this.current = null;
  }

  queuePath() {
    return path.join(this.directory, QUEUE_FILE);
  }

  logPath() {
    return path.join(this.directory, LOG_FILE);
  }

  persist() {
    if (!this.directory) return;
    fs.mkdirSync(this.directory, { recursive: true });
    writeJsonAtomic(this.queuePath(), {
      version: QUEUE_VERSION,
      items: this.items
    });
  }

  loadFromDisk() {
    const file = this.queuePath();
    if (!file || !fs.existsSync(file)) {
      this.items = [];
      return this.items;
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const items = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
      this.items = items.map((item, index) => emptyItem({
        ...item,
        id: item.id || index + 1
      }, this.now()));
    } catch {
      this.items = [];
    }
    return this.items;
  }

  log(item, message, level = 'info') {
    const id = item && item.id ? `#${item.id} ` : '';
    const line = `[${stamp(this.now())}] ${id}${message}`;
    if (this.directory) {
      fs.mkdirSync(this.directory, { recursive: true });
      fs.appendFileSync(this.logPath(), `${line}\n`, 'utf8');
    }
    if (typeof this.hooks.onLog === 'function') this.hooks.onLog(level, line);
  }

  emitProgress() {
    if (typeof this.hooks.onProgress === 'function') {
      this.hooks.onProgress(this.snapshot());
    }
  }

  emitState() {
    if (typeof this.hooks.onState === 'function') {
      this.hooks.onState({ running: this.running, stopped: this.stopped });
    }
  }

  snapshot() {
    return {
      directory: this.directory,
      running: this.running,
      current: this.current ? publicItem(this.current) : null,
      items: this.items.map(publicItem),
      stats: summarizeItems(this.items),
      logFile: this.directory ? this.logPath() : null
    };
  }

  nextId() {
    return this.items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
  }

  findByFilename(filename) {
    const key = String(filename || '').toLowerCase();
    return this.items.find((item) => String(item.filename).toLowerCase() === key);
  }

  enqueueFiles(filePaths) {
    const added = [];
    (filePaths || []).forEach((filePath) => {
      if (!filePath || !fs.existsSync(filePath)) return;
      const filename = path.basename(filePath);
      const existing = this.findByFilename(filename);
      if (existing) {
        existing.filePath = filePath;
        if (isFinished(existing)) return;
        added.push(existing);
        return;
      }
      const item = emptyItem({
        id: this.nextId(),
        filename,
        filePath,
        title: filename
      }, this.now());
      this.items.push(item);
      added.push(item);
    });
    this.persist();
    this.emitProgress();
    return added;
  }

  enqueueDirectory() {
    const videos = listVideos(this.directory);
    return this.enqueueFiles(videos.map((video) => video.path));
  }

  markRetry(item) {
    item.action = ACTION.RETRY;
    item.checkComplete = false;
    item.deleteVerified = false;
    item.copyrightStatus = item.youtubeVideoId ? COPYRIGHT.UNKNOWN : item.copyrightStatus;
    if (item.processingStatus === PROCESSING.TIMEOUT || item.processingStatus === PROCESSING.ERROR) {
      item.processingStatus = item.youtubeVideoId ? PROCESSING.PENDING : item.processingStatus;
    }
  }

  retryFailed() {
    const retried = [];
    this.items.forEach((item) => {
      if (isFinished(item)) return;
      if (
        item.action === ACTION.RETRY ||
        item.copyrightStatus === COPYRIGHT.CHECK_ERROR ||
        item.uploadStatus === UPLOAD.ERROR ||
        item.processingStatus === PROCESSING.TIMEOUT ||
        item.processingStatus === PROCESSING.ERROR ||
        item.copyrightStatus === COPYRIGHT.PROCESSING ||
        item.action === ACTION.WAIT
      ) {
        this.markRetry(item);
        item.action = ACTION.WAIT;
        retried.push(item);
      }
    });
    this.persist();
    this.emitProgress();
    return retried.length;
  }

  retryOne(id) {
    const item = this.items.find((row) => Number(row.id) === Number(id));
    if (!item) return false;
    this.markRetry(item);
    item.action = ACTION.WAIT;
    this.persist();
    this.emitProgress();
    return true;
  }

  nextWorkItem() {
    return this.items.find((item) => needsWork(item));
  }

  stop() {
    this.stopped = true;
  }

  async run() {
    if (this.running) return this.snapshot();
    this.running = true;
    this.stopped = false;
    this.emitState();
    this.emitProgress();
    try {
      const seen = new Set();
      while (!this.stopped) {
        const item = this.items.find((row) => needsWork(row) && !seen.has(row.id));
        if (!item) break;
        seen.add(item.id);
        await this.processItem(item);
      }
    } finally {
      this.running = false;
      this.current = null;
      this.emitState();
      this.emitProgress();
      if (typeof this.hooks.onDone === 'function') {
        this.hooks.onDone({ ok: true, summary: summarizeItems(this.items) });
      }
    }
    return this.snapshot();
  }

  async processItem(item) {
    this.current = item;
    try {
      if (!item.youtubeVideoId) {
        await this.uploadItem(item);
      } else {
        this.log(item, `RESUME VIDEO ID: ${item.youtubeVideoId}`);
      }
      if (this.stopped) return;
      if (item.uploadStatus !== UPLOAD.SUCCESS || !item.youtubeVideoId) return;

      const video = await this.waitForProcessing(item);
      if (this.stopped) return;
      if (item.processingStatus !== PROCESSING.READY) return;

      this.log(item, 'COPYRIGHT CHECK');
      const classified = classifyFromYoutubeVideo(video);
      item.copyrightStatus = classified.copyrightStatus;
      item.availabilityStatus = classified.availabilityStatus;
      item.claimInfo = classified.claimInfo;
      item.timestamp = new Date(this.now()).toISOString();

      if (classified.processing) {
        item.action = ACTION.WAIT;
        this.persist();
        this.emitProgress();
        return;
      }

      if (classified.claim) this.log(item, 'CLAIM DETECTED', 'warn');
      else if (classified.copyrightStatus === COPYRIGHT.NO_CLAIM) this.log(item, 'NO CLAIM', 'success');
      this.log(item, `AVAILABILITY: ${item.availabilityStatus}`);

      const decision = decideAction(item);
      if (decision.deleteLocal) {
        await this.deleteLocalIfBlocked(item);
      } else if (decision.action === ACTION.RETRY) {
        item.action = ACTION.RETRY;
        item.checkComplete = false;
        this.log(item, 'CHECK_ERROR — файл оставлен', 'warn');
      } else {
        item.action = ACTION.KEEP;
        item.checkComplete = true;
        this.log(item, 'KEEP', 'success');
      }

      if (this.autoDeleteUploads && item.checkComplete && item.youtubeVideoId && !item.youtubeDeleted) {
        await this.deleteYoutubeUpload(item);
      }
    } catch (err) {
      item.lastError = err && err.message ? err.message : String(err);
      item.action = ACTION.RETRY;
      item.checkComplete = false;
      if (item.uploadStatus === UPLOAD.UPLOADING) item.uploadStatus = UPLOAD.ERROR;
      if (!item.youtubeVideoId) item.uploadStatus = UPLOAD.ERROR;
      else {
        item.copyrightStatus = COPYRIGHT.CHECK_ERROR;
        item.availabilityStatus = AVAILABILITY.UNKNOWN;
      }
      this.log(item, `CHECK ERROR: ${item.lastError}`, 'error');
    }
    this.persist();
    this.emitProgress();
  }

  async uploadItem(item) {
    if (!this.client || typeof this.client.uploadPrivate !== 'function') {
      throw new Error('YouTube-клиент не подключён');
    }
    if (!fs.existsSync(item.filePath)) {
      item.uploadStatus = UPLOAD.ERROR;
      item.action = ACTION.RETRY;
      item.lastError = 'Локальный файл не найден';
      this.log(item, 'UPLOAD ERROR: файл не найден', 'error');
      this.persist();
      return;
    }
    item.uploadStatus = UPLOAD.UPLOADING;
    item.action = ACTION.WAIT;
    this.persist();
    this.emitProgress();
    this.log(item, 'UPLOAD START');
    const uploaded = await this.client.uploadPrivate(item.filePath, {
      title: item.title,
      onProgress: (percent) => {
        if (typeof this.hooks.onUploadProgress === 'function') {
          this.hooks.onUploadProgress({ id: item.id, percent });
        }
      }
    });
    const privacy = uploaded && uploaded.status && uploaded.status.privacyStatus;
    if (privacy && privacy !== 'private') {
      throw new Error('Загрузка отклонена: видео не private');
    }
    item.youtubeVideoId = uploaded && uploaded.id;
    if (!item.youtubeVideoId) throw new Error('YouTube не вернул video id');
    item.uploadStatus = UPLOAD.SUCCESS;
    item.uploadTimestamp = new Date(this.now()).toISOString();
    item.timestamp = item.uploadTimestamp;
    this.log(item, 'UPLOAD SUCCESS', 'success');
    this.log(item, `Video ID: ${item.youtubeVideoId}`);
    this.persist();
    this.emitProgress();
  }

  async waitForProcessing(item) {
    item.processingStatus = PROCESSING.PROCESSING;
    item.copyrightStatus = COPYRIGHT.PROCESSING;
    item.action = ACTION.WAIT;
    this.persist();
    this.emitProgress();
    this.log(item, 'PROCESSING');
    let lastVideo = null;
    let waited = 0;
    while (!this.stopped) {
      lastVideo = await this.client.getVideo(item.youtubeVideoId);
      const phase = processingFlag(lastVideo);
      if (phase === 'ready') {
        item.processingStatus = PROCESSING.READY;
        this.log(item, 'PROCESSING COMPLETE', 'success');
        this.persist();
        this.emitProgress();
        return lastVideo;
      }
      if (phase === 'failed') {
        const classified = classifyFromYoutubeVideo(lastVideo);
        item.processingStatus = PROCESSING.ERROR;
        item.copyrightStatus = COPYRIGHT.CHECK_ERROR;
        item.action = ACTION.RETRY;
        item.lastError = classified.claimInfo;
        this.log(item, `PROCESSING ERROR: ${classified.claimInfo}`, 'error');
        this.persist();
        this.emitProgress();
        return lastVideo;
      }
      if (waited >= this.maxWaitMs) break;
      await this.sleep(this.pollMs);
      waited += this.pollMs;
    }
    if (this.stopped) return lastVideo;
    item.processingStatus = PROCESSING.TIMEOUT;
    item.copyrightStatus = COPYRIGHT.CHECK_ERROR;
    item.availabilityStatus = AVAILABILITY.UNKNOWN;
    item.action = ACTION.RETRY;
    item.checkComplete = false;
    item.lastError = 'Истекло время ожидания обработки YouTube';
    this.log(item, 'CHECK_ERROR timeout — файл оставлен', 'warn');
    this.persist();
    this.emitProgress();
    return lastVideo;
  }

  async deleteLocalIfBlocked(item) {
    const uploaded = item.uploadStatus === UPLOAD.SUCCESS && Boolean(item.youtubeVideoId);
    const blocked = item.availabilityStatus === AVAILABILITY.BLOCKED;
    const ready = item.processingStatus === PROCESSING.READY;
    if (!uploaded || !blocked || !ready) {
      item.action = ACTION.KEEP;
      item.checkComplete = true;
      this.log(item, 'KEEP — блок не подтверждён', 'warn');
      return;
    }
    this.log(item, `COPYRIGHT BLOCK\nFile: ${item.filename}\nYouTube ID: ${item.youtubeVideoId}\nReason: BLOCKED`, 'error');
    this.log(item, 'DELETE LOCAL FILE', 'warn');
    try {
      if (fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath);
    } catch (err) {
      item.action = ACTION.RETRY;
      item.checkComplete = false;
      item.deleteVerified = false;
      item.lastError = err && err.message ? err.message : String(err);
      this.log(item, 'DELETE ERROR', 'error');
      return;
    }
    const gone = !fs.existsSync(item.filePath);
    if (!gone) {
      item.action = ACTION.RETRY;
      item.checkComplete = false;
      item.deleteVerified = false;
      item.lastError = 'Файл всё ещё существует после удаления';
      this.log(item, 'DELETE FAILED', 'error');
      return;
    }
    item.action = ACTION.DELETE;
    item.checkComplete = true;
    item.deleteVerified = true;
    this.log(item, 'DELETE SUCCESS', 'success');
    this.log(item, 'DELETE VERIFIED', 'success');
  }

  async deleteYoutubeUpload(item) {
    if (!this.autoDeleteUploads) return;
    if (!item.youtubeVideoId) return;
    try {
      await this.client.deleteVideo(item.youtubeVideoId);
      item.youtubeDeleted = true;
      this.log(item, 'TEST UPLOAD DELETED (настройка включена)');
    } catch (err) {
      this.log(item, `Не удалось удалить тестовую загрузку: ${err.message}`, 'warn');
    }
  }
}

module.exports = {
  QUEUE_FILE,
  LOG_FILE,
  QUEUE_VERSION,
  MAX_COPYRIGHT_CHECKS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_MS,
  UPLOAD,
  PROCESSING,
  COPYRIGHT,
  AVAILABILITY,
  ACTION,
  classifyFromYoutubeVideo,
  decideAction,
  isWorldwideRestriction,
  processingFlag,
  summarizeItems,
  CopyrightChecker
};
