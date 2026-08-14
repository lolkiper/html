'use strict';

/**
 * processor.js — вся работа с FFmpeg.
 *
 * Для каждого исходного видео собирается один ffmpeg-процесс, который:
 *   1) берёт первые X% исходника,
 *   2) подставляет за ними ролик Shorts,
 *   3) добавляет оставшийся хвост исходника,
 *   4) (опционально) накладывает оверлей на весь хронометраж,
 *   5) пишет результат в .mov (esN.mov).
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
 * Потолок относительно realtime. Фильтр realtime стоит в КОНЦЕ графа, поэтому
 * FFmpeg всё равно вычитывает входы пачкой и NVENC на стыке файлов уходит в 100%.
 * -readrate душит демультиплексор с первого пакета; burst=0 — без 0.5 с разгона.
 * 1.5× при 30 fps ≈ 45 кадров/с, Video Encode на RTX 3060 ~15–25%.
 */
const ENCODE_PACE_SPEED = 1.5;
/** Пауза между роликами, чтобы сессия NVENC успела закрыться и график сбросился. */
const INTER_FILE_PAUSE_MS = 900;

function paceGlobalArgs() {
  return [
    '-readrate', String(ENCODE_PACE_SPEED),
    '-readrate_initial_burst', '0'
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pauseBetweenFiles(isCancelled) {
  const step = 100;
  let left = INTER_FILE_PAUSE_MS;
  while (left > 0) {
    if (typeof isCancelled === 'function' && isCancelled()) return;
    const chunk = Math.min(step, left);
    await sleep(chunk);
    left -= chunk;
  }
}

/** Пресеты кодеков для контейнера .mov. */
const ENCODERS = {
  h264: {
    label: 'H.264 — быстро (veryfast)',
    pixelFormat: 'yuv420p',
    videoOptions: [
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high',
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
      ['-gpu', '0', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-rc-lookahead', '0', '-strict_gop', '1', '-bf', '0', '-async_depth', '1'],
      ['-gpu', '1', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-rc-lookahead', '0', '-strict_gop', '1', '-bf', '0', '-async_depth', '1'],
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
      ['-gpu', '0', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '26', '-b:v', '0', '-rc-lookahead', '0', '-strict_gop', '1', '-bf', '0', '-async_depth', '1', '-tag:v', 'hvc1'],
      ['-gpu', '1', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '26', '-b:v', '0', '-rc-lookahead', '0', '-strict_gop', '1', '-bf', '0', '-async_depth', '1', '-tag:v', 'hvc1'],
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
      videoOptions: ['-c:v', gpu.id, ...(gpu.extra || [])],
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
    videoOptions: [...cpu.videoOptions, '-threads', String(threads.encodeThreads)],
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
 * Файлы, которые совпадают с шаблоном результата (esN.mov), игнорируются —
 * иначе повторный запуск с той же папкой на входе и выходе зациклится.
 */
function listVideoFiles(directory, options = {}) {
  const prefix = options.outputPrefix || DEFAULTS.outputPrefix;
  const skipOutputNames = Boolean(options.skipOutputNames);
  const outputPattern = new RegExp(`^${prefix}\\d+\\.mov$`, 'i');

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
  return (meaningful[meaningful.length - 1] || lines[0] || 'неизвестная ошибка').slice(0, 400);
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

function videoSegmentFilter(inputLabel, outputLabel, target, inputFps, srcSize) {
  return (
    `[${inputLabel}]${filterChain(
      'setpts=PTS-STARTPTS',
      needsFpsConvert(target.fps, inputFps) ? `fps=${target.fps}` : '',
      fitStep(target, srcSize),
      'setsar=1',
      `format=${target.pixelFormat}`
    )}[${outputLabel}]`
  );
}

const AUDIO_FORMAT_FILTER =
  `aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=${AUDIO_LAYOUT}`;

function audioSegmentFilter(inputLabel, outputLabel) {
  return (
    `[${inputLabel}]asetpts=PTS-STARTPTS,aresample=${AUDIO_SAMPLE_RATE}:first_pts=0,` +
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
  if (offset < 0.02 || duration - offset < 0.02) return 0;
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
  const pad = 0.2;

  if (!closeup || !closeup.file) return { inputs: [], wrap: false, offset: 0 };

  if (offset === 0) {
    return {
      inputs: [{ file: closeup.file, options: ['-stream_loop', '-1'] }],
      wrap: false,
      offset: 0
    };
  }

  if (needed <= remaining + 0.05) {
    return {
      inputs: [{
        file: closeup.file,
        options: ['-ss', offset.toFixed(3), '-t', (needed + pad).toFixed(3)]
      }],
      wrap: false,
      offset
    };
  }

  return {
    inputs: [
      { file: closeup.file, options: ['-ss', offset.toFixed(3)] },
      { file: closeup.file, options: ['-stream_loop', '-1'] }
    ],
    wrap: true,
    offset
  };
}

function buildCloseupPrepFilters({ closeupIndex, wrap, target, duration, closeupFps }) {
  const fps = needsFpsConvert(target.fps, closeupFps) ? `fps=${target.fps},` : '';
  if (wrap) {
    const dur = Math.max(0.05, duration).toFixed(3);
    return {
      filters: [
        `[${closeupIndex}:v:0]setpts=PTS-STARTPTS[cu_tail]`,
        `[${closeupIndex + 1}:v:0]setpts=PTS-STARTPTS[cu_loop]`,
        `[cu_tail][cu_loop]concat=n=2:v=1:a=0,` +
          `trim=duration=${dur},setpts=PTS-STARTPTS,${fps}setsar=1[cu_src]`
      ],
      // Дальше coverFilter дописывает `,scale=...` — поэтому здесь уже должна
      // быть цепочка фильтров, а не голая метка `[cu_src],scale` (пустой фильтр).
      prep: '[cu_src]setsar=1'
    };
  }

  return {
    filters: [],
    prep: `[${closeupIndex}:v:0]setpts=PTS-STARTPTS,${fps}setsar=1`
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
  duration
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

  const leftSrc = { width: montage.width, height: montage.height };
  const rightSrc = { width: closeup.width, height: closeup.height };
  const closeupPrep = buildCloseupPrepFilters({
    closeupIndex,
    wrap: Boolean(closeupWrap),
    target,
    duration,
    closeupFps: closeup.fps
  });
  filters.push(...closeupPrep.filters);
  const rightPrep = closeupPrep.prep;

  if (feather === 0) {
    filters.push(
      coverFilter(
        `[${baseLabel}]setsar=1,`,
        leftSrc, leftWidth, height, split.leftZoom, split.leftOffset, width,
        'splitLeft'
      )
    );
    filters.push(
      coverFilter(
        `${rightPrep},`,
        rightSrc, rightWidth, height, split.rightZoom, split.rightOffset, width,
        'splitRight'
      )
    );
    filters.push(`[splitLeft][splitRight]hstack=inputs=2:shortest=1[${outputLabel}]`);
    return { filters, layout };
  }

  const rightWindow = rightWidth + feather;
  const seam = leftWidth - feather;

  filters.push(
    coverFilter(
      `[${baseLabel}]setsar=1,`,
      leftSrc, leftWidth + feather, height, split.leftZoom, split.leftOffset, width,
      'splitLeftWide'
    )
  );
  filters.push(`[splitLeftWide]pad=${width}:${height}:0:0:black[splitBase]`);
  filters.push(
    coverFilter(
      `${rightPrep},`,
      rightSrc, rightWindow, height, split.rightZoom, split.rightOffset, width,
      'splitRightRgb'
    )
  );
  filters.push(`[splitRightRgb]format=${alphaFormatFor(target.pixelFormat)}[splitRight]`);

  const maskDuration = Math.max(1, duration + 1).toFixed(3);
  // Raised-cosine вместо линейного lerp: по краям стык полностью непрозрачный,
  // в середине нет «двойной экспозиции». Маска сразу того же размера, что и
  // правая полоса — без loop/hstack, которые сжимают градиент в несколько пикселей.
  const denom = Math.max(1, feather - 1).toFixed(1);
  const ease = `0.5-0.5*cos(PI*clip(X/${denom},0,1))`;
  filters.push(
    `color=c=black:s=${rightWindow}x${height}:r=${target.fps}:d=${maskDuration},` +
      `format=gray,geq=lum='255*(${ease})'[splitMask]`
  );
  filters.push(`[splitRight][splitMask]alphamerge=shortest=1[splitSoft]`);
  filters.push(
    `[splitBase][splitSoft]overlay=x=${seam}:y=0:shortest=1:format=yuv444:alpha=straight[${outputLabel}]`
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
  duration
}) {
  const inputs = [];
  const filters = [];

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

  // 0 — голова исходника
  inputs.push({ file: source.file, options: ['-t', headDuration.toFixed(3)] });
  // 1 — хвост исходника
  inputs.push({ file: source.file, options: ['-ss', splitAt.toFixed(3)] });
  // 2 — Shorts
  inputs.push({ file: shorts.file, options: [] });

  let overlayIndex = -1;
  if (overlay) {
    // Бесконечный луп: короткий оверлей повторяется, длинный обрежется по shortest=1.
    overlayIndex = inputs.length;
    inputs.push({ file: overlay.file, options: ['-stream_loop', '-1'] });
  }

  let closeupIndex = -1;
  let closeupWrap = false;
  if (closeup) {
    // Правая половина идёт по таймлайну партии: ролик N продолжает с того места,
    // где закончился ролик N-1. Если файл кончился — начинается сначала.
    const planned = planCloseupInputs(closeup, closeupStart, duration);
    closeupIndex = inputs.length;
    closeupWrap = planned.wrap;
    planned.inputs.forEach((input) => inputs.push(input));
  }

  const segments = [
    { videoInput: 0, audioSource: source, audioInput: 0, duration: headDuration, fps: source.fps, width: source.width, height: source.height },
    { videoInput: 2, audioSource: shorts, audioInput: 2, duration: shorts.duration, fps: shorts.fps, width: shorts.width, height: shorts.height },
    { videoInput: 1, audioSource: source, audioInput: 1, duration: tailDuration, fps: source.fps, width: source.width, height: source.height }
  ];

  const concatLabels = [];
  segments.forEach((segment, i) => {
    const videoLabel = `v${i}`;
    const audioLabel = `a${i}`;

    filters.push(videoSegmentFilter(
      `${segment.videoInput}:v:0`,
      videoLabel,
      montage,
      segment.fps,
      { width: segment.width, height: segment.height }
    ));

    // Сегмент без звука заменяется тишиной, иначе concat не соберёт дорожку.
    if (segment.audioSource.hasAudio) {
      filters.push(audioSegmentFilter(`${segment.audioInput}:a:0`, audioLabel));
    } else {
      filters.push(silentSegmentFilter(audioLabel, segment.duration));
    }

    concatLabels.push(`[${videoLabel}][${audioLabel}]`);
  });

  filters.push(`${concatLabels.join('')}concat=n=${segments.length}:v=1:a=1[cv][ca]`);

  let videoOut = 'cv';
  let layout = null;

  if (closeup) {
    const built = buildSplitFilters({
      baseLabel: videoOut,
      closeupIndex,
      closeupWrap,
      closeup,
      montage,
      outputLabel: 'sv',
      target,
      split: normalizeSplit(split),
      duration
    });
    filters.push(...built.filters);
    layout = built.layout;
    videoOut = 'sv';
  }

  // Оверлей ложится последним — поверх уже собранного split-screen.
  if (overlay) {
    const opacity = clamp(Number(overlayOpacity) / 100, 0, 1);
    const overlayFps = needsFpsConvert(target.fps, overlay.fps) ? `fps=${target.fps},` : '';
    filters.push(
      `[${overlayIndex}:v:0]setpts=PTS-STARTPTS,${overlayFps}` +
        `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase:flags=${SCALE_FLAGS},` +
        `crop=${target.width}:${target.height},setsar=1,format=rgba,` +
        `colorchannelmixer=aa=${opacity.toFixed(3)}[ovl]`
    );
    filters.push(`[${videoOut}][ovl]overlay=x=0:y=0:shortest=1:eof_action=pass:format=auto[vout]`);
    videoOut = 'vout';
  }

  // Наложения работают в форматах с альфой и могут отдать 4:4:4, который не
  // возьмёт профиль кодека, — поэтому кадр всегда приводится к целевому формату.
  filters.push(`[${videoOut}]format=${target.pixelFormat}[vfinal]`);

  // realtime — страховка, если сборка FFmpeg без -readrate. Основной тормоз —
  // чтение входа (см. paceGlobalArgs), иначе декодер всё равно бежит вперёд.
  if (target.pixelFormat === 'yuv420p') {
    filters.push(
      `[vfinal]setpts=PTS-STARTPTS,realtime=speed=${ENCODE_PACE_SPEED}[vpaced]`
    );
    filters.push(
      `[ca]asetpts=PTS-STARTPTS,arealtime=speed=${ENCODE_PACE_SPEED}[apaced]`
    );
    return { inputs, filters, videoOut: 'vpaced', audioOut: 'apaced', layout, pace: true };
  }

  return { inputs, filters, videoOut: 'vfinal', audioOut: 'ca', layout, pace: false };
}

// ---------------------------------------------------------------------------
// Обработка одного файла
// ---------------------------------------------------------------------------

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
  const frame = FRAME_PRESETS[params.frame] || FRAME_PRESETS[DEFAULTS.frame];
  const target = {
    width: evenRound(frame.width || source.width),
    height: evenRound(frame.height || source.height),
    fps: chooseOutputFps(source.fps),
    fit: FIT_MODES[params.fit] ? params.fit : DEFAULTS.fit,
    pixelFormat: plan.pixelFormat
  };

  // У головы и хвоста должно остаться хотя бы по паре кадров, иначе concat получит пустой вход.
  const minSegment = Math.max(0.05, 2 / source.fps);
  const splitAt = clamp(
    (source.duration * percent) / 100,
    minSegment,
    Math.max(minSegment, source.duration - minSegment)
  );
  const totalDuration = source.duration + shorts.duration;

  const { inputs, filters, videoOut, audioOut, layout, pace } = buildGraph({
    source,
    shorts,
    overlay,
    closeup,
    closeupStart: Number(params.closeupStart) || 0,
    split,
    target,
    splitAt,
    overlayOpacity,
    duration: totalDuration
  });

  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    inputs.forEach((input) => {
      const added = command.input(input.file);
      // Аппаратное декодирование — до -i. На фильтрах кадры всё равно в RAM.
      if (plan.hwaccel) added.inputOptions(['-hwaccel', plan.hwaccel]);
      // readrate тоже до -i: иначе FFmpeg вычитывает файл пачкой, а realtime
      // в конце графа уже не спасает Video Encode на старте.
      if (pace) added.inputOptions(paceGlobalArgs());
      if (input.options && input.options.length) added.inputOptions(input.options);
    });

    command._global([
      '-filter_complex_threads', String(plan.threads.filterThreads),
      '-filter_threads', String(plan.threads.filterThreads)
    ]);

    command
      .complexFilter(filters)
      .outputOptions([
        '-map', `[${videoOut}]`,
        '-map', `[${audioOut}]`,
        ...plan.videoOptions,
        ...plan.audioOptions,
        '-ar', String(AUDIO_SAMPLE_RATE),
        '-ac', '2',
        '-r', String(target.fps),
        '-vsync', 'cfr',
        ...(plan.extraOptions || []),
        '-y'
      ])
      .format('mov')
      .output(outputFile);

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
      onProgress(clamp((done / totalDuration) * 100, 0, 99.9));
    });

    command.on('error', (err) => {
      if (plan.usingGpu) {
        reject(new GpuUnavailableError(err));
        return;
      }
      reject(err);
    });

    command.on('end', () => {
      if (typeof onProgress === 'function') onProgress(100);
      resolve({
        outputFile,
        splitAt,
        layout,
        expectedDuration: totalDuration
      });
    });

    command.run();
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
          `Скорость: вход читается не быстрее ${ENCODE_PACE_SPEED}×, без стартового выброса ` +
            `(иначе на стыке файлов Video Encode на мгновение уходит в 100%)`
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

      for (let i = 0; i < sources.length; i += 1) {
        if (this.cancelled) break;

        const sourceFile = sources[i];
        const fileName = path.basename(sourceFile);
        const outputFile = path.join(s.outputDir, `${prefix}${i + 1}.mov`);
        const humanIndex = `${i + 1}/${sources.length}`;

        this.emitProgress({
          fileIndex: i,
          total: sources.length,
          fileName,
          outputName: path.basename(outputFile),
          filePercent: 0,
          overallPercent: (i / sources.length) * 100,
          status: `Обработка ${humanIndex}: ${fileName}`
        });

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

          const closeupStart = closeup
            ? wrapCloseupOffset(closeupHead, closeup.duration)
            : 0;
          if (closeup) {
            this.log(
              'info',
              `[${humanIndex}] Крупный план справа: с ${formatDuration(closeupStart)} ` +
                `(таймлайн второго видео)`
            );
          }

          this.currentOutput = outputFile;

          const renderOnce = (encodePlan) => renderVideo({
            source,
            shorts,
            overlay,
            closeup,
            closeupStart,
            split,
            outputFile,
            percent,
            encoder,
            plan: encodePlan,
            hardware,
            frame,
            fit,
            overlayOpacity,
            onCommand: (command) => {
              this.currentCommand = command;
              if (this.cancelled) {
                try {
                  command.kill('SIGKILL');
                } catch (err) {
                  /* процесс мог ещё не стартовать */
                }
              }
            },
            onDebug: (line) => {
              if (this.settings.verbose) this.log('debug', line);
            },
            onProgress: (filePercent) => {
              this.emitProgress({
                fileIndex: i,
                total: sources.length,
                fileName,
                outputName: path.basename(outputFile),
                filePercent,
                overallPercent: ((i + filePercent / 100) / sources.length) * 100,
                status: `Обработка ${humanIndex}: ${fileName} — ${filePercent.toFixed(1)}%`
              });
            }
          });

          try {
            await renderOnce(plan);
          } catch (err) {
            if (this.cancelled) throw err;
            if (err && err.gpuFallback) {
              this.log(
                'warn',
                `[${humanIndex}] Видеокарта не приняла кадр (${shortenFfmpegError(err.message)}), повтор на процессоре`
              );
              safeUnlink(outputFile);
              await renderOnce(cpuPlan);
            } else {
              throw err;
            }
          }

          if (this.cancelled) {
            safeUnlink(outputFile);
            break;
          }

          const size = fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0;
          summary.done += 1;
          summary.results.push({ source: sourceFile, output: outputFile, size });
          if (closeup) closeupHead += source.duration + shorts.duration;
          this.log(
            'success',
            `[${humanIndex}] Готово: ${path.basename(outputFile)} ` +
              `(${(size / 1024 / 1024).toFixed(1)} МБ)`
          );
        } catch (err) {
          if (this.cancelled) {
            safeUnlink(outputFile);
            break;
          }
          summary.failed += 1;
          this.log('error', `[${humanIndex}] Ошибка на файле ${fileName}: ${shortenFfmpegError(err.message)}`);
          safeUnlink(outputFile);
        } finally {
          this.currentCommand = null;
          this.currentOutput = null;
        }

        this.emitProgress({
          fileIndex: i,
          total: sources.length,
          fileName,
          filePercent: 100,
          overallPercent: ((i + 1) / sources.length) * 100,
          status: `Завершено ${i + 1} из ${sources.length}`
        });

        if (i < sources.length - 1 && !this.cancelled) {
          await pauseBetweenFiles(() => this.cancelled);
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
  wrapCloseupOffset,
  planCloseupInputs,
  isVideoFile,
  shortenFfmpegError,
  ENCODE_PACE_SPEED,
  paceGlobalArgs
};
