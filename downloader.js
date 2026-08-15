'use strict';

/**
 * downloader.js — массовое скачивание YouTube / Shorts с умной очередью.
 *
 * Одновременно качается только одно видео. Ошибка одной ссылки не останавливает
 * остальные: ссылка уходит в конец очереди и повторяется с нарастающей паузой.
 * Модуль не зависит от Electron (см. scripts/download-smoke-test.js).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const MAX_CONCURRENT_DOWNLOADS = 1;
const QUEUE_FILE = 'download_queue.json';
const TITLES_FILE = 'nazvaniya.txt';
const LOG_FILE = 'download_log.txt';
const MIN_OUTPUT_BYTES = 4096;
const QUEUE_VERSION = 1;

const STATUS = {
  WAITING: 'WAITING',
  DOWNLOADING: 'DOWNLOADING',
  SUCCESS: 'SUCCESS',
  RETRY: 'RETRY',
  PERMANENT_ERROR: 'PERMANENT_ERROR'
};

const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

const WIN_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;
const YT_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/|v\/|shorts%2F))([a-zA-Z0-9_-]{11})/i;
const YT_ID_QUERY_RE = /[?&]v=([a-zA-Z0-9_-]{11})/;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

function unpackedPath(binaryPath) {
  if (typeof binaryPath !== 'string' || !binaryPath) return null;
  return binaryPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function vendorYtDlpName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp';
}

function resolveYtDlpPath(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const vendor = path.join(__dirname, 'vendor', 'yt-dlp', vendorYtDlpName());
  candidates.push(unpackedPath(vendor), vendor);
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'vendor', 'yt-dlp', vendorYtDlpName()));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'vendor', 'yt-dlp', vendorYtDlpName()));
  }
  candidates.push(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === 'yt-dlp' || candidate === 'yt-dlp.exe') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

function ytdlpExists(bin) {
  if (!bin) return false;
  if (bin === 'yt-dlp' || bin === 'yt-dlp.exe') {
    try {
      execFileSync(bin, ['--version'], { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(bin);
}

function extractVideoId(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fromPath = text.match(YT_ID_RE);
  if (fromPath) return fromPath[1];
  const fromQuery = text.match(YT_ID_QUERY_RE);
  if (fromQuery) return fromQuery[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(text)) return text;
  return null;
}

function normalizeWatchUrl(raw) {
  const id = extractVideoId(raw);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  const text = String(raw || '').trim();
  return text || null;
}

function parseLinkList(text) {
  const seen = new Set();
  const urls = [];
  String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const found = line.match(URL_RE);
      const pieces = found && found.length ? found : [line];
      pieces.forEach((piece) => {
        const cleaned = String(piece).trim().replace(/[),.;]+$/g, '');
        const id = extractVideoId(cleaned);
        if (!id) return;
        const url = normalizeWatchUrl(cleaned);
        if (!url || seen.has(id)) return;
        seen.add(id);
        urls.push(url);
      });
    });
  return urls;
}

function retryDelayMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length) - 1];
}

function classifyError(message) {
  const text = String(message || '');
  const permanent = [
    /video unavailable/i,
    /this video has been removed/i,
    /this video is private/i,
    /private video/i,
    /video is not available/i,
    /account associated with this video has been terminated/i,
    /uploader has not made this video available/i,
    /invalid url/i,
    /unsupported url/i,
    /incomplete youtube id/i,
    /http error 404/i,
    /http error 410/i,
    /members-only/i,
    /join this channel/i,
    /sign in to confirm your age/i,
    /confirm your age/i,
    /copyright/i,
    /who has blocked it in your country/i,
    /not a valid url/i
  ];
  if (permanent.some((re) => re.test(text))) return 'PERMANENT';
  return 'TEMPORARY';
}

function sanitizeFilename(title) {
  let name = String(title || 'video')
    .replace(WIN_FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!name) name = 'video';
  if (name.length > 180) name = name.slice(0, 180).replace(/[. ]+$/g, '').trim() || 'video';
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (reserved.test(name)) name = `_${name}`;
  return name;
}

function selectBestFormats(formats) {
  const list = Array.isArray(formats) ? formats.filter(Boolean) : [];
  const isNone = (value) => !value || value === 'none';
  const videos = list.filter((fmt) => !isNone(fmt.vcodec));
  const audios = list.filter((fmt) => !isNone(fmt.acodec) && isNone(fmt.vcodec));
  const combined = list.filter((fmt) => !isNone(fmt.vcodec) && !isNone(fmt.acodec));

  const videoScore = (fmt) => [
    Number(fmt.height) || 0,
    Number(fmt.width) || 0,
    Number(fmt.fps) || 0,
    Number(fmt.vbr || fmt.tbr) || 0,
    Number(fmt.quality) || 0
  ];
  const audioScore = (fmt) => [
    Number(fmt.abr || fmt.tbr) || 0,
    Number(fmt.asr) || 0,
    Number(fmt.quality) || 0
  ];
  const cmp = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  };
  const bestOf = (items, score) => items.slice().sort((a, b) => cmp(score(b), score(a)))[0] || null;

  const bestVideo = bestOf(videos, videoScore);
  const bestAudio = bestOf(audios, audioScore);
  const bestCombined = bestOf(combined, (fmt) => videoScore(fmt).concat(audioScore(fmt)));

  if (bestVideo && bestAudio) {
    return {
      mode: 'separate',
      format: `${bestVideo.format_id}+${bestAudio.format_id}`,
      video: bestVideo,
      audio: bestAudio,
      preferMp4: isMp4Friendly(bestVideo, bestAudio)
    };
  }
  if (bestCombined) {
    return {
      mode: 'combined',
      format: String(bestCombined.format_id),
      video: bestCombined,
      audio: bestCombined,
      preferMp4: isMp4Friendly(bestCombined, bestCombined)
    };
  }
  return {
    mode: 'fallback',
    format: 'bestvideo*+bestaudio/best',
    video: bestVideo,
    audio: bestAudio,
    preferMp4: false
  };
}

function isMp4Friendly(video, audio) {
  const vcodec = String((video && video.vcodec) || '').toLowerCase();
  const acodec = String((audio && audio.acodec) || '').toLowerCase();
  const videoOk = /^(avc1|h264|hev1|hvc1|hevc|mp4v)/.test(vcodec) || vcodec.includes('h264') || vcodec.includes('hevc');
  const audioOk = /^(mp4a|aac|alac)/.test(acodec) || acodec.includes('aac');
  return Boolean(videoOk && audioOk);
}

function describeQuality(selection) {
  const video = selection && selection.video;
  if (!video) return 'AUTO';
  const height = Number(video.height) || 0;
  const fps = Number(video.fps) || 0;
  if (height && fps) return `${height}p${fps}`;
  if (height) return `${height}p`;
  return 'AUTO';
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function parseProgressLine(line) {
  const text = String(line || '');
  const match = text.match(
    /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+[KMG]i?B)\s+at\s+([\d.]+[KMG]i?B\/s)\s+ETA\s+(\S+)/i
  );
  if (!match) {
    const simple = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
    if (!simple) return null;
    return { percent: Number(simple[1]), speed: '', eta: '' };
  }
  return {
    percent: Number(match[1]),
    total: match[2],
    speed: match[3],
    eta: match[4]
  };
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* занят или уже удалён */
  }
}

function appendUtf8(file, text) {
  fs.appendFileSync(file, text, { encoding: 'utf8' });
}

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    if (err.code !== 'EEXIST' && err.code !== 'EPERM') {
      fs.copyFileSync(tmp, file);
      safeUnlink(tmp);
      return;
    }
    safeUnlink(file);
    fs.renameSync(tmp, file);
  }
}

function defaultItem(url, number) {
  return {
    id: extractVideoId(url) || `url-${number}`,
    number,
    url,
    videoId: extractVideoId(url),
    title: null,
    status: STATUS.WAITING,
    attempts: 0,
    lastError: null,
    nextRetry: null,
    completed: false,
    filename: null,
    quality: 'AUTO',
    resolution: null,
    fps: null,
    videoCodec: null,
    audioCodec: null,
    audioBitrate: null,
    fileSize: null,
    titleSaved: false
  };
}

function queuePath(outputDir) {
  return path.join(outputDir, QUEUE_FILE);
}

function loadQueueFile(outputDir) {
  const file = queuePath(outputDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(readUtf8(file));
  } catch {
    return null;
  }
}

function mergeUrlsIntoQueue(existingItems, urls) {
  const items = Array.isArray(existingItems) ? existingItems.slice() : [];
  const index = new Map();
  items.forEach((item) => {
    const key = item.videoId || extractVideoId(item.url) || String(item.url || '').toLowerCase();
    if (key) index.set(key, item);
  });
  let nextNumber = items.reduce((max, item) => Math.max(max, Number(item.number) || 0), 0);
  urls.forEach((url) => {
    const key = extractVideoId(url) || url.toLowerCase();
    if (index.has(key)) return;
    nextNumber += 1;
    const item = defaultItem(url, nextNumber);
    items.push(item);
    index.set(key, item);
  });
  return items;
}

function titlesAlreadyHas(outputDir, title) {
  const file = path.join(outputDir, TITLES_FILE);
  if (!title || !fs.existsSync(file)) return false;
  const lines = readUtf8(file).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.includes(String(title).trim());
}

function appendTitle(outputDir, title) {
  const file = path.join(outputDir, TITLES_FILE);
  const line = `${String(title).trim()}\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, line, 'utf8');
    return;
  }
  const current = readUtf8(file);
  const prefix = current.length && !current.endsWith('\n') ? '\n' : '';
  appendUtf8(file, `${prefix}${line}`);
}

function fileLooksComplete(file) {
  try {
    if (!file || !fs.existsSync(file)) return false;
    if (/\.part$/i.test(file)) return false;
    return fs.statSync(file).size >= MIN_OUTPUT_BYTES;
  } catch {
    return false;
  }
}

function findExistingOutput(outputDir, item) {
  if (item.filename) {
    const full = path.isAbsolute(item.filename) ? item.filename : path.join(outputDir, item.filename);
    if (fileLooksComplete(full)) return full;
  }
  if (!item.videoId) return null;
  const names = fs.readdirSync(outputDir);
  const match = names.find((name) => name.includes(`[${item.videoId}]`) && !/\.part$/i.test(name));
  if (!match) return null;
  const full = path.join(outputDir, match);
  return fileLooksComplete(full) ? full : null;
}

function summarizeItems(items) {
  const counts = {
    total: items.length,
    completed: 0,
    downloading: 0,
    waiting: 0,
    retry: 0,
    permanent: 0
  };
  items.forEach((item) => {
    if (item.status === STATUS.SUCCESS) counts.completed += 1;
    else if (item.status === STATUS.DOWNLOADING) counts.downloading += 1;
    else if (item.status === STATUS.RETRY) counts.retry += 1;
    else if (item.status === STATUS.PERMANENT_ERROR) counts.permanent += 1;
    else counts.waiting += 1;
  });
  return counts;
}

class DownloadQueue {
  constructor(options = {}) {
    this.outputDir = options.outputDir;
    this.ytdlpPath = options.ytdlpPath || resolveYtDlpPath();
    this.ffmpegPath = options.ffmpegPath;
    this.ffprobePath = options.ffprobePath;
    this.hooks = options.hooks || {};
    this.runner = options.runner || null;
    this.now = options.now || (() => Date.now());
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.items = [];
    this.running = false;
    this.paused = false;
    this.stopped = false;
    this.activeDownloads = 0;
    this.currentChild = null;
    this.currentItem = null;
  }

  log(level, message) {
    if (typeof this.hooks.onLog === 'function') this.hooks.onLog(level, message);
    if (this.outputDir) {
      try {
        const stamp = new Date(this.now()).toTimeString().slice(0, 8);
        appendUtf8(path.join(this.outputDir, LOG_FILE), `[${stamp}] ${message}\n`);
      } catch {
        /* лог не должен ронять очередь */
      }
    }
  }

  emitProgress(extra = {}) {
    if (typeof this.hooks.onProgress !== 'function') return;
    const counts = summarizeItems(this.items);
    const current = this.currentItem;
    this.hooks.onProgress({
      ...counts,
      overallPercent: counts.total ? (counts.completed / counts.total) * 100 : 0,
      current: current
        ? {
            number: current.number,
            title: current.title || current.url,
            url: current.url,
            percent: extra.filePercent || 0,
            speed: extra.speed || '',
            eta: extra.eta || '',
            quality: current.quality || 'AUTO',
            status: current.status
          }
        : null,
      items: this.items.map((item) => ({
        number: item.number,
        url: item.url,
        status: item.status,
        title: item.title || '—',
        quality: item.quality || 'AUTO',
        attempts: item.attempts,
        lastError: item.lastError,
        nextRetry: item.nextRetry,
        filename: item.filename,
        resolution: item.resolution,
        fps: item.fps,
        videoCodec: item.videoCodec,
        audioCodec: item.audioCodec,
        audioBitrate: item.audioBitrate,
        fileSize: item.fileSize
      })),
      errors: this.items
        .filter((item) => item.status === STATUS.RETRY || item.status === STATUS.PERMANENT_ERROR)
        .map((item) => ({
          number: item.number,
          url: item.url,
          status: item.status,
          attempts: item.attempts,
          lastError: item.lastError,
          nextRetry: item.nextRetry
        })),
      status: extra.status || null
    });
  }

  persist() {
    if (!this.outputDir) return;
    writeJsonAtomic(queuePath(this.outputDir), {
      version: QUEUE_VERSION,
      outputDir: this.outputDir,
      updatedAt: new Date(this.now()).toISOString(),
      items: this.items
    });
  }

  loadFromDisk() {
    const saved = loadQueueFile(this.outputDir);
    if (!saved || !Array.isArray(saved.items)) return [];
    return saved.items.map((item, i) => ({
      ...defaultItem(item.url, i + 1),
      ...item,
      number: i + 1,
      status: item.status === STATUS.DOWNLOADING ? STATUS.WAITING : item.status
    }));
  }

  reconcileExisting() {
    this.items.forEach((item) => {
      if (item.status === STATUS.DOWNLOADING) item.status = STATUS.WAITING;
      const existing = findExistingOutput(this.outputDir, item);
      if (existing && (item.status === STATUS.SUCCESS || item.completed || item.status === STATUS.WAITING || item.status === STATUS.RETRY)) {
        item.filename = path.basename(existing);
        item.fileSize = fs.statSync(existing).size;
        item.status = STATUS.SUCCESS;
        item.completed = true;
        item.lastError = null;
        item.nextRetry = null;
        if (item.title && !item.titleSaved) {
          appendTitle(this.outputDir, item.title);
          item.titleSaved = true;
        }
      } else if (item.status === STATUS.SUCCESS && !existing) {
        item.status = STATUS.WAITING;
        item.completed = false;
        item.titleSaved = false;
        item.filename = null;
      }
    });
    this.persist();
  }

  setLinks(text) {
    const urls = parseLinkList(text);
    const existing = this.items.length ? this.items : this.loadFromDisk();
    this.items = mergeUrlsIntoQueue(existing, urls);
    this.reconcileExisting();
    this.emitProgress({ status: `В очереди ${this.items.length} ссылок` });
    return this.items;
  }

  stopCurrentProcess() {
    const child = this.currentChild;
    this.currentChild = null;
    if (!child || child.killed) return;
    try {
      child.kill('SIGKILL');
    } catch {
      /* процесс мог уже завершиться */
    }
  }

  pause() {
    this.paused = true;
    this.log('warn', 'PAUSE — новые загрузки не стартуют, текущая останавливается');
    this.stopCurrentProcess();
    this.persist();
    this.emitProgress({ status: 'Пауза' });
  }

  resume() {
    this.paused = false;
    this.stopped = false;
    this.log('info', 'RESUME — очередь продолжается');
    this.emitProgress({ status: 'Продолжаем очередь' });
  }

  stop() {
    this.stopped = true;
    this.paused = true;
    this.log('warn', 'STOP — очередь остановлена, состояние сохранено');
    this.stopCurrentProcess();
    this.persist();
    this.emitProgress({ status: 'Остановлено' });
  }

  pickReadyIndex() {
    const now = this.now();
    for (let i = 0; i < this.items.length; i += 1) {
      const item = this.items[i];
      if (item.status === STATUS.SUCCESS || item.status === STATUS.PERMANENT_ERROR) continue;
      if (item.status === STATUS.DOWNLOADING) continue;
      if (item.status === STATUS.RETRY && item.nextRetry && Date.parse(item.nextRetry) > now) continue;
      return i;
    }
    return -1;
  }

  nearestRetryAt() {
    let nearest = null;
    this.items.forEach((item) => {
      if (item.status !== STATUS.RETRY || !item.nextRetry) return;
      const ts = Date.parse(item.nextRetry);
      if (!Number.isFinite(ts)) return;
      if (nearest === null || ts < nearest) nearest = ts;
    });
    return nearest;
  }

  unfinished() {
    return this.items.some(
      (item) => item.status !== STATUS.SUCCESS && item.status !== STATUS.PERMANENT_ERROR
    );
  }

  moveToEnd(index) {
    if (index < 0 || index >= this.items.length) return;
    const [item] = this.items.splice(index, 1);
    this.items.push(item);
  }

  async runYtDlp(args, onLine) {
    if (this.runner) return this.runner(args, onLine);
    if (!ytdlpExists(this.ytdlpPath)) {
      throw new Error('yt-dlp не найден. Положите бинарник в vendor/yt-dlp или установите yt-dlp в PATH.');
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.ytdlpPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.currentChild = child;
      let stdout = '';
      let stderr = '';
      const handle = (chunk, stream) => {
        const text = chunk.toString('utf8');
        if (stream === 'out') stdout += text;
        else stderr += text;
        text.split(/\r?\n/).forEach((line) => {
          if (line && typeof onLine === 'function') onLine(line);
        });
      };
      child.stdout.on('data', (chunk) => handle(chunk, 'out'));
      child.stderr.on('data', (chunk) => handle(chunk, 'err'));
      child.on('error', (err) => {
        if (this.currentChild === child) this.currentChild = null;
        reject(err);
      });
      child.on('close', (code) => {
        if (this.currentChild === child) this.currentChild = null;
        if (this.stopped || this.paused) {
          const err = new Error('Загрузка остановлена пользователем');
          err.cancelled = true;
          reject(err);
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error((stderr || stdout || `yt-dlp exited ${code}`).trim().split('\n').slice(-8).join('\n')));
      });
    });
  }

  async probeInfo(url) {
    const { stdout } = await this.runYtDlp([
      '-J',
      '--no-playlist',
      '--no-warnings',
      '--encoding',
      'utf-8',
      url
    ]);
    const start = stdout.indexOf('{');
    if (start < 0) throw new Error('yt-dlp не вернул информацию о видео');
    return JSON.parse(stdout.slice(start));
  }

  async probeOutput(file) {
    if (!this.ffprobePath) {
      return { hasVideo: true, hasAudio: true, width: null, height: null, fps: null, videoCodec: null, audioCodec: null, audioBitrate: null };
    }
    const raw = execFileSync(
      this.ffprobePath,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const info = JSON.parse(raw);
    const streams = info.streams || [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    let fps = null;
    if (video && video.avg_frame_rate && video.avg_frame_rate.includes('/')) {
      const [num, den] = video.avg_frame_rate.split('/').map(Number);
      if (num && den) fps = Math.round((num / den) * 1000) / 1000;
    }
    return {
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      width: video ? Number(video.width) || null : null,
      height: video ? Number(video.height) || null : null,
      fps,
      videoCodec: video ? video.codec_name : null,
      audioCodec: audio ? audio.codec_name : null,
      audioBitrate: audio && audio.bit_rate ? Number(audio.bit_rate) : null
    };
  }

  async remuxIfNeeded(inputFile, preferMp4) {
    if (!preferMp4 || !this.ffmpegPath) return inputFile;
    if (/\.mp4$/i.test(inputFile)) return inputFile;
    const outFile = inputFile.replace(/\.[^.]+$/, '.mp4');
    try {
      execFileSync(
        this.ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputFile, '-c', 'copy', '-movflags', '+faststart', outFile],
        { timeout: 120000, stdio: ['ignore', 'ignore', 'pipe'] }
      );
      if (fileLooksComplete(outFile)) {
        if (outFile !== inputFile) safeUnlink(inputFile);
        return outFile;
      }
    } catch {
      safeUnlink(outFile);
    }
    return inputFile;
  }

  async downloadItem(item) {
    const existing = findExistingOutput(this.outputDir, item);
    if (existing) {
      item.filename = path.basename(existing);
      item.fileSize = fs.statSync(existing).size;
      this.log('info', `#${item.number} уже скачан — пропускаем`);
      return existing;
    }

    this.log('info', `#${item.number} START ${item.url}`);
    this.log('info', `#${item.number} FORMAT CHECK`);
    const info = await this.probeInfo(item.url);
    const title = String(info.title || info.fulltitle || '').trim() || `video-${item.videoId || item.number}`;
    item.title = title;
    this.persist();
    this.emitProgress({ status: `Downloading #${item.number}` });

    const selection = selectBestFormats(info.formats || []);
    item.quality = describeQuality(selection);
    if (selection.video) {
      item.resolution = selection.video.width && selection.video.height
        ? `${selection.video.width}x${selection.video.height}`
        : (selection.video.height ? `${selection.video.height}p` : null);
      item.fps = Number(selection.video.fps) || null;
      item.videoCodec = selection.video.vcodec || null;
    }
    if (selection.audio) {
      item.audioCodec = selection.audio.acodec || null;
      item.audioBitrate = Number(selection.audio.abr || selection.audio.tbr) || null;
    }
    this.log(
      'info',
      `#${item.number} BEST VIDEO: ${item.resolution || 'n/a'} ${item.fps ? `${item.fps}FPS` : ''}`.trim()
    );
    this.log('info', `#${item.number} BEST AUDIO: ${item.audioBitrate ? `${Math.round(item.audioBitrate)}kbps` : 'best'}`);
    this.persist();

    const safeTitle = sanitizeFilename(title);
    const idPart = item.videoId ? ` [${item.videoId}]` : '';
    const template = path.join(this.outputDir, `${safeTitle}${idPart}.%(ext)s`);
    const args = [
      '--no-playlist',
      '--newline',
      '--continue',
      '--no-overwrites',
      '--encoding', 'utf-8',
      '--no-mtime',
      '-f', selection.format || 'bestvideo*+bestaudio/best',
      '-S', 'res,fps,vbr,abr',
      '-o', template,
      '--print', 'after_move:%(filepath)s'
    ];
    if (this.ffmpegPath) args.push('--ffmpeg-location', this.ffmpegPath);
    if (selection.preferMp4) args.push('--merge-output-format', 'mp4');
    args.push(item.url);

    let printedPath = null;
    await this.runYtDlp(args, (line) => {
      const progress = parseProgressLine(line);
      if (progress) {
        this.emitProgress({
          filePercent: progress.percent,
          speed: progress.speed,
          eta: progress.eta,
          status: `Downloading #${item.number} — ${progress.percent}%`
        });
      }
      if (line && !line.startsWith('{') && fs.existsSync(line.trim())) printedPath = line.trim();
      if (line.startsWith('/')) printedPath = line.trim();
    });

    let outputFile = printedPath;
    if (!outputFile || !fs.existsSync(outputFile)) {
      outputFile = findExistingOutput(this.outputDir, { ...item, filename: null });
    }
    if (!outputFile) {
      const prefix = `${safeTitle}${idPart}`;
      const found = fs.readdirSync(this.outputDir).find((name) => name.startsWith(prefix) && !/\.part$/i.test(name));
      if (found) outputFile = path.join(this.outputDir, found);
    }
    if (!fileLooksComplete(outputFile)) {
      throw new Error('Итоговый файл не появился или слишком маленький');
    }

    outputFile = await this.remuxIfNeeded(outputFile, selection.preferMp4);
    const probed = await this.probeOutput(outputFile);
    if (!probed.hasVideo) throw new Error('В результате нет видеопотока');
    if (selection.audio && !probed.hasAudio) throw new Error('В результате нет аудиопотока');

    item.filename = path.basename(outputFile);
    item.fileSize = fs.statSync(outputFile).size;
    if (probed.width && probed.height) item.resolution = `${probed.width}x${probed.height}`;
    if (probed.fps) item.fps = probed.fps;
    if (probed.videoCodec) item.videoCodec = probed.videoCodec;
    if (probed.audioCodec) item.audioCodec = probed.audioCodec;
    if (probed.audioBitrate) item.audioBitrate = Math.round(probed.audioBitrate / 1000);
    this.log('info', `#${item.number} DOWNLOAD SUCCESS`);
    this.log('info', `#${item.number} MERGE SUCCESS`);
    return outputFile;
  }

  markSuccess(item) {
    item.status = STATUS.SUCCESS;
    item.completed = true;
    item.lastError = null;
    item.nextRetry = null;
    if (item.title && !item.titleSaved) {
      appendTitle(this.outputDir, item.title);
      item.titleSaved = true;
      this.log('info', `#${item.number} TITLE SAVED`);
    }
    this.persist();
    this.emitProgress({
      filePercent: 100,
      status: `#${item.number} SUCCESS ${item.resolution || ''} ${item.fps ? `${item.fps} FPS` : ''}`.trim()
    });
  }

  markFailure(item, err) {
    const cancelled = Boolean(err && err.cancelled);
    if (cancelled) {
      item.status = STATUS.WAITING;
      item.lastError = 'Остановлено пользователем';
      this.persist();
      return;
    }
    const kind = classifyError(err && err.message);
    item.attempts += 1;
    item.lastError = String((err && err.message) || err).split('\n').pop().slice(0, 400);
    if (kind === 'PERMANENT') {
      item.status = STATUS.PERMANENT_ERROR;
      item.nextRetry = null;
      this.log('error', `#${item.number} PERMANENT_ERROR ${item.lastError}`);
    } else {
      item.status = STATUS.RETRY;
      const delay = retryDelayMs(item.attempts);
      item.nextRetry = new Date(this.now() + delay).toISOString();
      this.log('error', `#${item.number} ERROR`);
      this.log('warn', `#${item.number} RETRY IN ${Math.round(delay / 1000)}s`);
    }
    this.persist();
    this.emitProgress({ status: `#${item.number} ${item.status}` });
  }

  async processOne(index) {
    if (this.activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      throw new Error('Одновременно можно скачивать только одно видео');
    }
    const item = this.items[index];
    this.activeDownloads = 1;
    this.currentItem = item;
    item.status = STATUS.DOWNLOADING;
    this.persist();
    this.emitProgress({ status: `Downloading #${item.number}` });
    try {
      await this.downloadItem(item);
      this.markSuccess(item);
    } catch (err) {
      this.markFailure(item, err);
      if (item.status === STATUS.RETRY) this.moveToEnd(this.items.indexOf(item));
    } finally {
      this.activeDownloads = 0;
      this.currentItem = null;
      this.currentChild = null;
    }
  }

  async run() {
    if (this.running) throw new Error('Очередь уже запущена');
    if (!this.outputDir) throw new Error('Не выбрана папка для сохранения.');
    if (!this.ffmpegPath || (this.ffmpegPath !== 'ffmpeg' && !fs.existsSync(this.ffmpegPath))) {
      throw new Error('FFmpeg не найден. Установите/укажите путь к FFmpeg.');
    }
    if (!this.runner && !ytdlpExists(this.ytdlpPath)) {
      throw new Error('yt-dlp не найден. Установите/укажите путь к yt-dlp.');
    }

    fs.mkdirSync(this.outputDir, { recursive: true });
    if (!fs.existsSync(path.join(this.outputDir, TITLES_FILE))) {
      fs.writeFileSync(path.join(this.outputDir, TITLES_FILE), '', 'utf8');
    }
    if (!fs.existsSync(path.join(this.outputDir, LOG_FILE))) {
      fs.writeFileSync(path.join(this.outputDir, LOG_FILE), '', 'utf8');
    }

    this.running = true;
    this.stopped = false;
    this.paused = false;
    this.reconcileExisting();
    this.log('info', `Очередь: ${this.items.length} ссылок, папка ${this.outputDir}`);

    try {
      while (this.unfinished() && !this.stopped) {
        if (this.paused) {
          await this.sleep(250);
          continue;
        }
        const index = this.pickReadyIndex();
        if (index < 0) {
          const nextAt = this.nearestRetryAt();
          if (nextAt == null) break;
          const wait = Math.max(250, Math.min(nextAt - this.now(), 1000));
          this.emitProgress({
            status: `${summarizeItems(this.items).retry} videos waiting for automatic retry...`
          });
          await this.sleep(wait);
          continue;
        }
        await this.processOne(index);
      }

      const counts = summarizeItems(this.items);
      const done = !this.unfinished();
      if (done) {
        this.log(
          'success',
          `DOWNLOAD COMPLETE Total:${counts.total} Success:${counts.completed} Permanent:${counts.permanent}`
        );
      } else if (this.stopped) {
        this.log('warn', 'Очередь остановлена, прогресс сохранён');
      } else if (counts.retry) {
        this.log('warn', `${counts.retry} videos waiting for automatic retry...`);
      }
      this.persist();
      this.emitProgress({
        status: done
          ? 'DOWNLOAD COMPLETE'
          : this.stopped
            ? 'Остановлено'
            : `${counts.retry} videos waiting for automatic retry...`
      });
      return { ...counts, cancelled: this.stopped, complete: done };
    } finally {
      this.running = false;
      this.activeDownloads = 0;
      this.currentItem = null;
      this.currentChild = null;
    }
  }
}

module.exports = {
  DownloadQueue,
  MAX_CONCURRENT_DOWNLOADS,
  QUEUE_FILE,
  TITLES_FILE,
  LOG_FILE,
  STATUS,
  RETRY_DELAYS_MS,
  parseLinkList,
  extractVideoId,
  normalizeWatchUrl,
  retryDelayMs,
  classifyError,
  sanitizeFilename,
  selectBestFormats,
  describeQuality,
  parseProgressLine,
  mergeUrlsIntoQueue,
  loadQueueFile,
  resolveYtDlpPath,
  ytdlpExists,
  summarizeItems,
  formatBytes
};
