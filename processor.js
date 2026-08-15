'use strict';

/**
 * processor.js — вся работа с FFmpeg.
 *
 * Для каждого исходного видео собирается один ffmpeg-процесс, который:
 *   1) берёт первые X% исходника,
 *   2) подставляет за ними ролик Shorts,
 *   3) добавляет оставшийся хвост исходника,
 *   4) (опционально) накладывает оверлей на весь хронометраж,
 *   5) пишет результат в esN.mp4 (H.264/H.265) или esN.mov (ProRes).
 *
 * Модуль не зависит от Electron и может запускаться обычным Node (см. scripts/smoke-test.js).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

const VIDEO_EXTENSIONS = [
  '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.mts', '.m2ts', '.ts', '.3gp', '.ogv'
];

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_LAYOUT = 'stereo';

/** Быстрее bicubic, для Shorts разницы почти нет. */
const SCALE_FLAGS = 'fast_bilinear';
/** 60 fps исходник гоняется в 30 — вдвое меньше кадров на фильтрах. */
const MAX_OUTPUT_FPS = 30;
/**
 * Потолок относительно realtime. 4× при 30 fps ≈ 120 кадров/с — около половины
 * NVENC на RTX 3060 1080p. Каждый файл пишется своим процессом сразу в esN.mp4:
 * так ролик появляется в папке, как только готов, и команда не раздувается.
 */
const ENCODE_PACE_SPEED = 4;
/** Пауза между файлами, чтобы NVENC успел закрыть предыдущую сессию. */
const INTER_FILE_DELAY_MS = 120;
const MIN_OUTPUT_BYTES = 64;

function outputContainer(encoderKey) {
  return encoderKey === 'prores' ? 'mov' : 'mp4';
}

function outputExtension(encoderKey) {
  return `.${outputContainer(encoderKey)}`;
}

/** Windows и «Кино и ТВ» показывают картинку только при avc1/hvc1, не при сыром h264 в .mov. */
function withPlayerCompatibleTags(encoderKey, videoOptions) {
  const opts = Array.isArray(videoOptions) ? [...videoOptions] : [];
  if (!opts.includes('-tag:v')) {
    if (encoderKey === 'h264') opts.push('-tag:v', 'avc1');
    if (encoderKey === 'h265') opts.push('-tag:v', 'hvc1');
  }
  return opts;
}

function paceGlobalArgs() {
  return [
    '-readrate', String(ENCODE_PACE_SPEED),
    '-readrate_initial_burst', '0'
  ];
}

function prefixed(prefix, name) {
  return prefix ? `${prefix}${name}` : name;
}

/** Выше этого граф уходит в файл через -filter_complex_script, а не в argv. */
const FILTER_SCRIPT_THRESHOLD = 8000;

function isCommandTooLong(err) {
  if (!err) return false;
  if (err.code === 'ENAMETOOLONG') return true;
  return /ENAMETOOLONG/i.test(String(err.message || ''));
}

function isUnknownFfmpegOption(err) {
  const message = String((err && err.message) || '');
  return /Error splitting the argument list/i.test(message) || /Unrecognized option/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Пресеты кодеков. H.264/H.265 — MP4 для Windows, ProRes — MOV. */
const ENCODERS = {
  h264: {
    label: 'H.264 — быстро (veryfast)',
    pixelFormat: 'yuv420p',
    videoOptions: [
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high',
      '-tag:v', 'avc1',
      '-x264-params', 'ref=1:bframes=0:rc-lookahead=10:sync-lookahead=0:scenecut=0'
    ],
    audioOptions: ['-c:a', 'aac', '-b:a', '128k'],
    extraOptions: ['-movflags', '+faststart']
  },
  h265: {
    label: 'H.265 — быстро (veryfast)',
    pixelFormat: 'yuv420p',
    videoOptions: [
      '-c:v', 'libx265', '-preset', 'veryfast', '-crf', '24', '-tag:v', 'hvc1',
      '-x265-params', 'log-level=error'
    ],
    audioOptions: ['-c:a', 'aac', '-b:a', '128k'],
    extraOptions: ['-movflags', '+faststart']
  },
  prores: {
    label: 'ProRes 422 HQ — максимальное качество',
    pixelFormat: 'yuv422p10le',
    videoOptions: ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0'],
    audioOptions: ['-c:a', 'pcm_s16le'],
    extraOptions: []
  }
};

/** Размер итогового кадра. */
const FRAME_PRESETS = {
  square1080: { label: '1080×1080 — квадрат', width: 1080, height: 1080 },
  vertical1080: { label: '1080×1920 — вертикаль', width: 1080, height: 1920 },
  horizontal1080: { label: '1920×1080 — горизонталь', width: 1920, height: 1080 },
  source: { label: 'Как у исходника', width: null, height: null }
};

/** Как исходник ложится в кадр, если пропорции не совпадают. */
const FIT_MODES = {
  cover: { label: 'Заполнить кадр (обрезать лишнее)' },
  contain: { label: 'Вписать целиком (чёрные поля)' }
};

/**
 * Раскладка split-screen. Сдвиги — в процентах от ширины холста (1080×1080
 * по умолчанию). Нулевой сдвиг ставит центр исходника в центр своей половины.
 */
const SPLIT_DEFAULTS = {
  leftShare: 50,
  feather: 48,
  leftZoom: 1,
  leftOffset: 0,
  rightZoom: 1.8,
  rightOffset: 0
};

const DEFAULTS = {
  percent: 90,
  encoder: 'h264',
  accel: 'hybrid',
  overlayOpacity: 100,
  outputPrefix: 'es',
  frame: 'square1080',
  fit: 'cover',
  split: SPLIT_DEFAULTS
};

/** Как делить работу между процессором и видеокартой. */
const ACCEL_MODES = {
  hybrid: {
    label: 'Минимум нагрузки — 1–2 ядра CPU, кодирование на видеокарте'
  },
  cpu: { label: 'Только процессор (быстрый пресет, треть ядер)' },
  gpu: { label: 'Предпочесть видеокарту (если нет — быстрый процессор)' }
};

const GPU_H264 = [
  {
    id: 'h264_nvenc',
    vendor: 'NVIDIA NVENC',
    extras: [
      ['-gpu', '0', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-rc-lookahead', '0', '-strict_gop', '1', '-bf', '0', '-async_depth', '1', '-forced-idr', '1'],
      ['-gpu', '1', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-rc-lookahead', '0', '-strict_gop', '1', '-bf', '0', '-async_depth', '1', '-forced-idr', '1'],
      ['-gpu', '0', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
      ['-gpu', '1', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
      ['-gpu', '0', '-preset', 'p1'],
      ['-gpu', '1', '-preset', 'p1'],
      ['-gpu', '0'],
      ['-gpu', '1'],
      []
    ]
  },
  {
    id: 'h264_amf',
    vendor: 'AMD AMF',
    extras: [
      ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24'],
      ['-quality', 'speed'],
      []
    ]
  },
  {
    id: 'h264_qsv',
    vendor: 'Intel Quick Sync',
    extras: [
      ['-preset', 'veryfast'],
      ['-preset', 'fast'],
      []
    ]
  },
  {
    id: 'h264_videotoolbox',
    vendor: 'Apple VideoToolbox',
    extras: [
      ['-profile:v', 'high', '-q:v', '65'],
      ['-q:v', '65'],
      []
    ]
  }
];

const GPU_H265 = [
  {
    id: 'hevc_nvenc',
    vendor: 'NVIDIA NVENC',
    extras: [
      ['-gpu', '0', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '26', '-b:v', '0', '-rc-lookahead', '0', '-strict_gop', '1', '-bf', '0', '-async_depth', '1', '-forced-idr', '1', '-tag:v', 'hvc1'],
      ['-gpu', '1', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '26', '-b:v', '0', '-rc-lookahead', '0', '-strict_gop', '1', '-bf', '0', '-async_depth', '1', '-forced-idr', '1', '-tag:v', 'hvc1'],
      ['-gpu', '0', '-preset', 'p4', '-tag:v', 'hvc1'],
      ['-gpu', '1', '-preset', 'p4', '-tag:v', 'hvc1'],
      ['-gpu', '0', '-tag:v', 'hvc1'],
      ['-gpu', '1', '-tag:v', 'hvc1'],
      ['-tag:v', 'hvc1']
    ]
  },
  {
    id: 'hevc_amf',
    vendor: 'AMD AMF',
    extras: [
      ['-quality', 'speed', '-tag:v', 'hvc1'],
      ['-tag:v', 'hvc1']
    ]
  },
  {
    id: 'hevc_qsv',
    vendor: 'Intel Quick Sync',
    extras: [
      ['-preset', 'veryfast', '-tag:v', 'hvc1'],
      ['-preset', 'fast', '-tag:v', 'hvc1'],
      ['-tag:v', 'hvc1']
    ]
  },
  {
    id: 'hevc_videotoolbox',
    vendor: 'Apple VideoToolbox',
    extras: [
      ['-q:v', '65', '-tag:v', 'hvc1'],
      ['-tag:v', 'hvc1']
    ]
  }
];

// ---------------------------------------------------------------------------
// Пути к бинарникам FFmpeg / FFprobe
// ---------------------------------------------------------------------------

/** Внутри упакованного asar бинарники лежат в app.asar.unpacked. */
function unpackedPath(binaryPath) {
  if (typeof binaryPath !== 'string' || !binaryPath) return null;
  return binaryPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function optionalRequire(moduleName) {
  try {
    return require(moduleName);
  } catch (err) {
    return null;
  }
}

function resolveBinary(candidate, fallbackCommand) {
  const resolved = unpackedPath(candidate);
  if (resolved && fs.existsSync(resolved)) return resolved;
  return fallbackCommand;
}

const ffmpegStatic = optionalRequire('ffmpeg-static');
const ffprobeStatic = optionalRequire('ffprobe-static');

const ffmpegPath = resolveBinary(ffmpegStatic, 'ffmpeg');
const ffprobePath = resolveBinary(ffprobeStatic && ffprobeStatic.path, 'ffprobe');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// ---------------------------------------------------------------------------
// Видеокарта: декодирование и кодирование. Фильтры остаются на CPU.
// ---------------------------------------------------------------------------

class GpuUnavailableError extends Error {
  constructor(cause) {
    super(cause && cause.message ? cause.message : 'GPU-кодирование недоступно');
    this.name = 'GpuUnavailableError';
    this.gpuFallback = true;
  }
}

function ffmpegCli(args, options = {}) {
  try {
    return execFileSync(ffmpegPath, args, {
      encoding: 'utf8',
      timeout: options.timeout || 15000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: options.stdio || ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr) : '';
    const stdout = err && err.stdout ? String(err.stdout) : '';
    err.combined = `${stdout}\n${stderr}`.trim();
    throw err;
  }
}

function parseEncoderIds(text) {
  const ids = new Set();
  String(text || '').split('\n').forEach((line) => {
    const match = line.match(/^\s*[A-Za-z.]+\s+(\S+)/);
    if (match) ids.add(match[1]);
  });
  return ids;
}

function parseHwaccels(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/hardware acceleration/i.test(line));
}

function probeEncoder(id, extra) {
  const tmp = path.join(os.tmpdir(), `shorts-gpu-probe-${process.pid}-${id}.mp4`);
  try {
    ffmpegCli(
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=15:d=0.4',
        '-pix_fmt', 'yuv420p',
        '-c:v', id, ...(extra || []),
        '-frames:v', '4',
        tmp
      ],
      { timeout: 12000, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: shortenFfmpegError(err.combined || err.message) };
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (err) {
      /* временный файл */
    }
  }
}

function pickGpuEncoder(candidates, compiledIds) {
  let lastError = null;
  for (const candidate of candidates) {
    if (!compiledIds.has(candidate.id)) continue;
    const extras = candidate.extras && candidate.extras.length ? candidate.extras : [[]];
    for (const extra of extras) {
      const probe = probeEncoder(candidate.id, extra);
      if (probe.ok) {
        return {
          encoder: { id: candidate.id, vendor: candidate.vendor, extra },
          error: null
        };
      }
      lastError = `${candidate.id}: ${probe.error}`;
    }
  }
  return { encoder: null, error: lastError };
}

let hardwareCache = null;

/**
 * Какие GPU-кодеки реально отвечают на тестовый кадр, а не просто
 * скомпилированы в бинарник. На ноутбуке с Intel + NVIDIA NVENC часто
 * открывается только с `-gpu 1`, а Quick Sync — на встроенной карте.
 */
function detectHardware() {
  if (hardwareCache) return hardwareCache;

  let encoderText = '';
  let accelText = '';
  try {
    encoderText = ffmpegCli(['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    encoderText = err.combined || '';
  }
  try {
    accelText = ffmpegCli(['-hide_banner', '-hwaccels'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    accelText = err.combined || '';
  }

  const ids = parseEncoderIds(encoderText);
  const accels = parseHwaccels(accelText);
  const wanted = [...GPU_H264, ...GPU_H265].map((item) => item.id);
  const compiledGpu = wanted.filter((id) => ids.has(id));

  const h264 = pickGpuEncoder(GPU_H264, ids);
  const h265 = pickGpuEncoder(GPU_H265, ids);

  const preferredAccel = {
    win32: ['d3d11va', 'cuda', 'dxva2', 'qsv'],
    linux: ['vaapi', 'cuda', 'vdpau'],
    darwin: ['videotoolbox']
  }[process.platform] || [];

  hardwareCache = {
    h264: h264.encoder,
    h265: h265.encoder,
    hwaccel: preferredAccel.find((name) => accels.includes(name)) || null,
    accels,
    compiledGpu,
    probeError: (h264.encoder ? null : h264.error) || (h265.encoder ? null : h265.error) || null,
    cores: Math.max(1, (os.cpus() || []).length || 4)
  };
  return hardwareCache;
}

function threadBudget(mode, coreCount) {
  const cores = Math.max(1, coreCount || (os.cpus() || []).length || 4);
  if (mode === 'cpu') {
    const n = Math.max(1, Math.min(4, Math.ceil(cores / 3)));
    return { cores, filterThreads: n, encodeThreads: n };
  }
  // hybrid / gpu: один-два потока на фильтры, кодирование на карте (или veryfast x264).
  const n = Math.max(1, Math.min(2, Math.floor(cores / 4) || 1));
  return { cores, filterThreads: n, encodeThreads: n };
}

/**
 * Собирает итоговый план: какой кодек, сколько потоков CPU.
 * ProRes на потребительских GPU нет — остаётся CPU.
 * В режимах hybrid/gpu ffmpeg никогда не берёт все ядра, даже если карта
 * не ответила: иначе интерфейс Windows зависает на 100% CPU.
 */
function resolveEncodePlan(encoderKey, accelMode, hardware) {
  const cpu = ENCODERS[encoderKey] || ENCODERS.h264;
  const mode = ACCEL_MODES[accelMode] ? accelMode : DEFAULTS.accel;
  const wantGpu = mode === 'hybrid' || mode === 'gpu';
  const gpu = encoderKey === 'h265' ? hardware.h265 : encoderKey === 'h264' ? hardware.h264 : null;
  const threads = threadBudget(mode, hardware.cores);

  if (wantGpu && gpu) {
    return {
      label: `${gpu.vendor}: склейка на CPU (${threads.filterThreads} из ${threads.cores} потоков), кодирование на GPU`,
      pixelFormat: 'yuv420p',
      videoOptions: withPlayerCompatibleTags(encoderKey, ['-c:v', gpu.id, ...(gpu.extra || [])]),
      audioOptions: cpu.audioOptions,
      extraOptions: cpu.extraOptions && cpu.extraOptions.length ? cpu.extraOptions : ['-movflags', '+faststart'],
      // Граф фильтров целиком программный (concat/crop/overlay) — GPU-кадры
      // к нему не привязать. Видеокарта здесь только кодирует готовый кадр.
      hwaccel: null,
      usingGpu: true,
      vendor: gpu.vendor,
      threads
    };
  }

  const reason = !wantGpu
    ? 'выбран режим «только процессор»'
    : hardware.probeError
      ? `видеокарта не приняла тест (${hardware.probeError}), процессор на ${threads.encodeThreads} из ${threads.cores} потоков`
      : `видеокарта недоступна, процессор на ${threads.encodeThreads} из ${threads.cores} потоков`;

  return {
    label: `${cpu.label} — ${reason}`,
    pixelFormat: cpu.pixelFormat,
    videoOptions: withPlayerCompatibleTags(encoderKey, [...cpu.videoOptions, '-threads', String(threads.encodeThreads)]),
    audioOptions: cpu.audioOptions,
    extraOptions: cpu.extraOptions,
    hwaccel: null,
    usingGpu: false,
    vendor: null,
    threads
  };
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

class ProcessingCancelledError extends Error {
  constructor() {
    super('Обработка остановлена пользователем');
    this.name = 'ProcessingCancelledError';
    this.cancelled = true;
  }
}

function isVideoFile(fileName) {
  return VIDEO_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
}

/** Натуральная сортировка: video2.mp4 идёт раньше video10.mp4. */
function naturalCompare(a, b) {
  return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
}

/**
 * Список видеофайлов в папке (без рекурсии).
 * Файлы, которые совпадают с шаблоном результата (esN.mp4 / esN.mov), игнорируются —
 * иначе повторный запуск с той же папкой на входе и выходе зациклится.
 */
function listVideoFiles(directory, options = {}) {
  const prefix = options.outputPrefix || DEFAULTS.outputPrefix;
  const skipOutputNames = Boolean(options.skipOutputNames);
  const outputPattern = new RegExp(`^${escapeRegExp(prefix)}\\d+\\.(mov|mp4)$`, 'i');

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => isVideoFile(name))
    .filter((name) => !(skipOutputNames && outputPattern.test(name)))
    .sort(naturalCompare)
    .map((name) => path.join(directory, name));
}

function parseFrameRate(value, fallback = 30) {
  if (!value || typeof value !== 'string') return fallback;
  const [num, den] = value.split('/');
  const numerator = Number(num);
  const denominator = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return fallback;
  const fps = numerator / denominator;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) return fallback;
  return Math.round(fps * 1000) / 1000;
}

function readRotation(stream) {
  let rotation = 0;
  if (stream.tags && stream.tags.rotate !== undefined) rotation = Number(stream.tags.rotate);
  if (stream.rotation !== undefined) rotation = Number(stream.rotation);
  if (Array.isArray(stream.side_data_list)) {
    const side = stream.side_data_list.find((item) => item && item.rotation !== undefined);
    if (side) rotation = Number(side.rotation);
  }
  if (!Number.isFinite(rotation)) rotation = 0;
  return ((Math.round(rotation) % 360) + 360) % 360;
}

/** FFmpeg печатает баннер сборки — в логе нужна только суть ошибки. */
function shortenFfmpegError(message) {
  const lines = String(message || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(ff(mpeg|probe) version|built with|configuration:|lib[a-z]+\s+\d)/i.test(line));
  const meaningful = lines.filter((line) => !/^Copyright/i.test(line));
  const last = meaningful[meaningful.length - 1] || lines[0] || 'неизвестная ошибка';
  const unrecognized = meaningful.find((line) => /Unrecognized option/i.test(line));
  if (unrecognized && unrecognized !== last) return `${unrecognized} ${last}`.slice(0, 400);
  return last.slice(0, 400);
}

/** Метаданные файла: размеры (с учётом поворота), длительность, fps, наличие дорожек. */
function probeMedia(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) {
        reject(
          new Error(`Не удалось прочитать файл (${path.basename(file)}): ${shortenFfmpegError(err.message)}`)
        );
        return;
      }

      const streams = Array.isArray(data.streams) ? data.streams : [];
      const videoStream = streams.find(
        (s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)
      );
      const audioStream = streams.find((s) => s.codec_type === 'audio');

      if (!videoStream) {
        reject(new Error(`В файле нет видеодорожки: ${path.basename(file)}`));
        return;
      }

      const rotation = readRotation(videoStream);
      const swapped = rotation === 90 || rotation === 270;
      const width = Number(swapped ? videoStream.height : videoStream.width);
      const height = Number(swapped ? videoStream.width : videoStream.height);

      const duration =
        Number(data.format && data.format.duration) ||
        Number(videoStream.duration) ||
        0;

      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
        reject(new Error(`Некорректные размеры кадра: ${path.basename(file)}`));
        return;
      }

      resolve({
        file,
        width: Math.floor(width / 2) * 2,
        height: Math.floor(height / 2) * 2,
        rotation,
        duration: Number.isFinite(duration) ? duration : 0,
        fps: parseFrameRate(videoStream.r_frame_rate, 30),
        hasAudio: Boolean(audioStream),
        videoCodec: videoStream.codec_name || 'unknown',
        codecTag: videoStream.codec_tag_string || '',
        audioCodec: audioStream ? audioStream.codec_name || 'unknown' : null
      });
    });
  });
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00';
  const total = Math.floor(seconds);
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** "00:01:23.45" -> 83.45 */
function timemarkToSeconds(timemark) {
  if (typeof timemark !== 'string') return 0;
  const parts = timemark.split(':');
  if (parts.length !== 3) return 0;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = parseFloat(parts[2]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return 0;
  return hours * 3600 + minutes * 60 + seconds;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    /* файл может быть занят — не критично */
  }
}

// ---------------------------------------------------------------------------
// Построение графа фильтров
// ---------------------------------------------------------------------------

function lowerFfmpegPriority(command) {
  const proc = command && command.ffmpegProc;
  if (!proc || !Number.isInteger(proc.pid)) return;
  const levels = os.constants && os.constants.priority;
  if (!levels) return;
  try {
    os.setPriority(proc.pid, levels.PRIORITY_BELOW_NORMAL);
  } catch (err) {
    try {
      os.setPriority(proc.pid, levels.PRIORITY_LOW);
    } catch (err2) {
      /* нет прав менять приоритет — не критично */
    }
  }
}

function chooseOutputFps(sourceFps) {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return MAX_OUTPUT_FPS;
  return Math.min(sourceFps, MAX_OUTPUT_FPS);
}

function needsFpsConvert(targetFps, inputFps) {
  return !(Number.isFinite(inputFps) && Math.abs(inputFps - targetFps) < 0.08);
}

function filterChain(...parts) {
  return parts.filter(Boolean).join(',');
}

/** Вписывание кадра в холст: обрезать по краям либо добавить чёрные поля. */
function fitStep(target, src) {
  if (src && src.width === target.width && src.height === target.height) return '';
  if (target.fit === 'contain') {
    return (
      `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:flags=${SCALE_FLAGS},` +
      `pad=${target.width}:${target.height}:-1:-1:color=black`
    );
  }
  return (
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase:flags=${SCALE_FLAGS},` +
    `crop=${target.width}:${target.height}`
  );
}

function videoSegmentFilter(inputLabel, outputLabel, target, inputFps, srcSize, duration) {
  const trim = Number.isFinite(duration) && duration > 0
    ? `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS`
    : 'setpts=PTS-STARTPTS';
  return (
    `[${inputLabel}]${filterChain(
      trim,
      needsFpsConvert(target.fps, inputFps) ? `fps=${target.fps}` : '',
      fitStep(target, srcSize),
      'setsar=1',
      `format=${target.pixelFormat}`
    )}[${outputLabel}]`
  );
}

/** Один вход ролика: своя позиция и свой лимит, без хвоста предыдущего файла. */
function segmentInputOptions(start, duration) {
  const options = ['-accurate_seek', '-ss', Number.isFinite(start) && start > 0 ? start.toFixed(3) : '0'];
  if (Number.isFinite(duration) && duration > 0) options.push('-t', duration.toFixed(3));
  return options;
}

/**
 * Замороженные числа одного Shorts. Следующий ролик не должен увидеть
 * хвост 20%, playhead или длительность предыдущей операции.
 */
function isolateJobTimeline({ closeupStart, splitAt, duration, percent }) {
  return {
    closeupStart: Number(closeupStart) || 0,
    splitAt: Number(splitAt),
    duration: Number(duration),
    percent: Number(percent)
  };
}

const AUDIO_FORMAT_FILTER =
  `aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=${AUDIO_LAYOUT}`;

function audioSegmentFilter(inputLabel, outputLabel, duration) {
  const trim = Number.isFinite(duration) && duration > 0
    ? `atrim=duration=${duration.toFixed(3)},`
    : '';
  return (
    `[${inputLabel}]${trim}asetpts=PTS-STARTPTS,aresample=${AUDIO_SAMPLE_RATE}:first_pts=0,` +
    `${AUDIO_FORMAT_FILTER}[${outputLabel}]`
  );
}

/**
 * Тишина нужной длины. Источник строится прямо в графе фильтров:
 * отдельный вход с форматом lavfi fluent-ffmpeg не пропускает.
 */
function silentSegmentFilter(outputLabel, duration) {
  const seconds = Math.max(0.04, duration).toFixed(3);
  return (
    `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=${AUDIO_LAYOUT},atrim=duration=${seconds},` +
    `asetpts=PTS-STARTPTS,${AUDIO_FORMAT_FILTER}[${outputLabel}]`
  );
}

function evenRound(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Мягкая граница split-screen. Raised-cosine считается один раз (`eval=init`)
 * на полном кадре маски — без loop, который на части сборок FFmpeg даёт пустое видео.
 */
function buildFeatherMaskFilter({ width, height, fps, duration, feather, outputLabel }) {
  const denom = Math.max(1, feather - 1).toFixed(1);
  const ease = `0.5-0.5*cos(PI*clip(X/${denom},0,1))`;
  const maskDuration = Math.max(1, duration + 1).toFixed(3);
  const rate = Number.isFinite(fps) && fps > 0 ? fps : MAX_OUTPUT_FPS;
  return (
    `color=c=black:s=${width}x${height}:r=${rate}:d=${maskDuration},` +
      `format=gray,geq=lum='255*(${ease})':eval=init[${outputLabel}]`
  );
}

/** Приводит настройки раскладки к безопасным значениям. */
function normalizeSplit(config = {}) {
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    leftShare: clamp(number(config.leftShare, SPLIT_DEFAULTS.leftShare), 20, 80),
    feather: clamp(Math.round(number(config.feather, SPLIT_DEFAULTS.feather)), 0, 200),
    // Зум меньше единицы оставил бы в кадре пустоту, поэтому нижняя граница — 1.
    leftZoom: clamp(number(config.leftZoom, SPLIT_DEFAULTS.leftZoom), 1, 4),
    rightZoom: clamp(number(config.rightZoom, SPLIT_DEFAULTS.rightZoom), 1, 4),
    leftOffset: clamp(number(config.leftOffset, SPLIT_DEFAULTS.leftOffset), -100, 100),
    rightOffset: clamp(number(config.rightOffset, SPLIT_DEFAULTS.rightOffset), -100, 100)
  };
}

/** Формат с альфой под глубину цвета итогового кодека. */
function alphaFormatFor(pixelFormat) {
  return /10le|12le/.test(pixelFormat) ? 'yuva444p10le' : 'yuva444p';
}

/**
 * Окно в видео, которое заполняет половину кадра.
 *
 * Сначала ролик масштабируется так, чтобы покрыть панель (как cover), затем
 * дополнительно на zoom, и из получившегося слоя вырезается панель со сдвигом.
 * Нулевой сдвиг — центр исходника в центре половины, как в примере 1080×1080.
 */
function coverWindow({ srcW, srcH, paneW, paneH, zoom, panPercent, canvasW }) {
  const scale = Math.max((paneW * zoom) / srcW, (paneH * zoom) / srcH);
  const scaledW = evenRound(srcW * scale);
  const scaledH = evenRound(srcH * scale);
  const panPx = (canvasW * panPercent) / 100;
  return {
    scaledW,
    scaledH,
    cropX: clamp(Math.round((scaledW - paneW) / 2 - panPx), 0, Math.max(0, scaledW - paneW)),
    cropY: clamp(Math.round((scaledH - paneH) / 2), 0, Math.max(0, scaledH - paneH))
  };
}

function coverFilter(label, src, paneW, paneH, zoom, panPercent, canvasW, outputLabel) {
  const window = coverWindow({
    srcW: src.width,
    srcH: src.height,
    paneW,
    paneH,
    zoom,
    panPercent,
    canvasW
  });
  const scale =
    window.scaledW === src.width && window.scaledH === src.height
      ? ''
      : `scale=${window.scaledW}:${window.scaledH}:flags=${SCALE_FLAGS},`;
  return `${label}${scale}crop=${paneW}:${paneH}:${window.cropX}:${window.cropY}[${outputLabel}]`;
}

/**
 * Смещение внутри второго видео: 0, duration, почти duration — это начало.
 * Иначе берём остаток от деления, чтобы таймлайн зацикливался.
 */
function wrapCloseupOffset(start, duration) {
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return 0;
  let offset = start % duration;
  if (offset < 0) offset += duration;
  // Только численный хвост float, без порога 20 мс: иначе playhead у конца
  // файла прыгает в 0 и начало крупного плана повторяется в следующем Shorts.
  if (offset < 1e-4 || duration - offset < 1e-4) return 0;
  return offset;
}

/**
 * Входы для правой половины: не с начала файла, а с playhead партии.
 *
 *   offset = 0              → одно зацикленное видео с нуля;
 *   remaining >= длительность результата → один кусок с -ss;
 *   иначе                   → хвост до конца, затем то же видео с начала (луп).
 */
function planCloseupInputs(closeup, startSec, neededSec) {
  const duration = closeup && closeup.duration ? closeup.duration : 0;
  const offset = wrapCloseupOffset(startSec, duration);
  const needed = Math.max(0.05, Number(neededSec) || 0);
  const remaining = duration - offset;
  const pad = 0.05;

  if (!closeup || !closeup.file) return { inputs: [], wrap: false, offset: 0, remaining, needed };

  if (offset === 0) {
    return {
      inputs: [{ file: closeup.file, options: ['-stream_loop', '-1'] }],
      wrap: false,
      offset: 0,
      remaining,
      needed
    };
  }

  if (needed <= remaining + 0.05) {
    return {
      inputs: [{
        file: closeup.file,
        options: ['-ss', offset.toFixed(3), '-t', (needed + pad).toFixed(3)]
      }],
      wrap: false,
      offset,
      remaining,
      needed
    };
  }

  return {
    inputs: [
      { file: closeup.file, options: ['-ss', offset.toFixed(3), '-t', (remaining + pad).toFixed(3)] },
      { file: closeup.file, options: ['-stream_loop', '-1'] }
    ],
    wrap: true,
    offset,
    remaining,
    needed
  };
}

function buildCloseupPrepFilters({ closeupIndex, wrap, target, duration, closeupFps, prefix = '', remaining = 0 }) {
  const fps = needsFpsConvert(target.fps, closeupFps) ? `fps=${target.fps},` : '';
  const tail = prefixed(prefix, 'cu_tail');
  const loop = prefixed(prefix, 'cu_loop');
  const src = prefixed(prefix, 'cu_src');
  const dur = Math.max(0.05, duration);
  if (wrap) {
    const tailDur = Math.max(0.05, Number(remaining) || 0).toFixed(3);
    const loopDur = Math.max(0.05, dur - Number(tailDur)).toFixed(3);
    return {
      filters: [
        `[${closeupIndex}:v:0]trim=duration=${tailDur},setpts=PTS-STARTPTS[${tail}]`,
        `[${closeupIndex + 1}:v:0]trim=duration=${loopDur},setpts=PTS-STARTPTS[${loop}]`,
        `[${tail}][${loop}]concat=n=2:v=1:a=0,` +
          `trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,${fps}setsar=1[${src}]`
      ],
      // Дальше coverFilter дописывает `,scale=...` — поэтому здесь уже должна
      // быть цепочка фильтров, а не голая метка `[cu_src],scale` (пустой фильтр).
      prep: `[${src}]setsar=1`
    };
  }

  return {
    filters: [],
    prep: `[${closeupIndex}:v:0]trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,${fps}setsar=1`
  };
}

/**
 * Делит кадр на две половины: слева смонтированный ролик, справа второе видео.
 *
 * Каждая половина заполняется независимо (cover), поэтому вертикальный 9:16
 * исходник сохраняет полный рост в колонке 540×1080, а не обрезается сверху
 * и снизу до квадрата. Правая половина по умолчанию увеличена в 1.8 раза.
 */
function buildSplitFilters({
  baseLabel,
  closeupIndex,
  closeupWrap,
  closeup,
  montage,
  outputLabel,
  target,
  split,
  duration,
  prefix = '',
  closeupRemaining = 0
}) {
  const width = target.width;
  const height = target.height;

  const leftWidth = clamp(evenRound((width * split.leftShare) / 100), 2, width - 2);
  const rightWidth = width - leftWidth;
  const featherLimit = Math.max(0, Math.min(leftWidth, rightWidth) - 2);
  const requested = clamp(split.feather, 0, featherLimit);
  const feather = requested > 0 ? Math.max(2, requested) : 0;

  const filters = [];
  const layout = { width, height, leftWidth, rightWidth, feather };
  const L = (name) => prefixed(prefix, name);

  const leftSrc = { width: montage.width, height: montage.height };
  const rightSrc = { width: closeup.width, height: closeup.height };
  const closeupPrep = buildCloseupPrepFilters({
    closeupIndex,
    wrap: Boolean(closeupWrap),
    target,
    duration,
    closeupFps: closeup.fps,
    prefix,
    remaining: closeupRemaining
  });
  filters.push(...closeupPrep.filters);
  const rightPrep = closeupPrep.prep;

  if (feather === 0) {
    filters.push(
      coverFilter(
        `[${baseLabel}]setsar=1,`,
        leftSrc, leftWidth, height, split.leftZoom, split.leftOffset, width,
        L('splitLeft')
      )
    );
    filters.push(
      coverFilter(
        `${rightPrep},`,
        rightSrc, rightWidth, height, split.rightZoom, split.rightOffset, width,
        L('splitRight')
      )
    );
    filters.push(`[${L('splitLeft')}][${L('splitRight')}]hstack=inputs=2:shortest=1[${outputLabel}]`);
    return { filters, layout };
  }

  const rightWindow = rightWidth + feather;
  const seam = leftWidth - feather;

  filters.push(
    coverFilter(
      `[${baseLabel}]setsar=1,`,
      leftSrc, leftWidth + feather, height, split.leftZoom, split.leftOffset, width,
      L('splitLeftWide')
    )
  );
  filters.push(`[${L('splitLeftWide')}]pad=${width}:${height}:0:0:black[${L('splitBase')}]`);
  filters.push(
    coverFilter(
      `${rightPrep},`,
      rightSrc, rightWindow, height, split.rightZoom, split.rightOffset, width,
      L('splitRightRgb')
    )
  );
  filters.push(`[${L('splitRightRgb')}]format=${alphaFormatFor(target.pixelFormat)}[${L('splitRight')}]`);
  filters.push(buildFeatherMaskFilter({
    width: rightWindow,
    height,
    fps: target.fps,
    duration,
    feather,
    outputLabel: L('splitMask')
  }));
  filters.push(`[${L('splitRight')}][${L('splitMask')}]alphamerge=shortest=1[${L('splitSoft')}]`);
  filters.push(
    `[${L('splitBase')}][${L('splitSoft')}]overlay=x=${seam}:y=0:shortest=1:format=yuv444:alpha=straight[${outputLabel}]`
  );

  return { filters, layout };
}

/**
 * Собирает список входов, граф фильтров и карту потоков для одного файла.
 *
 * Исходник подключается двумя отдельными входами (голова и хвост) вместо
 * split+trim: так ffmpeg не буферизует хвост видео в памяти, пока пишется
 * начало ролика.
 */
function buildGraph({
  source,
  shorts,
  overlay,
  closeup,
  closeupStart,
  split,
  target,
  splitAt,
  overlayOpacity,
  duration,
  labelPrefix = '',
  inputBase = 0,
  applyPace = true
}) {
  const inputs = [];
  const filters = [];
  const L = (name) => prefixed(labelPrefix, name);

  const headDuration = splitAt;
  const tailDuration = Math.max(0, source.duration - splitAt);

  // При сплите монтаж держит пропорции исходника и высоту холста: вертикальный
  // 9:16 не режется сверху и снизу до квадрата, а потом заполняет левую колонку.
  const montage = closeup
    ? {
        width: evenRound(target.height * (source.width / source.height)),
        height: target.height,
        fps: target.fps,
        fit: target.fit,
        pixelFormat: target.pixelFormat
      }
    : target;

  const headIndex = inputBase + inputs.length;
  inputs.push({ file: source.file, options: segmentInputOptions(0, headDuration) });
  const tailIndex = inputBase + inputs.length;
  inputs.push({ file: source.file, options: segmentInputOptions(splitAt, tailDuration) });
  const shortsIndex = inputBase + inputs.length;
  inputs.push({ file: shorts.file, options: segmentInputOptions(0, shorts.duration) });

  let overlayIndex = -1;
  if (overlay) {
    // Бесконечный луп: короткий оверлей повторяется, длинный обрежется по shortest=1.
    overlayIndex = inputBase + inputs.length;
    inputs.push({ file: overlay.file, options: ['-stream_loop', '-1'], pace: false });
  }

  let closeupIndex = -1;
  let closeupWrap = false;
  let closeupRemaining = 0;
  if (closeup) {
    // Правая половина идёт по таймлайну партии: ролик N продолжает с того места,
    // где закончился ролик N-1. Если файл кончился — начинается сначала.
    // Playhead и буфер входов считаются заново для этого Shorts — хвост
    // предыдущей операции сюда не подмешивается.
    const planned = planCloseupInputs(closeup, closeupStart, duration);
    closeupIndex = inputBase + inputs.length;
    closeupWrap = planned.wrap;
    closeupRemaining = planned.remaining;
    planned.inputs.forEach((input) => inputs.push({ ...input, pace: false }));
  }

  const segments = [
    { videoInput: headIndex, audioSource: source, audioInput: headIndex, duration: headDuration, fps: source.fps, width: source.width, height: source.height },
    { videoInput: shortsIndex, audioSource: shorts, audioInput: shortsIndex, duration: shorts.duration, fps: shorts.fps, width: shorts.width, height: shorts.height },
    { videoInput: tailIndex, audioSource: source, audioInput: tailIndex, duration: tailDuration, fps: source.fps, width: source.width, height: source.height }
  ];

  const concatLabels = [];
  segments.forEach((segment, i) => {
    const videoLabel = L(`v${i}`);
    const audioLabel = L(`a${i}`);

    filters.push(videoSegmentFilter(
      `${segment.videoInput}:v:0`,
      videoLabel,
      montage,
      segment.fps,
      { width: segment.width, height: segment.height },
      segment.duration
    ));

    // Сегмент без звука заменяется тишиной, иначе concat не соберёт дорожку.
    if (segment.audioSource.hasAudio) {
      filters.push(audioSegmentFilter(`${segment.audioInput}:a:0`, audioLabel, segment.duration));
    } else {
      filters.push(silentSegmentFilter(audioLabel, segment.duration));
    }

    concatLabels.push(`[${videoLabel}][${audioLabel}]`);
  });

  filters.push(`${concatLabels.join('')}concat=n=${segments.length}:v=1:a=1[${L('cv')}][${L('ca')}]`);

  let videoOut = L('cv');
  let layout = null;

  if (closeup) {
    const built = buildSplitFilters({
      baseLabel: videoOut,
      closeupIndex,
      closeupWrap,
      closeup,
      montage,
      outputLabel: L('sv'),
      target,
      split: normalizeSplit(split),
      duration,
      prefix: labelPrefix,
      closeupRemaining
    });
    filters.push(...built.filters);
    layout = built.layout;
    videoOut = L('sv');
  }

  // Оверлей ложится последним — поверх уже собранного split-screen.
  if (overlay) {
    const opacity = clamp(Number(overlayOpacity) / 100, 0, 1);
    const overlayFps = needsFpsConvert(target.fps, overlay.fps) ? `fps=${target.fps},` : '';
    const overlayAlpha = opacity >= 0.999
      ? 'format=rgba'
      : `format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}`;
    filters.push(
      `[${overlayIndex}:v:0]setpts=PTS-STARTPTS,${overlayFps}` +
        `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase:flags=${SCALE_FLAGS},` +
        `crop=${target.width}:${target.height},setsar=1,${overlayAlpha}[${L('ovl')}]`
    );
    filters.push(`[${videoOut}][${L('ovl')}]overlay=x=0:y=0:shortest=1:eof_action=pass:format=auto[${L('vout')}]`);
    videoOut = L('vout');
  }

  // Наложения работают в форматах с альфой и могут отдать 4:4:4, который не
  // возьмёт профиль кодека, — поэтому кадр всегда приводится к целевому формату.
  filters.push(`[${videoOut}]format=${target.pixelFormat}[${L('vfinal')}]`);

  const audioOut = L('ca');
  // Потолок 4× держит только -readrate на исходниках. realtime/arealtime в графе
  // дублировали паузу и нагружали CPU, не меняя качество.
  const pace = Boolean(applyPace && target.pixelFormat === 'yuv420p');
  return { inputs, filters, videoOut: L('vfinal'), audioOut, layout, pace };
}

// ---------------------------------------------------------------------------
// Обработка одного файла
// ---------------------------------------------------------------------------

function resolveTarget(frameKey, fitKey, source, plan) {
  const frame = FRAME_PRESETS[frameKey] || FRAME_PRESETS[DEFAULTS.frame];
  return {
    width: evenRound(frame.width || source.width),
    height: evenRound(frame.height || source.height),
    fps: chooseOutputFps(source.fps),
    fit: FIT_MODES[fitKey] ? fitKey : DEFAULTS.fit,
    pixelFormat: plan.pixelFormat
  };
}

function resolveSplitAt(source, percent) {
  const minSegment = Math.max(0.05, 2 / source.fps);
  return clamp(
    (source.duration * percent) / 100,
    minSegment,
    Math.max(minSegment, source.duration - minSegment)
  );
}

/**
 * ffmpeg-static на Windows — 6.1.1. Опция `-/filter_complex` появилась только в 7.0
 * и на 6.1 даёт «Error splitting the argument list: Option not found» на каждом файле.
 * Короткий граф — обычный -filter_complex. Длинный — -filter_complex_script (есть с 1.x).
 */
function attachFilterGraph(command, filters) {
  const text = Array.isArray(filters) ? filters.filter(Boolean).join(';') : String(filters || '');
  if (text.length < FILTER_SCRIPT_THRESHOLD) {
    command.complexFilter(text);
    return null;
  }
  const script = path.join(
    os.tmpdir(),
    `shorts-fc-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ffilter`
  );
  fs.writeFileSync(script, text, 'utf8');
  command._complexFilters('-filter_complex_script', script);
  command._filterScriptPath = script;
  return script;
}

function applyInputs(command, inputs, plan, pace) {
  inputs.forEach((input) => {
    const added = command.input(input.file);
    if (plan.hwaccel) added.inputOptions(['-hwaccel', plan.hwaccel]);
    if (pace && input.pace !== false) added.inputOptions(paceGlobalArgs());
    if (input.options && input.options.length) added.inputOptions(input.options);
  });
}

function runCommand(command, { plan, totalDuration, onProgress, onCommand, onDebug }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => safeUnlink(command._filterScriptPath);
    const finish = (handler) => (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };

    command.on('start', (commandLine) => {
      lowerFfmpegPriority(command);
      if (typeof onCommand === 'function') onCommand(command);
      if (typeof onDebug === 'function') onDebug(commandLine);
    });
    command.on('stderr', (line) => {
      if (typeof onDebug === 'function') onDebug(line);
    });
    command.on('progress', (progress) => {
      if (typeof onProgress !== 'function' || totalDuration <= 0) return;
      const done = timemarkToSeconds(progress.timemark);
      onProgress(clamp((done / totalDuration) * 100, 0, 99.9), done);
    });
    command.on('error', finish((err) => {
      if (isCommandTooLong(err) || isUnknownFfmpegOption(err)) {
        reject(err);
        return;
      }
      if (plan && plan.usingGpu) {
        reject(new GpuUnavailableError(err));
        return;
      }
      reject(err);
    }));
    command.on('end', finish(() => resolve()));
    try {
      command.run();
    } catch (err) {
      finish((value) => reject(value))(err);
    }
  });
}

/**
 * @param {object} params
 * @param {object} params.source      результат probeMedia() для исходника
 * @param {object} params.shorts      результат probeMedia() для Shorts
 * @param {object|null} params.overlay результат probeMedia() для оверлея
 * @param {object|null} params.closeup результат probeMedia() для правой половины
 * @param {number} [params.closeupStart] секунда внутри второго видео, с которой начинается правая половина
 * @param {object} params.split       настройки раскладки split-screen
 * @param {string} params.outputFile  путь к esN.mov
 * @param {number} params.percent     процент обрезки (50..99)
 * @param {string} params.encoder     ключ ENCODERS
 * @param {object} [params.plan]      результат resolveEncodePlan()
 * @param {string} params.frame       ключ FRAME_PRESETS (размер итогового кадра)
 * @param {string} params.fit         ключ FIT_MODES (обрезать или вписать)
 * @param {number} params.overlayOpacity 0..100
 * @param {function} params.onProgress вызывается с (0..100)
 * @param {function} params.onCommand  получает объект команды (для остановки)
 * @param {function} params.onDebug    строка запуска ffmpeg / stderr
 */
function renderVideo(params) {
  const {
    source,
    shorts,
    overlay,
    closeup,
    split,
    outputFile,
    percent,
    encoder,
    overlayOpacity,
    onProgress,
    onCommand,
    onDebug
  } = params;

  const hardware = params.hardware || detectHardware();
  const plan = params.plan || resolveEncodePlan(encoder, params.accel, hardware);
  const target = resolveTarget(params.frame, params.fit, source, plan);
  const timeline = isolateJobTimeline({
    closeupStart: params.closeupStart,
    splitAt: Number.isFinite(Number(params.splitAt)) && Number(params.splitAt) > 0
      ? Number(params.splitAt)
      : resolveSplitAt(source, percent),
    duration: Number.isFinite(Number(params.duration)) && Number(params.duration) > 0
      ? Number(params.duration)
      : source.duration + shorts.duration,
    percent
  });
  const splitAt = timeline.splitAt;
  const totalDuration = timeline.duration;

  const { inputs, filters, videoOut, audioOut, layout, pace } = buildGraph({
    source,
    shorts,
    overlay,
    closeup,
    closeupStart: timeline.closeupStart,
    split,
    target,
    splitAt,
    overlayOpacity,
    duration: totalDuration
  });

  const command = ffmpeg();
  applyInputs(command, inputs, plan, pace);
  command._global([
    '-filter_complex_threads', String(plan.threads.filterThreads),
    '-filter_threads', String(plan.threads.filterThreads)
  ]);
  attachFilterGraph(command, filters);
  command
    .outputOptions([
      '-map', `[${videoOut}]`,
      '-map', `[${audioOut}]`,
      ...plan.videoOptions,
      ...plan.audioOptions,
      '-ar', String(AUDIO_SAMPLE_RATE),
      '-ac', '2',
      '-r', String(target.fps),
      '-pix_fmt', plan.pixelFormat,
      '-vsync', 'cfr',
      ...(plan.extraOptions || []),
      '-y'
    ])
    .format(outputContainer(encoder))
    .output(outputFile);

  return runCommand(command, {
    plan,
    totalDuration,
    onProgress: typeof onProgress === 'function' ? (pct) => onProgress(pct) : null,
    onCommand,
    onDebug
  }).then(() => {
    if (typeof onProgress === 'function') onProgress(100);
    return {
      outputFile,
      splitAt,
      layout,
      expectedDuration: totalDuration
    };
  });
}


// ---------------------------------------------------------------------------
// Пакетная обработка
// ---------------------------------------------------------------------------

/**
 * Управляет очередью файлов: ошибка на одном ролике не останавливает остальные.
 *
 * hooks: { onLog(level, message), onProgress(state), onFileDone(info) }
 */
class BatchProcessor {
  constructor(settings, hooks = {}) {
    this.settings = settings;
    this.hooks = hooks;
    this.cancelled = false;
    this.currentCommand = null;
    this.currentOutput = null;
    this.running = false;
  }

  log(level, message) {
    if (typeof this.hooks.onLog === 'function') this.hooks.onLog(level, message);
  }

  emitProgress(state) {
    if (typeof this.hooks.onProgress === 'function') this.hooks.onProgress(state);
  }

  stop() {
    if (!this.running || this.cancelled) return;
    this.cancelled = true;
    this.log('warn', 'Получен запрос на остановку. Завершаем текущий файл…');
    if (this.currentCommand) {
      try {
        this.currentCommand.kill('SIGKILL');
      } catch (err) {
        this.log('error', `Не удалось остановить FFmpeg: ${err.message}`);
      }
    }
  }

  validate() {
    const s = this.settings;
    const errors = [];

    if (!s.sourceDir || !fs.existsSync(s.sourceDir)) errors.push('Папка с исходными видео не найдена.');
    if (!s.shortsFile || !fs.existsSync(s.shortsFile)) errors.push('Файл Shorts не найден.');
    if (s.useOverlay && (!s.overlayFile || !fs.existsSync(s.overlayFile))) {
      errors.push('Оверлей включён, но файл не выбран или не найден.');
    }
    if (s.useSplit && (!s.closeupFile || !fs.existsSync(s.closeupFile))) {
      errors.push('Split-screen включён, но видео для правой половины не выбрано или не найдено.');
    }
    if (!s.outputDir) errors.push('Не выбрана папка для сохранения результата.');

    const percent = Number(s.percent);
    if (!Number.isFinite(percent) || percent < 50 || percent > 99) {
      errors.push('Процент обрезки должен быть числом от 50 до 99.');
    }

    return errors;
  }

  async run() {
    if (this.running) throw new Error('Обработка уже запущена');
    this.running = true;

    const startedAt = Date.now();
    const summary = { total: 0, done: 0, failed: 0, cancelled: false, results: [], elapsedMs: 0 };

    try {
      const errors = this.validate();
      if (errors.length) {
        errors.forEach((message) => this.log('error', message));
        throw new Error(errors[0]);
      }

      const s = this.settings;
      const percent = clamp(Number(s.percent), 50, 99);
      const encoder = ENCODERS[s.encoder] ? s.encoder : DEFAULTS.encoder;
      const accel = ACCEL_MODES[s.accel] ? s.accel : DEFAULTS.accel;
      const prefix = s.outputPrefix || DEFAULTS.outputPrefix;
      const overlayOpacity = Number.isFinite(Number(s.overlayOpacity)) ? Number(s.overlayOpacity) : 100;
      const hardware = detectHardware();
      const plan = resolveEncodePlan(encoder, accel, hardware);
      const cpuPlan = resolveEncodePlan(encoder, 'cpu', hardware);

      fs.mkdirSync(s.outputDir, { recursive: true });

      const sameDir = path.resolve(s.outputDir) === path.resolve(s.sourceDir);
      const sources = listVideoFiles(s.sourceDir, { skipOutputNames: sameDir, outputPrefix: prefix });
      summary.total = sources.length;

      if (!sources.length) {
        throw new Error('В выбранной папке нет видеофайлов.');
      }

      const frame = FRAME_PRESETS[s.frame] ? s.frame : DEFAULTS.frame;
      const fit = FIT_MODES[s.fit] ? s.fit : DEFAULTS.fit;

      this.log('info', `Найдено видео: ${sources.length}`);
      this.log('info', `FFmpeg: ${ffmpegPath}`);
      this.log('info', `Кодек: ${ENCODERS[encoder].label}, обрезка: ${percent}%`);
      this.log('info', `Нагрузка: ${plan.label}`);
      if (plan.pixelFormat === 'yuv420p') {
        this.log(
          'info',
          `Скорость: до ${ENCODE_PACE_SPEED}× (~50% Video Encode), без лишней нагрузки на CPU. ` +
            `Каждый ролик пишется сразу в ${prefix}N${outputExtension(encoder)}, пауза ${INTER_FILE_DELAY_MS} мс между файлами`
        );
      }
      if (hardware.compiledGpu && hardware.compiledGpu.length) {
        this.log('info', `GPU-кодеки в FFmpeg: ${hardware.compiledGpu.join(', ')}`);
      }
      if (!plan.usingGpu && accel !== 'cpu' && hardware.probeError) {
        this.log('warn', `Тест видеокарты: ${hardware.probeError}`);
      }
      this.log(
        'info',
        `Кадр: ${FRAME_PRESETS[frame].label}, ${FIT_MODES[fit].label.toLowerCase()}`
      );

      const shorts = await probeMedia(s.shortsFile);
      this.log(
        'info',
        `Shorts: ${path.basename(shorts.file)} — ${shorts.width}x${shorts.height}, ` +
          `${formatDuration(shorts.duration)}${shorts.hasAudio ? '' : ', без звука'}`
      );

      let overlay = null;
      if (s.useOverlay) {
        overlay = await probeMedia(s.overlayFile);
        this.log(
          'info',
          `Оверлей: ${path.basename(overlay.file)} — ${overlay.width}x${overlay.height}, ` +
            `${formatDuration(overlay.duration)}, прозрачность ${100 - overlayOpacity}%`
        );
      }

      const split = normalizeSplit(s.split);
      let closeup = null;
      if (s.useSplit) {
        closeup = await probeMedia(s.closeupFile);
        this.log(
          'info',
          `Split-screen: ${path.basename(closeup.file)} — ${closeup.width}x${closeup.height}, ` +
            `${formatDuration(closeup.duration)} (звук второго видео не используется)`
        );
        this.log(
          'info',
          `Раскладка: левая часть ${split.leftShare}% (зум ${split.leftZoom.toFixed(2)}, ` +
            `сдвиг ${split.leftOffset}%), правая — зум ${split.rightZoom.toFixed(2)}, ` +
            `сдвиг ${split.rightOffset}%, граница ${split.feather ? `мягкая ${split.feather} px` : 'чёткая'}`
        );
        this.log(
          'info',
          'Крупный план справа идёт подряд: каждый следующий ролик продолжает с того места, где закончился предыдущий'
        );
      }

      let closeupHead = 0;
      const jobs = [];

      for (let i = 0; i < sources.length; i += 1) {
        if (this.cancelled) break;

        const sourceFile = sources[i];
        const fileName = path.basename(sourceFile);
        const outputFile = path.join(s.outputDir, `${prefix}${i + 1}${outputExtension(encoder)}`);
        const humanIndex = `${i + 1}/${sources.length}`;

        try {
          const source = await probeMedia(sourceFile);
          if (source.duration <= 0.2) {
            throw new Error('Слишком короткое или повреждённое видео.');
          }

          this.log(
            'info',
            `[${humanIndex}] ${fileName} — ${source.width}x${source.height}, ${source.fps} fps, ` +
              `${formatDuration(source.duration)}${source.hasAudio ? '' : ', без звука'}`
          );
          this.log(
            'info',
            `[${humanIndex}] Точка вставки: ${formatDuration((source.duration * percent) / 100)} ` +
              `(${percent}%) → ${path.basename(outputFile)}`
          );

          const target = resolveTarget(frame, fit, source, plan);
          const splitAt = resolveSplitAt(source, percent);
          const duration = source.duration + shorts.duration;
          const timeline = isolateJobTimeline({
            closeupStart: closeup ? wrapCloseupOffset(closeupHead, closeup.duration) : 0,
            splitAt,
            duration,
            percent
          });
          if (closeup) {
            this.log(
              'info',
              `[${humanIndex}] Крупный план справа: с ${formatDuration(timeline.closeupStart)} ` +
                `(таймлайн второго видео)`
            );
          }

          jobs.push({
            index: i,
            source,
            outputFile,
            fileName,
            humanIndex,
            closeupStart: timeline.closeupStart,
            target,
            splitAt: timeline.splitAt,
            duration: timeline.duration,
            percent: timeline.percent,
            encoder,
            hardware,
            frame,
            fit
          });
          // Playhead двигаем по плану этого ролика, не по фактическому хвосту.
          // Иначе 20% текущего файла оседают как «остаток» следующего Shorts.
          if (closeup) closeupHead += timeline.duration;
        } catch (err) {
          if (this.cancelled) break;
          summary.failed += 1;
          this.log('error', `[${humanIndex}] Ошибка на файле ${fileName}: ${shortenFfmpegError(err.message)}`);
          safeUnlink(outputFile);
          this.emitProgress({
            fileIndex: i,
            total: sources.length,
            fileName,
            filePercent: 0,
            overallPercent: ((i + 1) / sources.length) * 100,
            status: `Ошибка ${humanIndex}: ${fileName}`,
            done: summary.done,
            failed: summary.failed
          });
        }
      }

      const bindCommand = (command) => {
        this.currentCommand = command;
        if (this.cancelled) {
          try {
            command.kill('SIGKILL');
          } catch (err) {
            /* процесс мог ещё не стартовать */
          }
        }
      };

      const emitJobProgress = (job, filePercent, status) => {
        this.emitProgress({
          fileIndex: job.index,
          total: sources.length,
          fileName: job.fileName,
          outputName: path.basename(job.outputFile),
          filePercent,
          overallPercent: ((job.index + filePercent / 100) / sources.length) * 100,
          status: status || `Обработка ${job.humanIndex}: ${job.fileName} — ${filePercent.toFixed(1)}%`,
          done: summary.done,
          failed: summary.failed
        });
      };

      const finished = new Set();
      const markJobDone = (job) => {
        if (!job || finished.has(job.outputFile)) return false;
        if (!fs.existsSync(job.outputFile)) return false;
        const size = fs.statSync(job.outputFile).size;
        if (size < MIN_OUTPUT_BYTES) return false;
        finished.add(job.outputFile);
        summary.done += 1;
        summary.results.push({ source: job.source.file, output: job.outputFile, size });
        this.log(
          'success',
          `[${job.humanIndex}] Готово: ${path.basename(job.outputFile)} ` +
            `(${(size / 1024 / 1024).toFixed(1)} МБ)`
        );
        emitJobProgress(job, 100, `Завершено ${job.index + 1} из ${sources.length}`);
        return true;
      };

      const encodeOne = async (job, encodePlan) => {
        this.currentOutput = job.outputFile;
        emitJobProgress(job, 0, `Обработка ${job.humanIndex}: ${job.fileName}`);
        await renderVideo({
          source: job.source,
          shorts,
          overlay,
          closeup,
          closeupStart: job.closeupStart,
          splitAt: job.splitAt,
          duration: job.duration,
          split,
          outputFile: job.outputFile,
          percent: job.percent,
          encoder,
          plan: encodePlan,
          hardware,
          frame,
          fit,
          overlayOpacity,
          onCommand: bindCommand,
          onDebug: (line) => {
            if (this.settings.verbose) this.log('debug', line);
          },
          onProgress: (filePercent) => emitJobProgress(job, filePercent)
        });
      };

      let encodePlan = plan;
      let encodedAny = false;

      for (const job of jobs) {
        if (this.cancelled) break;
        if (encodedAny) await sleep(INTER_FILE_DELAY_MS);
        if (this.cancelled) break;
        encodedAny = true;

        try {
          try {
            await encodeOne(job, encodePlan);
          } catch (err) {
            if (this.cancelled) throw err;
            if (err && err.gpuFallback && encodePlan.usingGpu) {
              this.log(
                'warn',
                `Видеокарта не приняла кадр (${shortenFfmpegError(err.message)}), дальше кодируем на процессоре`
              );
              safeUnlink(job.outputFile);
              encodePlan = cpuPlan;
              await encodeOne(job, encodePlan);
            } else {
              throw err;
            }
          }
          if (this.cancelled) {
            safeUnlink(job.outputFile);
            break;
          }
          if (!markJobDone(job)) {
            throw new Error(`Файл не записался: ${path.basename(job.outputFile)}`);
          }
        } catch (err) {
          if (this.cancelled) {
            safeUnlink(job.outputFile);
            break;
          }
          summary.failed += 1;
          this.log(
            'error',
            `[${job.humanIndex}] Ошибка на файле ${job.fileName}: ${shortenFfmpegError(err.message)}`
          );
          safeUnlink(job.outputFile);
          emitJobProgress(job, 0, `Ошибка ${job.humanIndex}: ${job.fileName}`);
        } finally {
          this.currentCommand = null;
          this.currentOutput = null;
        }
      }

      summary.cancelled = this.cancelled;
      summary.elapsedMs = Date.now() - startedAt;
      return summary;
    } finally {
      this.running = false;
      this.currentCommand = null;
    }
  }
}

module.exports = {
  BatchProcessor,
  ENCODERS,
  ACCEL_MODES,
  FRAME_PRESETS,
  FIT_MODES,
  DEFAULTS,
  SPLIT_DEFAULTS,
  normalizeSplit,
  VIDEO_EXTENSIONS,
  ProcessingCancelledError,
  GpuUnavailableError,
  ffmpegPath,
  ffprobePath,
  detectHardware,
  resolveEncodePlan,
  listVideoFiles,
  probeMedia,
  renderVideo,
  formatDuration,
  outputContainer,
  outputExtension,
  wrapCloseupOffset,
  planCloseupInputs,
  isolateJobTimeline,
  segmentInputOptions,
  resolveSplitAt,
  buildFeatherMaskFilter,
  isVideoFile,
  shortenFfmpegError,
  ENCODE_PACE_SPEED,
  INTER_FILE_DELAY_MS,
  FILTER_SCRIPT_THRESHOLD,
  paceGlobalArgs,
  attachFilterGraph,
  isUnknownFfmpegOption
};
