'use strict';

/**
 * downloader.js — массовое скачивание YouTube / Shorts с умной очередью.
 *
 * Одновременно качается до `concurrency` видео (каждое — своим yt-dlp с aria2c
 * на несколько соединений). Ошибка одной ссылки не останавливает остальные:
 * ссылка уходит в конец очереди и повторяется с нарастающей паузой.
 * Модуль не зависит от Electron (см. scripts/download-smoke-test.js).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');

/** Значение по умолчанию для библиотеки; приложение передаёт выбор из интерфейса. */
const MAX_CONCURRENT_DOWNLOADS = 1;
/** Больше 6 параллельных yt-dlp YouTube начинает отвечать 403/429. */
const MAX_PARALLEL_DOWNLOADS = 6;
const DEFAULT_PARALLEL_DOWNLOADS = 3;
/** Фрагменты DASH/HLS, которые yt-dlp качает сам (без aria2c). */
const CONCURRENT_FRAGMENTS = 4;
const QUEUE_FILE = 'download_queue.json';
const TITLES_FILE = 'nazvaniya.txt';
const LOG_FILE = 'download_log.txt';
const MIN_OUTPUT_BYTES = 4096;
const QUEUE_VERSION = 1;
const STALL_TIMEOUT_MS = 180_000;
const SOCKET_TIMEOUT_SEC = 60;
const DOWNLOAD_RETRIES = 15;
const FRAGMENT_RETRIES = 15;
const HTTP_CHUNK_SIZE = '10M';
/** Тот же -f, что у Media Downloader: сначала H.264+AAC в mp4, иначе лучшее. */
// Всегда берём максимальное доступное видео (включая vp9/av1 выше 1080p);
// порядок качества задаёт QUALITY_SORT.
const FALLBACK_FORMAT = 'bv*+ba/bv*+ba*/b';
/** Сначала разрешение и fps, и только при равенстве — h264/AAC. */
const QUALITY_SORT = 'res,fps,vbr,abr,vcodec:h264,acodec:aac';
/** Как yt-dlp-aria2c в Media Downloader: много соединений, короткий connect, докачка. */
const ARIA2_DOWNLOADER_ARGS = [
  '-x 8',
  '-s 8',
  '-k 1M',
  '--file-allocation=none',
  '--min-split-size=1M',
  '--max-tries=5',
  '--retry-wait=1',
  '--connect-timeout=8',
  '--timeout=60',
  '--disable-ipv6=true',
  '--always-resume=true',
  '--auto-file-renaming=false',
  '--allow-overwrite=true'
].join(' ');
/**
 * tv / android_sdkless / web в 2026 ломают извлечение: LOGIN_REQUIRED, 403, SABR.
 * default yt-dlp сам перебирает живые клиенты; android_sdkless исключаем явно.
 */
const YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=default,-android_sdkless';

const STATUS = {
  WAITING: 'WAITING',
  DOWNLOADING: 'DOWNLOADING',
  SUCCESS: 'SUCCESS',
  RETRY: 'RETRY',
  PERMANENT_ERROR: 'PERMANENT_ERROR',
  SKIPPED: 'SKIPPED'
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

function vendorRuntimeName(kind) {
  if (kind === 'quickjs') return process.platform === 'win32' ? 'qjs.exe' : 'qjs';
  return process.platform === 'win32' ? 'deno.exe' : 'deno';
}

function siblingFile(bin, name) {
  if (!bin || !name || bin === 'yt-dlp' || bin === 'yt-dlp.exe') return null;
  return path.join(path.dirname(bin), name);
}

function firstExisting(paths) {
  return (paths || []).find((file) => file && fs.existsSync(file)) || null;
}

function vendorBinDir(ytdlpPath) {
  if (ytdlpPath && ytdlpPath !== 'yt-dlp' && ytdlpPath !== 'yt-dlp.exe' && fs.existsSync(ytdlpPath)) {
    return path.dirname(ytdlpPath);
  }
  return path.join(__dirname, 'vendor', 'yt-dlp');
}

function resolveAria2cPath(ytdlpPath) {
  const name = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';
  const vendorDir = path.join(__dirname, 'vendor', 'yt-dlp');
  return firstExisting([
    siblingFile(ytdlpPath, name),
    unpackedPath(path.join(vendorDir, name)),
    path.join(vendorDir, name)
  ]);
}

function buildAria2cDownloaderArgs(aria2cPath) {
  if (!aria2cPath) return [];
  return [
    '--downloader',
    'aria2c',
    '--downloader',
    'dash,m3u8:native',
    '--downloader-args',
    `aria2c:${ARIA2_DOWNLOADER_ARGS}`
  ];
}

function resolveJsRuntimeArgs(ytdlpPath) {
  const denoName = vendorRuntimeName('deno');
  const qjsName = vendorRuntimeName('quickjs');
  const vendorDir = path.join(__dirname, 'vendor', 'yt-dlp');
  const deno = firstExisting([
    siblingFile(ytdlpPath, denoName),
    unpackedPath(path.join(vendorDir, denoName)),
    path.join(vendorDir, denoName)
  ]);
  if (deno) return ['--js-runtimes', `deno:${deno}`];

  const qjs = firstExisting([
    siblingFile(ytdlpPath, qjsName),
    unpackedPath(path.join(vendorDir, qjsName)),
    path.join(vendorDir, qjsName)
  ]);
  if (qjs) return ['--js-runtimes', `quickjs:${qjs}`];

  const major = Number(String(process.versions.node || '0').split('.')[0]);
  if (major >= 22 && /node(\.exe)?$/i.test(process.execPath || '')) {
    return ['--js-runtimes', `node:${process.execPath}`];
  }
  return [];
}

function cookieBrowserCandidates() {
  if (process.platform === 'win32') return ['edge', 'chrome', 'firefox'];
  if (process.platform === 'darwin') return ['chrome', 'safari', 'firefox'];
  return ['chrome', 'firefox', 'chromium'];
}

function isBotCheckError(message) {
  return /sign in to confirm you.re not a bot|not a bot|use --cookies/i.test(String(message || ''));
}

/** Браузер не установлен, запущен и держит базу cookies, или её не расшифровать. */
function isCookieError(message) {
  return /cookies? database|could not copy .*cookie|failed to decrypt|could not find .*(cookie|profile)|unsupported browser|keyring|cookies from browser/i.test(
    String(message || '')
  );
}

function shortYtError(message) {
  const line = String(message || '')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .pop() || 'неизвестная ошибка yt-dlp';
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

function buildBaseYtDlpArgs({ ytdlpPath, cookiesFromBrowser } = {}) {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--encoding',
    'utf-8',
    '--socket-timeout',
    String(SOCKET_TIMEOUT_SEC),
    '--force-ipv4',
    '--extractor-retries',
    '3',
    '--extractor-args',
    YOUTUBE_EXTRACTOR_ARGS,
    ...resolveJsRuntimeArgs(ytdlpPath)
  ];
  if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
  return args;
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
    .replace(/#/g, '')
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

// --------------------------------------------------------------- Аудиодорожки

/**
 * Языки аудио для интерфейса. value — то, что хранится в очереди (item.audioLang).
 * names нужны, чтобы сопоставлять метаданные yt-dlp (language / format_note)
 * с выбором пользователя. Конкретные audio format_id НЕ хардкодятся:
 * дорожка всегда ищется по метаданным языка и признаку original.
 */
const AUDIO_LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Авто', flag: '🎧' },
  { value: 'original', label: 'Original', flag: '🌎' },
  { value: 'ru', label: 'Русский', flag: '🇷🇺', names: ['russian', 'русск'] },
  { value: 'en', label: 'English', flag: '🇬🇧', names: ['english', 'англ'] },
  { value: 'es', label: 'Español', flag: '🇪🇸', names: ['spanish', 'español', 'espanol', 'castellano'] },
  { value: 'de', label: 'Deutsch', flag: '🇩🇪', names: ['german', 'deutsch'] },
  { value: 'fr', label: 'Français', flag: '🇫🇷', names: ['french', 'français', 'francais'] },
  { value: 'it', label: 'Italiano', flag: '🇮🇹', names: ['italian', 'italiano'] },
  { value: 'pt', label: 'Português', flag: '🇵🇹', names: ['portuguese', 'português', 'portugues'] },
  { value: 'other', label: 'Другой', flag: '🌐' }
];

const DEFAULT_AUDIO_LANG = 'auto';

/** Трёхбуквенные коды из ffprobe/MP4 → коды проекта. */
const AUDIO_LANG_TO_ISO3 = {
  ru: 'rus',
  en: 'eng',
  es: 'spa',
  de: 'deu',
  fr: 'fra',
  it: 'ita',
  pt: 'por'
};

/** AAC/m4a сохраняет тег языка при слиянии; webm/opus — теряет. */
function isAacTrack(track) {
  if (!track) return false;
  return /(mp4a|aac)/i.test(String(track.acodec || '')) || /m4a/i.test(String(track.ext || ''));
}

/** Двухбуквенный код -> тег для MP4 (`-metadata language=...`). */
function audioLangToIso3(code) {
  const short = normalizeAudioLang(code);
  if (!short || short === 'auto' || short === 'original' || short === 'other') return null;
  return AUDIO_LANG_TO_ISO3[short] || null;
}

const AUDIO_LANG_ISO3 = {
  rus: 'ru',
  eng: 'en',
  spa: 'es',
  esp: 'es',
  ger: 'de',
  deu: 'de',
  fre: 'fr',
  fra: 'fr',
  ita: 'it',
  por: 'pt'
};

/** Приводит выбор пользователя/метаданные к внутреннему коду языка. */
function normalizeAudioLang(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text || text === 'auto' || text === 'default' || text === 'other') return 'auto';
  if (text === 'original' || text === 'orig') return 'original';
  if (AUDIO_LANG_ISO3[text]) return AUDIO_LANG_ISO3[text];
  const byName = AUDIO_LANGUAGE_OPTIONS.find(
    (opt) => Array.isArray(opt.names) && opt.names.some((name) => text.startsWith(name))
  );
  if (byName) return byName.value;
  return text.split(/[-_ ]/)[0].slice(0, 8);
}

function audioLangOption(value) {
  const code = normalizeAudioLang(value);
  return AUDIO_LANGUAGE_OPTIONS.find((opt) => opt.value === code) || null;
}

function audioLangLabel(value) {
  const option = audioLangOption(value);
  if (option) return option.label;
  const code = normalizeAudioLang(value);
  return code ? code.toUpperCase() : 'Авто';
}

function audioLangFlag(value) {
  const option = audioLangOption(value);
  return (option && option.flag) || '🌐';
}

/** "🇷🇺 Русский" — то, что показываем в очереди. */
function describeAudioLang(value) {
  return `${audioLangFlag(value)} ${audioLangLabel(value)}`.trim();
}

function audioMissingMessage(value) {
  return `⚠ ${audioLangLabel(value)} недоступен`;
}

/** Ищет язык в текстовой пометке дорожки ("Russian original (default)"). */
function audioLangFromNote(note) {
  const text = String(note || '').toLowerCase();
  if (!text) return null;
  const found = AUDIO_LANGUAGE_OPTIONS.find(
    (opt) => Array.isArray(opt.names) && opt.names.some((name) => text.includes(name))
  );
  return found ? found.value : null;
}

/**
 * Собирает список доступных аудиодорожек из info.formats yt-dlp:
 * язык, original-статус, format_id, битрейт, доступность.
 */
function collectAudioTracks(formats, info = {}) {
  const list = Array.isArray(formats) ? formats.filter(Boolean) : [];
  const isNone = (value) => !value || value === 'none';
  const rawOriginal = (info && (info.language || info.original_language)) || '';
  const originalLang = rawOriginal ? normalizeAudioLang(rawOriginal) : null;
  return list
    .filter((fmt) => !isNone(fmt.acodec) && isNone(fmt.vcodec))
    .map((fmt) => {
      const note = String(fmt.format_note || fmt.audio_track_note || '').trim();
      const lowNote = note.toLowerCase();
      const trackLang = fmt.audio_track && (fmt.audio_track.language || fmt.audio_track.id);
      const rawLang = fmt.language || trackLang || '';
      const language = rawLang ? normalizeAudioLang(rawLang) : audioLangFromNote(lowNote);
      const isDub = /dub|dubbed|дубл/.test(lowNote);
      const isOriginal = Boolean(
        /original|оригинал/.test(lowNote) ||
          Number(fmt.language_preference) >= 10 ||
          (!isDub && originalLang && originalLang !== 'auto' && language === originalLang)
      );
      const code = language && language !== 'auto' ? language : null;
      return {
        formatId: fmt.format_id == null ? null : String(fmt.format_id),
        language: code,
        languageLabel: code ? audioLangLabel(code) : 'unknown',
        note: note || null,
        isOriginal,
        isDub,
        abr: Number(fmt.abr || fmt.tbr) || 0,
        asr: Number(fmt.asr) || 0,
        ext: fmt.ext || null,
        acodec: fmt.acodec || null,
        available: Boolean(fmt.format_id) && !fmt.has_drm && String(fmt.protocol || '') !== 'unsupported'
      };
    });
}

/** Человеческий список языков для строки "🌐 Языки: Original, Русский, English". */
function summarizeAudioTracks(tracks) {
  const labels = [];
  (tracks || []).forEach((track) => {
    if (!track) return;
    const base = track.language ? audioLangLabel(track.language) : 'Unknown';
    const label = track.isOriginal ? (track.language ? `${base} (Original)` : 'Original') : base;
    if (!labels.includes(label)) labels.push(label);
  });
  return labels;
}

/**
 * Выбирает дорожку под запрос пользователя.
 * Приоритеты: точный язык → original, если он запрошен → не дубляж →
 * максимальный битрейт. Другой язык как fallback НЕ выбирается никогда.
 */
function selectAudioTrack(tracks, preference, info = {}) {
  const requested = normalizeAudioLang(preference);
  const usable = (tracks || []).filter((track) => track && track.available && track.formatId);
  if (requested === 'auto') {
    return { ok: true, requested, mode: 'auto', track: null, language: 'auto' };
  }
  if (!usable.length) return { ok: false, requested, reason: 'no-tracks' };

  const score = (track) => [
    requested === 'original' ? (track.isOriginal ? 1 : 0) : 0,
    requested === 'original' ? (track.isDub ? 0 : 1) : 0,
    // AAC/m4a важнее битрейта: opus в MP4 не воспроизводится большинством плееров.
    isAacTrack(track) ? 1 : 0,
    track.abr,
    track.asr
  ];
  const cmp = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  };
  const bestOf = (items) => items.slice().sort((a, b) => cmp(score(b), score(a)))[0] || null;

  let candidates = [];
  if (requested === 'original') {
    candidates = usable.filter((track) => track.isOriginal);
    if (!candidates.length) {
      const rawOriginal = (info && (info.language || info.original_language)) || '';
      const originalLang = rawOriginal ? normalizeAudioLang(rawOriginal) : null;
      if (originalLang && originalLang !== 'auto') {
        candidates = usable.filter((track) => track.language === originalLang);
      }
    }
    // Обычное видео с единственной дорожкой — она и есть оригинал.
    if (!candidates.length && usable.length === 1) candidates = usable.slice();
  } else {
    candidates = usable.filter((track) => track.language === requested);
  }

  if (!candidates.length) {
    return {
      ok: false,
      requested,
      reason: requested === 'original' ? 'no-original' : 'language-missing'
    };
  }
  const track = bestOf(candidates);
  return { ok: true, requested, mode: 'explicit', track, language: track.language || requested };
}

/**
 * Селектор формата: пинится только выбранная аудиодорожка, видео остаётся
 * "лучшее доступное". Fallback на чужое аудио (b/best) не добавляем.
 */
function buildAudioLangFormat(audioFormatId, languageCode) {
  const id = String(audioFormatId || '').trim();
  const lang = normalizeAudioLang(languageCode);
  const code = lang && !['auto', 'original', 'other'].includes(lang) ? lang : null;
  // Код языка устойчив, а суффикс format_id (140-1, 251-3) yt-dlp нумерует заново
  // на каждом запуске, и тот же номер может указывать на другой язык.
  // Поэтому сначала фильтр по языку, и только потом format_id.
  const parts = [];
  if (code) {
    parts.push(`bv*+ba[language^=${code}]`);
    parts.push(`bv*+ba*[language^=${code}]`);
  }
  if (id) {
    parts.push(`bv*+${id}`);
    parts.push(id);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * Разбор вывода `ffmpeg -i file`: нужно, когда ffprobe недоступен,
 * но язык аудиодорожки в готовом MP4 всё равно нужно проверить.
 */
function parseFfmpegStreamInfo(text) {
  const lines = String(text || '').split(/\r?\n/);
  const videoLine = lines.find((line) => /:\s*Video:/.test(line)) || '';
  const audioLine = lines.find((line) => /:\s*Audio:/.test(line)) || '';
  const size = videoLine.match(/(\d{2,5})x(\d{2,5})/);
  const fpsMatch = videoLine.match(/([\d.]+)\s+fps/) || videoLine.match(/([\d.]+)\s+tbr/);
  const bitrate = audioLine.match(/(\d+)\s*kb\/s/);
  const langMatch = audioLine.match(/Stream #\d+:\d+(?:\[[^\]]*\])?\(([A-Za-z]{2,3})\)/);
  const language = langMatch ? langMatch[1].toLowerCase() : null;
  return {
    hasVideo: Boolean(videoLine),
    hasAudio: Boolean(audioLine),
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: fpsMatch ? Number(fpsMatch[1]) : null,
    videoCodec: (videoLine.match(/Video:\s*([A-Za-z0-9_]+)/) || [])[1] || null,
    audioCodec: (audioLine.match(/Audio:\s*([A-Za-z0-9_]+)/) || [])[1] || null,
    audioBitrate: bitrate ? Number(bitrate[1]) * 1000 : null,
    audioLanguage: language && language !== 'und' ? language : null
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

function cleanProgressToken(value) {
  const text = String(value || '').trim();
  if (!text || /^(unknown|n\/?a|none|-)$/i.test(text)) return '';
  return text;
}

function parseProgressLine(line) {
  const text = String(line || '').replace(/\r/g, '').trim();
  if (!text) return null;

  const custom = text.match(/^PROGRESS\s+(\d+(?:\.\d+)?)%?(?:\s+(\S+))?(?:\s+(\S+))?/i);
  if (custom) {
    return {
      percent: Number(custom[1]),
      speed: cleanProgressToken(custom[2]),
      eta: cleanProgressToken(custom[3])
    };
  }

  const aria = text.match(/\[#[0-9a-fA-F]+[^\]]*?\((\d+(?:\.\d+)?)%\)[^\]]*?CN:\d+\s+DL:(\S+)(?:\s+ETA:(\S+))?/i);
  if (aria) {
    return {
      percent: Number(aria[1]),
      speed: cleanProgressToken(aria[2]),
      eta: cleanProgressToken(aria[3])
    };
  }

  const percentMatch = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
  if (!percentMatch) return null;
  const speedMatch = text.match(/\bat\s+(\S+(?:\/s)?)/i);
  const etaMatch = text.match(/\bETA\s+(\S+)/i);
  return {
    percent: Number(percentMatch[1]),
    speed: cleanProgressToken(speedMatch && speedMatch[1]),
    eta: cleanProgressToken(etaMatch && etaMatch[1])
  };
}

function isDownloadTemp(name) {
  const file = String(name || '');
  return /\.(part|ytdl|temp|info\.json|aria2)$/i.test(file) || /\.f\d+\./i.test(file);
}

function fileMatchesVideoId(name, videoId) {
  if (!videoId || !name) return false;
  if (isDownloadTemp(name)) return false;
  if (name.includes(`[${videoId}]`)) return true;
  const stem = name.replace(/\.[^.]+$/, '');
  return stem === videoId || stem.endsWith(`_${videoId}`) || stem.startsWith(`${videoId}_`);
}

function shouldLogYtDlpLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('{')) return false;
  if (parseProgressLine(text)) return false;
  return (
    /\[(youtube|info|Merger|ExtractAudio|ffmpeg|Fixup|download|aria2c)\]/i.test(text) ||
    /^(WARNING|ERROR)/i.test(text) ||
    /Downloading (webpage|android|ios|tv|player|API|1 format)/i.test(text) ||
    /JS runtime|Running deno|Extracting URL/i.test(text)
  );
}

function buildYtDlpDownloadArgs({
  url,
  template,
  format,
  ffmpegPath,
  preferMp4,
  ytdlpPath,
  cookiesFromBrowser,
  aria2cPath
}) {
  const aria = aria2cPath || resolveAria2cPath(ytdlpPath);
  const args = [
    ...buildBaseYtDlpArgs({ ytdlpPath, cookiesFromBrowser }),
    ...buildAria2cDownloaderArgs(aria),
    '--newline',
    '--progress',
    '--no-quiet',
    '--no-simulate',
    '--continue',
    '--no-overwrites',
    '--no-mtime',
    '--windows-filenames',
    '--output-na-placeholder',
    'NA',
    '--retries',
    String(DOWNLOAD_RETRIES),
    '--fragment-retries',
    String(FRAGMENT_RETRIES),
    '--retry-sleep',
    'http:linear=1:8:2',
    '--retry-sleep',
    'fragment:linear=1:8:2',
    '--file-access-retries',
    '8',
    '--http-chunk-size',
    HTTP_CHUNK_SIZE,
    '--concurrent-fragments',
    String(CONCURRENT_FRAGMENTS),
    '--no-check-formats',
    '--write-info-json',
    '-f',
    format || FALLBACK_FORMAT,
    '-S',
    QUALITY_SORT,
    '-o',
    template,
    '--progress-template',
    'download:PROGRESS %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s'
  ];
  if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
  if (preferMp4) args.push('--merge-output-format', 'mp4');
  args.push(url);
  return args;
}

function normalizeConcurrency(value, fallback = MAX_CONCURRENT_DOWNLOADS) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_PARALLEL_DOWNLOADS, n);
}

/** Асинхронный execFile: ffmpeg/ffprobe не должны блокировать главный процесс Electron. */
function runFile(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

const SPEED_UNITS = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** «8.40MiB/s», «1.2MiB», «850KiB/s» → байт/с. */
function parseSpeedBytes(text) {
  const match = String(text || '').match(/([\d.]+)\s*([KMG]?)i?B/i);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = SPEED_UNITS[(match[2] || 'B').toUpperCase()] || 1;
  return Number.isFinite(value) ? value * unit : 0;
}

function formatSpeed(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)}MiB/s`;
  return `${Math.round(bytes / 1024)}KiB/s`;
}

function renameToPrettyFilename(outputFile, item, safeTitle) {
  if (!outputFile || !safeTitle) return outputFile;
  const ext = path.extname(outputFile) || '.mp4';
  const idPart = item.videoId ? ` [${item.videoId}]` : '';
  const dest = path.join(path.dirname(outputFile), `${safeTitle}${idPart}${ext}`);
  if (path.resolve(dest) === path.resolve(outputFile)) return outputFile;
  try {
    if (fileLooksComplete(dest)) {
      safeUnlink(outputFile);
      return dest;
    }
    fs.renameSync(outputFile, dest);
    return dest;
  } catch {
    return outputFile;
  }
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
    titleSaved: false,
    audioLang: DEFAULT_AUDIO_LANG,
    audioLangResolved: null,
    audioTrackLanguage: null,
    audioFormatId: null,
    audioTracks: null,
    audioLanguages: null,
    audioMissing: false,
    audioChecked: false,
    audioVerified: null,
    originalAudioLang: null
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

function mergeUrlsIntoQueue(existingItems, urls, options = {}) {
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
    // Глобальный «Язык аудио по умолчанию» действует только на новые ссылки.
    if (options.defaultAudioLang) item.audioLang = normalizeAudioLang(options.defaultAudioLang);
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
  if (!item.videoId || !outputDir || !fs.existsSync(outputDir)) return null;
  const names = fs.readdirSync(outputDir);
  const match = names.find((name) => fileMatchesVideoId(name, item.videoId));
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
    permanent: 0,
    skipped: 0
  };
  items.forEach((item) => {
    if (item.status === STATUS.SUCCESS) counts.completed += 1;
    else if (item.status === STATUS.DOWNLOADING) counts.downloading += 1;
    else if (item.status === STATUS.RETRY) counts.retry += 1;
    else if (item.status === STATUS.PERMANENT_ERROR) counts.permanent += 1;
    else if (item.status === STATUS.SKIPPED) counts.skipped += 1;
    else counts.waiting += 1;
  });
  return counts;
}

/**
 * Удаляет файл очереди (и, по желанию, лог) в папке загрузок.
 * Видео и nazvaniya.txt остаются на месте.
 */
function clearQueueFiles(outputDir, options = {}) {
  const removed = [];
  if (!outputDir) return { removed, removedFiles: 0 };
  const targets = [QUEUE_FILE];
  if (options.clearLog) targets.push(LOG_FILE);
  targets.forEach((name) => {
    const file = path.join(outputDir, name);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(name);
      }
    } catch {
      /* файл может быть занят — не критично */
    }
  });
  return { removed, removedFiles: removed.length };
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
    this.concurrency = normalizeConcurrency(options.concurrency);
    this.activeDownloads = 0;
    /** item → { percent, speed, eta } для каждой идущей загрузки. */
    this.activeItems = new Map();
    this.children = new Set();
    this.cookiesFromBrowser = options.cookiesFromBrowser || null;
    this.failedCookieBrowsers = new Set();
    this.defaultAudioLang = normalizeAudioLang(options.defaultAudioLang || DEFAULT_AUDIO_LANG);
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
    const active = Array.from(this.activeItems.entries())
      .sort(([a], [b]) => a.number - b.number)
      .map(([item, live]) => ({
        number: item.number,
        title: item.title || item.url,
        url: item.url,
        percent: Number(live.percent) || 0,
        speed: live.speed || '',
        eta: live.eta || '',
        quality: item.quality || 'AUTO',
        audioLang: item.audioLang || DEFAULT_AUDIO_LANG,
        audioLangText: describeAudioLang(item.audioLang || DEFAULT_AUDIO_LANG),
        resolution: item.resolution || null,
        fps: item.fps || null,
        status: item.status
      }));
    const totalSpeed = active.reduce((sum, entry) => sum + parseSpeedBytes(entry.speed), 0);
    this.hooks.onProgress({
      ...counts,
      overallPercent: counts.total ? (counts.completed / counts.total) * 100 : 0,
      current: active[0] || null,
      active,
      concurrency: this.concurrency,
      totalSpeed: formatSpeed(totalSpeed),
      items: this.items.map((item) => ({
        number: item.number,
        url: item.url,
        status: item.status,
        title: item.title || '—',
        quality: item.quality || 'AUTO',
        audioLang: item.audioLang || DEFAULT_AUDIO_LANG,
        audioLangText: describeAudioLang(item.audioLang || DEFAULT_AUDIO_LANG),
        audioLangResolved: item.audioLangResolved || null,
        audioLanguages: item.audioLanguages || null,
        audioMissing: Boolean(item.audioMissing),
        audioChecked: Boolean(item.audioChecked),
        audioVerified: item.audioVerified,
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

  /**
   * Полная очистка очереди: список ссылок и download_queue.json.
   * Скачанные видео и nazvaniya.txt не трогаем — их удаление необратимо.
   */
  clearQueue(options = {}) {
    if (this.running) throw new Error('Сначала остановите очередь.');
    this.items = [];
    this.activeItems.clear();
    const result = clearQueueFiles(this.outputDir, options);
    this.emitProgress({ status: 'Очередь очищена' });
    return result;
  }

  setLinks(text, options = {}) {
    const urls = parseLinkList(text);
    const existing = this.items.length ? this.items : this.loadFromDisk();
    if (options.defaultAudioLang) this.defaultAudioLang = normalizeAudioLang(options.defaultAudioLang);
    this.items = mergeUrlsIntoQueue(existing, urls, { defaultAudioLang: this.defaultAudioLang });
    this.reconcileExisting();
    this.emitProgress({ status: `В очереди ${this.items.length} ссылок` });
    return this.items;
  }

  stopCurrentProcess() {
    const children = Array.from(this.children);
    this.children.clear();
    children.forEach((child) => {
      if (!child || child.killed) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* процесс мог уже завершиться */
      }
    });
  }

  pause() {
    this.paused = true;
    this.log('warn', 'PAUSE — новые загрузки не стартуют, текущие останавливаются');
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
      if (item.status === STATUS.SKIPPED) continue;
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
      (item) =>
        item.status !== STATUS.SUCCESS &&
        item.status !== STATUS.PERMANENT_ERROR &&
        item.status !== STATUS.SKIPPED
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
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${vendorBinDir(this.ytdlpPath)}${path.delimiter}${process.env.PATH || ''}`,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8'
        }
      });
      this.children.add(child);
      let stdout = '';
      let stderr = '';
      let leftover = '';
      let lastData = this.now();
      let stalled = false;
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearInterval(stallTimer);
        this.children.delete(child);
        fn(value);
      };

      const flushText = (text) => {
        leftover += text;
        const parts = leftover.split(/\r\n|\n|\r/);
        leftover = parts.pop() || '';
        parts.forEach((line) => {
          if (line && typeof onLine === 'function') onLine(line);
        });
      };

      const handle = (chunk, stream) => {
        lastData = this.now();
        const text = chunk.toString('utf8');
        if (stream === 'out') stdout += text;
        else stderr += text;
        flushText(text);
      };

      const stallTimer = setInterval(() => {
        if (settled) return;
        if (this.now() - lastData < STALL_TIMEOUT_MS) return;
        stalled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* процесс мог уже завершиться */
        }
      }, 2000);

      child.stdout.on('data', (chunk) => handle(chunk, 'out'));
      child.stderr.on('data', (chunk) => handle(chunk, 'err'));
      child.on('error', (err) => finish(reject, err));
      child.on('close', (code) => {
        if (leftover && typeof onLine === 'function') onLine(leftover);
        leftover = '';
        if (this.stopped || this.paused) {
          const err = new Error('Загрузка остановлена пользователем');
          err.cancelled = true;
          finish(reject, err);
          return;
        }
        if (stalled) {
          finish(reject, new Error('yt-dlp завис без ответа. Повторю ссылку автоматически.'));
          return;
        }
        if (code === 0) {
          finish(resolve, { stdout, stderr });
          return;
        }
        finish(
          reject,
          new Error((stderr || stdout || `yt-dlp exited ${code}`).trim().split('\n').slice(-8).join('\n'))
        );
      });
    });
  }

  async probeInfo(url, extra = {}) {
    const { stdout, stderr } = await this.runYtDlp([
      '-J',
      '--no-warnings',
      ...buildBaseYtDlpArgs({
        ytdlpPath: this.ytdlpPath,
        cookiesFromBrowser: extra.cookiesFromBrowser || this.cookiesFromBrowser
      }),
      url
    ]);
    const start = stdout.indexOf('{');
    if (start < 0) {
      throw new Error(shortYtError(stderr || stdout) || 'yt-dlp не вернул информацию о видео');
    }
    const info = JSON.parse(stdout.slice(start));
    if (!info || typeof info !== 'object') throw new Error('yt-dlp не вернул информацию о видео');
    return info;
  }

  applyInfo(item, info) {
    if (!info || typeof info !== 'object') return;
    const title = String(info.title || info.fulltitle || '').trim();
    if (title) item.title = title;
    const selection = selectBestFormats(info.formats || []);
    if (selection && selection.video) {
      item.quality = describeQuality(selection);
      item.resolution = selection.video.width && selection.video.height
        ? `${selection.video.width}x${selection.video.height}`
        : (selection.video.height ? `${selection.video.height}p` : item.resolution);
      item.fps = Number(selection.video.fps) || item.fps;
      item.videoCodec = selection.video.vcodec || item.videoCodec;
    }
    if (selection && selection.audio) {
      item.audioCodec = selection.audio.acodec || item.audioCodec;
      item.audioBitrate = Number(selection.audio.abr || selection.audio.tbr) || item.audioBitrate;
    }
    return selection;
  }

  readSidecarInfo(outputFile) {
    if (!outputFile) return null;
    const base = outputFile.replace(/\.[^.]+$/, '');
    const candidates = [`${base}.info.json`, `${outputFile}.info.json`];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        const info = JSON.parse(readUtf8(file));
        safeUnlink(file);
        return info;
      } catch {
        safeUnlink(file);
      }
    }
    return null;
  }

  async probeOutput(file) {
    if (this.ffprobePath) {
      try {
        return await this.probeOutputWithFfprobe(file);
      } catch (err) {
        this.log(
          'warn',
          `ffprobe недоступен (${shortYtError(err && err.message)}) — читаем готовый фаил через ffmpeg`
        );
        this.ffprobePath = null;
      }
    }
    return this.probeOutputWithFfmpeg(file);
  }

  /** Резервное чтение файла без ffprobe. */
  async probeOutputWithFfmpeg(file) {
    const unknown = {
      hasVideo: true,
      hasAudio: true,
      width: null,
      height: null,
      fps: null,
      videoCodec: null,
      audioCodec: null,
      audioBitrate: null,
      audioLanguage: null
    };
    if (!this.ffmpegPath) return unknown;
    let text = '';
    try {
      const { stdout, stderr } = await runFile(this.ffmpegPath, ['-hide_banner', '-i', file], 60000);
      text = `${stderr}${stdout}`;
    } catch (err) {
      text = `${(err && err.stderr) || ''}${(err && err.stdout) || ''}`;
    }
    if (!text.trim()) return unknown;
    return parseFfmpegStreamInfo(text);
  }

  async probeOutputWithFfprobe(file) {
    const { stdout: raw } = await runFile(
      this.ffprobePath,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      20000
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
      audioBitrate: audio && audio.bit_rate ? Number(audio.bit_rate) : null,
      audioLanguage:
        audio && audio.tags ? audio.tags.language || audio.tags.LANGUAGE || null : null
    };
  }

  /**
   * Гарантирует, что звук в MP4 реально играется, и проставляет язык дорожки.
   * yt-dlp может слить opus/vorbis (формат 251) в MP4 — такой файл открывается
   * "без звука" в проигрывателях и редакторах. Плюс mov-муксер ffmpeg по
   * умолчанию помечает дорожку как «eng», из-за чего проверка языка ругалась.
   */
  async ensureMp4Audio(item, file, audioPlan) {
    if (!this.ffmpegPath || !/\.mp4$/i.test(String(file || ''))) return file;
    const probed = await this.probeOutput(file);
    const codec = String(probed.audioCodec || '').toLowerCase();
    const needsAac = Boolean(codec) && !/(aac|mp4a|alac)/.test(codec);
    const expected =
      (audioPlan && audioPlan.track && audioPlan.track.language) ||
      (audioPlan && audioPlan.language) ||
      null;
    const iso3 = audioLangToIso3(expected);
    const actual = probed && probed.audioLanguage ? String(probed.audioLanguage).toLowerCase() : null;
    const needsTag = Boolean(iso3) && actual !== iso3;
    if (!needsAac && !needsTag) return file;

    const tmpFile = file.replace(/\.mp4$/i, '.audiofix.mp4');
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy'];
    if (needsAac) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
    if (iso3) args.push('-metadata:s:a:0', `language=${iso3}`);
    args.push('-movflags', '+faststart', tmpFile);
    try {
      await runFile(this.ffmpegPath, args, 900000);
      if (fileLooksComplete(tmpFile)) {
        safeUnlink(file);
        fs.renameSync(tmpFile, file);
        if (needsAac) {
          this.log(
            'info',
            `#${item.number} аудио «${codec}» перекодировано в AAC — иначе MP4 играется без звука`
          );
        }
        return file;
      }
      safeUnlink(tmpFile);
    } catch (err) {
      safeUnlink(tmpFile);
      this.log(
        'warn',
        `#${item.number} не удалось поправить аудиодорожку: ${shortYtError((err && err.message) || String(err))}`
      );
    }
    return file;
  }

  async remuxIfNeeded(inputFile, preferMp4) {
    if (!preferMp4 || !this.ffmpegPath) return inputFile;
    if (/\.mp4$/i.test(inputFile)) return inputFile;
    const outFile = inputFile.replace(/\.[^.]+$/, '.mp4');
    try {
      await runFile(
        this.ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputFile, '-c', 'copy', '-movflags', '+faststart', outFile],
        120000
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

  /** Сохраняет найденные дорожки в элементе очереди (и в download_queue.json). */
  applyAudioTracks(item, tracks, info = {}) {
    item.audioTracks = (tracks || []).map((track) => ({ ...track }));
    item.audioLanguages = summarizeAudioTracks(item.audioTracks);
    item.audioChecked = true;
    const rawOriginal = (info && (info.language || info.original_language)) || '';
    const originalLang = rawOriginal ? normalizeAudioLang(rawOriginal) : null;
    item.originalAudioLang = originalLang && originalLang !== 'auto' ? originalLang : null;
    const requested = normalizeAudioLang(item.audioLang);
    if (requested === 'auto') {
      item.audioMissing = false;
    } else {
      const probe = selectAudioTrack(item.audioTracks, requested, info);
      item.audioMissing = !probe.ok;
    }
    return item.audioTracks;
  }

  /** Проба без скачивания: список аудиодорожек одного URL. */
  async inspectAudio(url) {
    const info = await this.probeInfo(url);
    const tracks = collectAudioTracks(info.formats || [], info);
    return {
      title: String(info.title || info.fulltitle || '').trim() || null,
      originalLanguage: info.language || null,
      tracks,
      languages: summarizeAudioTracks(tracks)
    };
  }

  /**
   * Определяет доступные языки для элементов очереди («Определять автоматически»).
   * Ошибка одного видео не прерывает проверку остальных.
   */
  async detectAudio(options = {}) {
    const wanted =
      Array.isArray(options.numbers) && options.numbers.length
        ? new Set(options.numbers.map(Number))
        : null;
    const results = [];
    for (const item of this.items) {
      if (wanted && !wanted.has(Number(item.number))) continue;
      if (options.onlyUnchecked && item.audioChecked) continue;
      if (this.stopped) break;
      try {
        const info = await this.probeInfo(item.url);
        this.applyInfo(item, info);
        const tracks = collectAudioTracks(info.formats || [], info);
        this.applyAudioTracks(item, tracks, info);
        this.log('info', `#${item.number} 🌐 Языки: ${(item.audioLanguages || []).join(', ') || '—'}`);
        if (item.audioMissing) this.log('warn', `#${item.number} ${audioMissingMessage(item.audioLang)}`);
        results.push({
          number: item.number,
          ok: true,
          languages: item.audioLanguages,
          missing: item.audioMissing
        });
      } catch (err) {
        item.audioChecked = false;
        const message = shortYtError(err && err.message);
        this.log('warn', `#${item.number} не удалось получить аудиодорожки: ${message}`);
        results.push({ number: item.number, ok: false, error: message });
      }
    }
    this.persist();
    this.emitProgress({ status: 'Проверка аудиодорожек завершена' });
    return results;
  }

  /** Массовая/индивидуальная установка языка аудио для выбранных видео. */
  setItemsAudioLang(numbers, lang) {
    const value = normalizeAudioLang(lang);
    const wanted =
      Array.isArray(numbers) && numbers.length ? new Set(numbers.map(Number)) : null;
    let changed = 0;
    this.items.forEach((item) => {
      if (wanted && !wanted.has(Number(item.number))) return;
      item.audioLang = value;
      item.audioLangResolved = null;
      item.audioTrackLanguage = null;
      item.audioFormatId = null;
      item.audioVerified = null;
      if (Array.isArray(item.audioTracks) && item.audioTracks.length) {
        const probe = selectAudioTrack(item.audioTracks, value, { language: item.originalAudioLang });
        item.audioMissing = value !== 'auto' && !probe.ok;
      } else {
        item.audioMissing = false;
      }
      // Пропущенное видео возвращается в очередь, если новый язык доступен.
      if (item.status === STATUS.SKIPPED && !item.audioMissing) {
        item.status = STATUS.WAITING;
        item.lastError = null;
      }
      changed += 1;
    });
    this.persist();
    this.emitProgress({ status: `Язык аудио: ${audioLangLabel(value)} — ${changed}` });
    return changed;
  }

  setDefaultAudioLang(lang) {
    this.defaultAudioLang = normalizeAudioLang(lang);
    return this.defaultAudioLang;
  }

  /**
   * Этап «Получение информации → Проверка аудио → Скачивание».
   * Для «Авто» логика не меняется — никаких дополнительных вызовов yt-dlp.
   */
  async prepareAudio(item) {
    const requested = normalizeAudioLang(item.audioLang);
    item.audioLang = requested;
    if (requested === 'auto') {
      item.audioMissing = false;
      item.audioLangResolved = null;
      item.audioTrackLanguage = null;
      item.audioFormatId = null;
      item.audioVerified = null;
      return { format: null, requested, track: null };
    }

    const total = this.items.length;
    this.log('info', `[${item.number}/${total}] Получение информации`);
    const info = await this.probeInfo(item.url);
    this.applyInfo(item, info);
    const tracks = collectAudioTracks(info.formats || [], info);
    this.applyAudioTracks(item, tracks, info);
    this.log(
      'info',
      `[${item.number}/${total}] Найдено аудио: ${(item.audioLanguages || []).join(', ') || '—'}`
    );

    const selection = selectAudioTrack(tracks, requested, info);
    if (!selection.ok) {
      item.audioMissing = true;
      item.audioFormatId = null;
      item.audioLangResolved = null;
      const err = new Error(`⚠ Выбранная аудиодорожка недоступна: ${audioLangLabel(requested)}`);
      err.audioMissing = true;
      throw err;
    }

    item.audioMissing = false;
    item.audioLangResolved = requested;
    item.audioTrackLanguage = selection.track.language || null;
    item.audioFormatId = selection.track.formatId;
    const note = selection.track.note ? ` (${selection.track.note})` : '';
    const originalHint =
      requested === 'original' && selection.track.language
        ? ` — ${audioLangLabel(selection.track.language)}`
        : '';
    this.log(
      'info',
      `[${item.number}/${total}] Выбран язык: ${audioLangLabel(requested)}${originalHint}${note} · format ${selection.track.formatId}`
    );
    this.log('info', `[${item.number}/${total}] Скачивание`);
    const pinLang = selection.track.language || (requested === 'original' ? null : requested);
    const format = buildAudioLangFormat(selection.track.formatId, pinLang);
    return { format, requested, track: selection.track, language: pinLang };
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
    if (!item.title) item.title = `video-${item.videoId || item.number}`;
    this.persist();
    this.emitProgress({ status: this.activeStatus() });

    // Получение информации → проверка аудио → скачивание (для «Авто» проба не делается).
    const audioPlan = await this.prepareAudio(item);
    const safeTitle = sanitizeFilename(item.title);
    const id = item.videoId || `item${item.number}`;
    const template = path.join(this.outputDir, `${item.number}_${id}.%(ext)s`);
    const makeArgs = (cookiesFromBrowser) => buildYtDlpDownloadArgs({
      url: item.url,
      template,
      format: audioPlan.format || FALLBACK_FORMAT,
      ffmpegPath: this.ffmpegPath,
      preferMp4: true,
      ytdlpPath: this.ytdlpPath,
      cookiesFromBrowser,
      aria2cPath: resolveAria2cPath(this.ytdlpPath)
    });

    this.log('info', `#${item.number} DOWNLOAD START`);
    const live = this.activeItems.get(item) || { percent: 0, speed: '', eta: '' };
    this.activeItems.set(item, live);
    this.emitProgress({ status: this.activeStatus() });

    let lastLogged = '';
    const onLine = (line) => {
      const progress = parseProgressLine(line);
      if (progress) {
        live.percent = progress.percent;
        live.speed = progress.speed;
        live.eta = progress.eta;
        this.emitProgress({ status: this.activeStatus() });
        return;
      }
      if (shouldLogYtDlpLine(line) && line !== lastLogged) {
        lastLogged = line;
        const short = line.length > 240 ? `${line.slice(0, 237)}...` : line;
        this.log(/^(WARNING|ERROR)/i.test(line) ? 'warn' : 'info', `#${item.number} ${short}`);
      }
    };

    let used = this.cookiesFromBrowser;
    for (;;) {
      try {
        await this.runYtDlp(makeArgs(used), onLine);
        break;
      } catch (err) {
        if (err && err.cancelled) throw err;
        const next = this.nextCookieBrowser(item, used, err && err.message);
        if (next === undefined) throw err;
        used = next;
      }
    }

    let outputFile = findExistingOutput(this.outputDir, { ...item, filename: null });
    if (!outputFile) {
      const prefix = `${item.number}_${id}`;
      const found = fs.readdirSync(this.outputDir).find(
        (name) => name.startsWith(prefix) && !isDownloadTemp(name)
      );
      if (found) outputFile = path.join(this.outputDir, found);
    }
    if (!fileLooksComplete(outputFile)) {
      throw new Error('Итоговый файл не появился или слишком маленький');
    }

    const sidecar = this.readSidecarInfo(outputFile);
    if (sidecar) this.applyInfo(item, sidecar);
    const prettyTitle = sanitizeFilename(item.title || safeTitle);
    outputFile = await this.remuxIfNeeded(outputFile, true);
    outputFile = renameToPrettyFilename(outputFile, item, prettyTitle);
    outputFile = await this.ensureMp4Audio(item, outputFile, audioPlan);
    const probed = await this.probeOutput(outputFile);
    if (!probed.hasVideo) throw new Error('В результате нет видеопотока');
    if (!probed.hasAudio) throw new Error('В результате нет аудиопотока');

    item.filename = path.basename(outputFile);
    item.fileSize = fs.statSync(outputFile).size;
    if (probed.width && probed.height) item.resolution = `${probed.width}x${probed.height}`;
    if (probed.fps) item.fps = probed.fps;
    if (probed.videoCodec) item.videoCodec = probed.videoCodec;
    if (probed.audioCodec) item.audioCodec = probed.audioCodec;
    if (probed.audioBitrate) item.audioBitrate = Math.round(probed.audioBitrate / 1000);
    this.verifyAudioLanguage(item, audioPlan, probed);
    this.log('info', `#${item.number} DOWNLOAD SUCCESS`);
    this.log('info', `#${item.number} MERGE SUCCESS`);
    if (audioPlan.requested !== 'auto') {
      this.log('info', `[${item.number}/${this.items.length}] Готово`);
    }
    return outputFile;
  }

  /**
   * Что делать после ошибки yt-dlp: браузер для следующей попытки или
   * undefined — сдаться (ссылка уйдёт в retry). Браузер без читаемых cookies
   * исключается навсегда, иначе очередь вечно падала бы на его ошибке.
   */
  nextCookieBrowser(item, used, message) {
    const untried = () =>
      cookieBrowserCandidates().find((name) => !this.failedCookieBrowsers.has(name));
    if (used && isCookieError(message)) {
      const alreadyKnown = this.failedCookieBrowsers.has(used);
      this.failedCookieBrowsers.add(used);
      if (this.cookiesFromBrowser === used) this.cookiesFromBrowser = null;
      const shared = this.cookiesFromBrowser;
      if (alreadyKnown) return shared && !this.failedCookieBrowsers.has(shared) ? shared : null;
      const next = untried();
      this.log(
        'warn',
        `#${item.number} cookies из ${used} недоступны (${shortYtError(message)})` +
          (next ? ` — пробую ${next}` : ' — продолжаю без cookies')
      );
      if (next) this.cookiesFromBrowser = next;
      return next || null;
    }
    if (!used && isBotCheckError(message)) {
      const shared = this.cookiesFromBrowser;
      const next = shared && !this.failedCookieBrowsers.has(shared) ? shared : untried();
      if (!next) {
        this.log('warn', `#${item.number} YouTube просит вход, а cookies ни из одного браузера не читаются — войдите в YouTube в Firefox или закройте Edge/Chrome`);
        return undefined;
      }
      if (next !== shared) this.log('warn', `#${item.number} YouTube просит вход — пробую cookies из ${next}`);
      this.cookiesFromBrowser = next;
      return next;
    }
    return undefined;
  }

  /** Сверяет язык аудиопотока в итоговом MP4 с тем, что выбрал пользователь. */
  verifyAudioLanguage(item, audioPlan, probed) {
    if (!audioPlan || audioPlan.requested === 'auto') {
      item.audioVerified = null;
      return null;
    }
    const expected =
      (audioPlan.track && audioPlan.track.language) ||
      (audioPlan.requested === 'original' ? null : audioPlan.requested);
    const actual = probed && probed.audioLanguage ? normalizeAudioLang(probed.audioLanguage) : null;
    if (!expected || !actual) {
      item.audioVerified = null;
      return null;
    }
    item.audioVerified = actual === normalizeAudioLang(expected);
    if (item.audioVerified) {
      this.log('info', `#${item.number} AUDIO OK — ${describeAudioLang(expected)}`);
    } else if (
      String(probed.audioLanguage).toLowerCase() === 'eng' &&
      normalizeAudioLang(expected) !== 'en' &&
      !isAacTrack(audioPlan.track)
    ) {
      // mov-муксер ставит «eng», когда тега языка нет вовсе — это не чужой язык.
      item.audioVerified = null;
      this.log(
        'info',
        `#${item.number} в MP4 нет тега языка (по умолчанию «eng») — скачана дорожка ${describeAudioLang(expected)}, format ID ${(audioPlan.track && audioPlan.track.formatId) || '?'}`
      );
    } else {
      this.log(
        'warn',
        `#${item.number} в MP4 аудио «${probed.audioLanguage}», ожидалось «${audioLangLabel(expected)}»`
      );
    }
    return item.audioVerified;
  }

  /** Нет выбранной дорожки — это не системная ошибка: статус Пропущено, очередь идёт дальше. */
  markSkipped(item, err) {
    item.status = STATUS.SKIPPED;
    item.completed = false;
    item.audioMissing = true;
    item.nextRetry = null;
    item.lastError = String((err && err.message) || audioMissingMessage(item.audioLang));
    this.log(
      'warn',
      `[VIDEO ${item.number}] ${audioLangLabel(item.audioLang)} аудиодорожка недоступна — пропуск`
    );
    this.persist();
    this.emitProgress({ status: `#${item.number} Пропущено — ${audioMissingMessage(item.audioLang)}` });
  }

  markSuccess(item) {
    item.status = STATUS.SUCCESS;
    item.completed = true;
    item.lastError = null;
    item.nextRetry = null;
    const live = this.activeItems.get(item);
    if (live) live.percent = 100;
    this.flushTitles(false);
    this.persist();
    this.emitProgress({
      status: `#${item.number} SUCCESS ${item.resolution || ''} ${item.fps ? `${item.fps} FPS` : ''}`.trim()
    });
  }

  /**
   * nazvaniya.txt пишется в порядке очереди, а не в порядке завершения:
   * при параллельной загрузке #3 может закончить раньше #2. Название ждёт,
   * пока все видео перед ним не завершатся; force — в конце запуска.
   */
  flushTitles(force) {
    // Повторы переезжают в конец this.items, поэтому порядок — по номеру ссылки.
    const ordered = this.items.slice().sort((a, b) => a.number - b.number);
    for (const item of ordered) {
      if (item.titleSaved) continue;
      if (item.status === STATUS.SUCCESS) {
        if (item.title) {
          appendTitle(this.outputDir, item.title);
          item.titleSaved = true;
          this.log('info', `#${item.number} TITLE SAVED`);
        }
        continue;
      }
      if (item.status === STATUS.PERMANENT_ERROR || item.status === STATUS.SKIPPED) continue;
      if (!force) break;
    }
  }

  activeStatus() {
    const active = Array.from(this.activeItems.keys()).map((item) => `#${item.number}`);
    if (!active.length) return 'Downloading';
    return active.length === 1 ? `Downloading ${active[0]}` : `Downloading ${active.join(', ')} (${active.length} потока)`;
  }

  markFailure(item, err) {
    const cancelled = Boolean(err && err.cancelled);
    if (cancelled) {
      item.status = STATUS.WAITING;
      item.lastError = 'Остановлено пользователем';
      this.persist();
      return;
    }
    if (this.cookiesFromBrowser && isCookieError(err && err.message)) {
      this.nextCookieBrowser(item, this.cookiesFromBrowser, err && err.message);
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
      this.log('error', `#${item.number} ERROR ${item.lastError}`);
      this.log('warn', `#${item.number} RETRY IN ${Math.round(delay / 1000)}s`);
    }
    this.persist();
    this.emitProgress({ status: `#${item.number} ${item.status}` });
  }

  async processOne(index) {
    if (this.activeItems.size >= this.concurrency) {
      throw new Error(`Одновременно можно скачивать не больше ${this.concurrency} видео`);
    }
    const item = this.items[index];
    this.activeItems.set(item, { percent: 0, speed: '', eta: '' });
    this.activeDownloads = this.activeItems.size;
    item.status = STATUS.DOWNLOADING;
    this.persist();
    this.emitProgress({ status: this.activeStatus() });
    try {
      await this.downloadItem(item);
      this.markSuccess(item);
    } catch (err) {
      if (err && err.audioMissing) {
        this.markSkipped(item, err);
      } else {
        this.markFailure(item, err);
        if (item.status === STATUS.RETRY) this.moveToEnd(this.items.indexOf(item));
      }
    } finally {
      this.activeItems.delete(item);
      this.activeDownloads = this.activeItems.size;
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
    const jsRuntime = resolveJsRuntimeArgs(this.ytdlpPath)[1] || 'auto';
    const aria2c = resolveAria2cPath(this.ytdlpPath);
    this.log('info', `Очередь: ${this.items.length} ссылок, папка ${this.outputDir}`);
    this.log('info', `yt-dlp: ${path.basename(this.ytdlpPath || 'yt-dlp')} · JS ${jsRuntime}`);
    this.log(
      'info',
      aria2c
        ? `качаем как Media Downloader: yt-dlp + aria2c (${path.basename(aria2c)})`
        : 'aria2c не найден — качаем встроенным клиентом yt-dlp'
    );

    this.log(
      'info',
      this.concurrency > 1
        ? `Параллельно: до ${this.concurrency} видео одновременно`
        : 'Параллельно: одно видео за раз'
    );

    const running = new Set();
    const launch = (index) => {
      const job = this.processOne(index).finally(() => running.delete(job));
      running.add(job);
    };

    try {
      while (!this.stopped) {
        if (this.paused) {
          await (running.size ? Promise.race([...running, this.sleep(250)]) : this.sleep(250));
          continue;
        }
        while (running.size < this.concurrency && !this.paused && !this.stopped) {
          const index = this.pickReadyIndex();
          if (index < 0) break;
          launch(index);
        }
        const nextAt = this.nearestRetryAt();
        if (running.size) {
          // Свободный слот при ожидающем retry — просыпаемся по таймеру, а не только по завершению загрузки.
          const waitRetry = running.size < this.concurrency && nextAt != null;
          await Promise.race(
            waitRetry
              ? [...running, this.sleep(Math.max(250, Math.min(nextAt - this.now(), 1000)))]
              : [...running]
          );
          continue;
        }
        if (!this.unfinished() || nextAt == null) break;
        const wait = Math.max(250, Math.min(nextAt - this.now(), 1000));
        this.emitProgress({
          status: `${summarizeItems(this.items).retry} videos waiting for automatic retry...`
        });
        await this.sleep(wait);
      }
      await Promise.allSettled([...running]);
      this.flushTitles(true);

      const counts = summarizeItems(this.items);
      const done = !this.unfinished();
      if (done) {
        this.log(
          'success',
          `DOWNLOAD COMPLETE Total:${counts.total} Success:${counts.completed} Skipped:${counts.skipped} Permanent:${counts.permanent}`
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
      this.activeItems.clear();
    }
  }
}

module.exports = {
  DownloadQueue,
  clearQueueFiles,
  MAX_CONCURRENT_DOWNLOADS,
  MAX_PARALLEL_DOWNLOADS,
  DEFAULT_PARALLEL_DOWNLOADS,
  CONCURRENT_FRAGMENTS,
  normalizeConcurrency,
  parseSpeedBytes,
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
  AUDIO_LANGUAGE_OPTIONS,
  DEFAULT_AUDIO_LANG,
  normalizeAudioLang,
  audioLangLabel,
  audioLangFlag,
  describeAudioLang,
  audioMissingMessage,
  collectAudioTracks,
  summarizeAudioTracks,
  selectAudioTrack,
  buildAudioLangFormat,
  parseFfmpegStreamInfo,
  parseProgressLine,
  buildYtDlpDownloadArgs,
  buildBaseYtDlpArgs,
  buildAria2cDownloaderArgs,
  resolveJsRuntimeArgs,
  resolveAria2cPath,
  isBotCheckError,
  isCookieError,
  cookieBrowserCandidates,
  shortYtError,
  shouldLogYtDlpLine,
  YOUTUBE_EXTRACTOR_ARGS,
  FALLBACK_FORMAT,
  STALL_TIMEOUT_MS,
  SOCKET_TIMEOUT_SEC,
  DOWNLOAD_RETRIES,
  FRAGMENT_RETRIES,
  HTTP_CHUNK_SIZE,
  ARIA2_DOWNLOADER_ARGS,
  mergeUrlsIntoQueue,
  loadQueueFile,
  resolveYtDlpPath,
  ytdlpExists,
  summarizeItems,
  formatBytes
};
