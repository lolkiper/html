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
const { execFileSync, execFile } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

const VIDEO_EXTENSIONS = [
  '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.mts', '.m2ts', '.ts', '.3gp', '.ogv'
];

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_LAYOUT = 'stereo';

/** Быстрее bicubic, для Shorts разницы почти нет. */
const SCALE_FLAGS = 'fast_bilinear';
/** Запасной FPS, если у исходника нет корректной частоты. */
const MAX_OUTPUT_FPS = 60;
const MAX_KEEP_FPS = 120;
/**
 * Мягкий потолок чтения входа. На GPU нужен всегда: без него новый ffmpeg
 * в первые кадры забивает NVENC очередью, и Video Encode скачет до 100%
 * на стыке файлов. Скорость выше типичного NVENC (4–8×), поэтому сам
 * рендер почти не замедляется — режется только стартовый выброс.
 */
const ENCODE_PACE_SPEED = 3;
const GPU_PACE_BALANCED = 10;
const GPU_PACE_HIGH = 16;
/**
 * Один файл = один ffmpeg. В режимах low/balanced/high файлы идут строго по
 * одному; в режиме max — до MAX_PARALLEL_JOBS одновременно на вкладку.
 */
const MAX_EXPORT_JOBS = 1;
const MAX_PARALLEL_JOBS = 4;
/** Сколько файлов одной папки читается ffprobe одновременно при подготовке очереди. */
const PROBE_CONCURRENCY = 4;
const CPU_HANDOFF_MS = 80;
const GPU_HANDOFF_MS = 380;
const INTER_FILE_DELAY_MS = GPU_HANDOFF_MS;
const FFMPEG_EXIT_WAIT_MS = 8000;
const PROGRESS_INTERVAL_MS = 500;
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

function isMaxSpeed(resourceUsage) {
  return resourceUsage === 'max';
}

function encodePaceSpeed(plan) {
  const usage = (plan && plan.resourceUsage) || 'low';
  if (plan && plan.usingGpu) {
    if (usage === 'low' || usage === 'cpu') return ENCODE_PACE_SPEED;
    if (usage === 'high' || usage === 'gpu') return GPU_PACE_HIGH;
    return GPU_PACE_BALANCED;
  }
  return ENCODE_PACE_SPEED;
}

function paceGlobalArgs(plan) {
  return [
    '-readrate', String(encodePaceSpeed(plan)),
    '-readrate_initial_burst', '0'
  ];
}

function handoffDelayMs(plan) {
  if (plan && isMaxSpeed(plan.resourceUsage)) return 0;
  return plan && plan.usingGpu ? GPU_HANDOFF_MS : CPU_HANDOFF_MS;
}

async function waitForFfmpegExit(command, timeoutMs = FFMPEG_EXIT_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const proc = command && command.ffmpegProc;
    if (!proc) return;
    if (proc.killed || proc.exitCode != null || proc.signalCode != null) return;
    await sleep(40);
  }
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
  auto: {
    label: 'Авто — HEVC на видеокарте, иначе H.264'
  },
  h264: {
    label: 'H.264',
    pixelFormat: 'yuv420p',
    audioBitrate: '96k',
    extraOptions: ['-movflags', '+faststart']
  },
  h265: {
    label: 'H.265 / HEVC',
    pixelFormat: 'yuv420p',
    audioBitrate: '96k',
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

const EXPORT_MODES = {
  auto: { label: 'Авто — баланс качества, скорости и размера' },
  fast: { label: 'Быстрый — hardware preset, нормальное качество' },
  balanced: { label: 'Баланс — качество, размер и скорость' },
  quality: { label: 'Макс. качество — без медленных CPU-пресетов' }
};

const RESOURCE_MODES = {
  max: { label: 'Максимум скорости — без ограничений, несколько файлов сразу' },
  high: { label: 'Высокая — быстрее фильтры, всё ещё 1 encode' },
  balanced: { label: 'Баланс — один encode, умеренные потоки' },
  low: { label: 'Низкая — минимум нагрузки, стабильность' }
};

/** Сколько файлов одной вкладки кодируется одновременно. */
const PARALLEL_MODES = {
  auto: { label: 'Авто — по числу ядер (в режиме «Максимум»)' },
  1: { label: '1 файл за раз' },
  2: { label: '2 файла одновременно' },
  3: { label: '3 файла одновременно' },
  4: { label: '4 файла одновременно' }
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
  encoder: 'auto',
  exportMode: 'auto',
  resourceUsage: 'max',
  parallelJobs: 'auto',
  accel: 'hybrid',
  overlayOpacity: 100,
  outputPrefix: 'es',
  frame: 'square1080',
  fit: 'cover',
  split: SPLIT_DEFAULTS
};

/** Старые подписи нагрузки: оставлены как синонимы resourceUsage. */
const ACCEL_MODES = {
  hybrid: { label: RESOURCE_MODES.balanced.label },
  cpu: { label: 'Только процессор (если карта недоступна)' },
  gpu: { label: RESOURCE_MODES.high.label }
};

const GPU_H264 = [
  { id: 'h264_nvenc', vendor: 'NVIDIA NVENC', extras: [['-gpu', '0'], ['-gpu', '1'], []] },
  { id: 'h264_amf', vendor: 'AMD AMF', extras: [[]] },
  { id: 'h264_qsv', vendor: 'Intel Quick Sync', extras: [[]] },
  { id: 'h264_videotoolbox', vendor: 'Apple VideoToolbox', extras: [[]] }
];

const GPU_H265 = [
  { id: 'hevc_nvenc', vendor: 'NVIDIA NVENC', extras: [['-gpu', '0'], ['-gpu', '1'], []] },
  { id: 'hevc_amf', vendor: 'AMD AMF', extras: [[]] },
  { id: 'hevc_qsv', vendor: 'Intel Quick Sync', extras: [[]] },
  { id: 'hevc_videotoolbox', vendor: 'Apple VideoToolbox', extras: [[]] }
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

const IS_WINDOWS = process.platform === 'win32';

function binaryFileName(base) {
  return IS_WINDOWS ? `${base}.exe` : base;
}

/**
 * Все места, где в установленном приложении может лежать ffmpeg/ffprobe:
 * распакованный asar, resources, node_modules и папка vendor.
 */
function binaryCandidates(candidate, base) {
  const list = [];
  const push = (file) => {
    if (file && !list.includes(file)) list.push(file);
  };
  push(unpackedPath(candidate));
  push(candidate);

  const name = binaryFileName(base);
  const pkg = `${base}-static`;
  const arch = process.arch === 'ia32' ? 'ia32' : process.arch === 'arm64' ? 'arm64' : 'x64';
  const roots = [];
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked'));
    roots.push(process.resourcesPath);
  }
  roots.push(__dirname);
  roots.forEach((root) => {
    push(path.join(root, 'node_modules', pkg, name));
    push(path.join(root, 'node_modules', pkg, 'bin', process.platform, arch, name));
    push(path.join(root, 'vendor', 'ffmpeg', name));
  });
  return list;
}

function resolveBinary(candidate, base) {
  for (const file of binaryCandidates(candidate, base)) {
    try {
      if (fs.existsSync(file)) return file;
    } catch (err) {
      // недоступный путь — пробуем следующий
    }
  }
  return binaryFileName(base);
}

const ffmpegStatic = optionalRequire('ffmpeg-static');
const ffprobeStatic = optionalRequire('ffprobe-static');

const ffmpegPath = resolveBinary(ffmpegStatic, 'ffmpeg');
const ffprobePath = resolveBinary(ffprobeStatic && ffprobeStatic.path, 'ffprobe');

/** ffprobe в сборке может отсутствовать — тогда читаем файлы через ffmpeg. */
let ffprobeWorks = null;

function ffprobeAvailable() {
  if (ffprobeWorks === null) {
    try {
      execFileSync(ffprobePath, ['-version'], { stdio: 'ignore', timeout: 15000 });
      ffprobeWorks = true;
    } catch (err) {
      ffprobeWorks = false;
    }
  }
  return ffprobeWorks;
}

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
    this.ffmpegStderr = cause && cause.ffmpegStderr;
    this.ffmpegCommand = cause && cause.ffmpegCommand;
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

function ffmpegCliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      args,
      { encoding: 'utf8', timeout: options.timeout || 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.combined = `${stdout || ''}\n${stderr || ''}`.trim();
          reject(err);
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

async function probeEncoderAsync(id, extra) {
  const tmp = path.join(os.tmpdir(), `shorts-gpu-probe-${process.pid}-${id}.mp4`);
  try {
    await ffmpegCliAsync(
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=15:d=0.4',
        '-pix_fmt', 'yuv420p',
        '-c:v', id, ...(extra || []),
        '-frames:v', '4',
        tmp
      ],
      { timeout: 12000 }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: shortenFfmpegError(err.combined || err.message) };
  } finally {
    safeUnlink(tmp);
  }
}

async function pickGpuEncoderAsync(candidates, compiledIds) {
  let lastError = null;
  for (const candidate of candidates) {
    if (!compiledIds.has(candidate.id)) continue;
    const extras = candidate.extras && candidate.extras.length ? candidate.extras : [[]];
    for (const extra of extras) {
      const probe = await probeEncoderAsync(candidate.id, extra);
      if (probe.ok) {
        return { encoder: { id: candidate.id, vendor: candidate.vendor, extra }, error: null };
      }
      lastError = `${candidate.id}: ${probe.error}`;
    }
  }
  return { encoder: null, error: lastError };
}

let hardwareCache = null;
let hardwarePromise = null;

function buildHardwareInfo({ encoderText, accelText, h264, h265 }) {
  const ids = parseEncoderIds(encoderText);
  const accels = parseHwaccels(accelText);
  const wanted = [...GPU_H264, ...GPU_H265].map((item) => item.id);
  const preferredAccel = {
    win32: ['d3d11va', 'cuda', 'dxva2', 'qsv'],
    linux: ['vaapi', 'cuda', 'vdpau'],
    darwin: ['videotoolbox']
  }[process.platform] || [];
  return {
    h264: h264.encoder,
    h265: h265.encoder,
    hwaccel: preferredAccel.find((name) => accels.includes(name)) || null,
    accels,
    compiledGpu: wanted.filter((id) => ids.has(id)),
    probeError: (h264.encoder ? null : h264.error) || (h265.encoder ? null : h265.error) || null,
    cores: Math.max(1, (os.cpus() || []).length || 4)
  };
}

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
  hardwareCache = buildHardwareInfo({
    encoderText,
    accelText,
    h264: pickGpuEncoder(GPU_H264, ids),
    h265: pickGpuEncoder(GPU_H265, ids)
  });
  return hardwareCache;
}

/**
 * То же, что detectHardware, но не блокирует процесс: main-процесс Electron
 * при синхронной проверке замораживал окно на несколько секунд. Результат
 * общий для всех вкладок — проверка выполняется один раз.
 */
function detectHardwareAsync() {
  if (hardwareCache) return Promise.resolve(hardwareCache);
  if (hardwarePromise) return hardwarePromise;
  hardwarePromise = (async () => {
    const [encoderText, accelText] = await Promise.all([
      ffmpegCliAsync(['-hide_banner', '-encoders']).catch((err) => err.combined || ''),
      ffmpegCliAsync(['-hide_banner', '-hwaccels']).catch((err) => err.combined || '')
    ]);
    const ids = parseEncoderIds(encoderText);
    const h264 = await pickGpuEncoderAsync(GPU_H264, ids);
    const h265 = await pickGpuEncoderAsync(GPU_H265, ids);
    if (!hardwareCache) hardwareCache = buildHardwareInfo({ encoderText, accelText, h264, h265 });
    return hardwareCache;
  })().catch((err) => {
    hardwarePromise = null;
    throw err;
  });
  return hardwarePromise;
}

function threadBudget(resourceUsage, coreCount, usingGpu, jobs = 1) {
  const cores = Math.max(1, coreCount || (os.cpus() || []).length || 4);
  if (isMaxSpeed(resourceUsage)) {
    // Ядра делятся между параллельными файлами вкладки, а не отдаются каждому целиком.
    const share = Math.max(1, Math.floor(cores / Math.max(1, jobs)));
    if (usingGpu) {
      const n = clamp(Math.floor(share / 2), 2, 4);
      return { cores, filterThreads: n, encodeThreads: n };
    }
    return { cores, filterThreads: clamp(Math.floor(share / 2), 1, 4), encodeThreads: clamp(share, 2, 16) };
  }
  if (resourceUsage === 'low' || resourceUsage === 'cpu') {
    return { cores, filterThreads: 1, encodeThreads: resourceUsage === 'cpu' ? Math.max(1, Math.min(4, Math.ceil(cores / 3))) : 1 };
  }
  if (resourceUsage === 'high' || resourceUsage === 'gpu') {
    const n = Math.max(2, Math.min(usingGpu ? 4 : 6, Math.ceil(cores / 2)));
    return { cores, filterThreads: Math.min(4, n), encodeThreads: n };
  }
  const n = Math.max(2, Math.min(usingGpu ? 2 : 4, Math.floor(cores / 3) || 2));
  return { cores, filterThreads: Math.min(2, n), encodeThreads: n };
}

function mapAccelToResource(accel) {
  if (accel === 'gpu' || accel === 'high') return 'high';
  if (accel === 'cpu' || accel === 'low') return 'low';
  return 'balanced';
}

function normalizeExportMode(value) {
  if (value === 'max' || value === 'max_quality') return 'quality';
  return EXPORT_MODES[value] ? value : DEFAULTS.exportMode;
}

function normalizeResourceUsage(value) {
  if (RESOURCE_MODES[value]) return value;
  return mapAccelToResource(value);
}

/**
 * Число параллельных файлов на вкладку. Явное число пользователя соблюдается
 * всегда; «Авто» даёт параллельность только в режиме «Максимум скорости».
 */
function resolveParallelJobs(value, { resourceUsage, usingGpu, encoderKey, cores } = {}) {
  const explicit = Number(value);
  if (Number.isInteger(explicit) && explicit >= 1) return Math.min(MAX_PARALLEL_JOBS, explicit);
  if (!isMaxSpeed(resourceUsage)) return MAX_EXPORT_JOBS;
  const n = Math.max(1, Number(cores) || (os.cpus() || []).length || 4);
  if (encoderKey === 'prores') return n >= 12 ? 2 : 1;
  if (usingGpu) return n >= 16 ? 3 : n >= 6 ? 2 : 1;
  return n >= 12 ? 3 : n >= 6 ? 2 : 1;
}

function normalizeExportOptions(accelOrOptions) {
  if (accelOrOptions && typeof accelOrOptions === 'object' && !Array.isArray(accelOrOptions)) {
    const accel = accelOrOptions.accel;
    return {
      exportMode: normalizeExportMode(accelOrOptions.exportMode),
      resourceUsage: normalizeResourceUsage(accelOrOptions.resourceUsage || accel),
      forceCpu: Boolean(accelOrOptions.forceCpu) || accel === 'cpu',
      target: accelOrOptions.target || null,
      jobs: Math.max(1, Number(accelOrOptions.jobs) || 1)
    };
  }
  const accel = String(accelOrOptions || DEFAULTS.accel);
  return {
    exportMode: DEFAULTS.exportMode,
    resourceUsage: mapAccelToResource(accel),
    forceCpu: accel === 'cpu',
    target: null,
    jobs: 1
  };
}

/** Авто никогда не берёт software HEVC — libx265 легко кладёт CPU в 100%. */
function resolveEncoderKey(requested, hardware) {
  if (requested === 'prores' || requested === 'h264' || requested === 'h265') return requested;
  if (hardware && hardware.h265) return 'h265';
  return 'h264';
}

function pixelCount(width, height) {
  return Math.max(1, Number(width) || 1080) * Math.max(1, Number(height) || 1080);
}

function perceptualCq(encoderKey, exportMode, width, height) {
  const mode = exportMode === 'auto' ? 'balanced' : exportMode;
  const base = encoderKey === 'h265'
    ? { fast: 30, balanced: 26, quality: 22 }[mode] || 26
    : { fast: 26, balanced: 23, quality: 20 }[mode] || 23;
  const pixels = pixelCount(width, height);
  const p1080 = 1920 * 1080;
  let adj = 0;
  if (pixels < p1080 * 0.55) adj += 1;
  else if (pixels > p1080 * 1.8) adj -= 1;
  return clamp(base + adj, 16, 34);
}

function audioBitrateForMode(exportMode) {
  if (exportMode === 'fast') return '80k';
  if (exportMode === 'quality') return '128k';
  return '96k';
}

function softwareVideoOptions(encoderKey, exportMode, threads, cq) {
  const mode = exportMode === 'auto' ? 'balanced' : exportMode;
  if (encoderKey === 'h265') {
    const preset = mode === 'quality' ? 'fast' : 'veryfast';
    return [
      '-c:v', 'libx265', '-preset', preset, '-crf', String(cq), '-tag:v', 'hvc1',
      '-x265-params', 'log-level=error',
      '-threads', String(threads)
    ];
  }
  const preset = mode === 'quality' ? 'fast' : 'veryfast';
  const x264 = mode === 'quality'
    ? 'ref=2:bframes=2:rc-lookahead=20:scenecut=40'
    : 'ref=1:bframes=0:rc-lookahead=10:sync-lookahead=0:scenecut=0';
  return [
    '-c:v', 'libx264', '-preset', preset, '-crf', String(cq), '-profile:v', 'high',
    '-tag:v', 'avc1',
    '-x264-params', x264,
    '-threads', String(threads)
  ];
}

function gpuIndexFromExtra(extra) {
  const list = Array.isArray(extra) ? extra : [];
  const idx = list.indexOf('-gpu');
  if (idx >= 0 && list[idx + 1] != null) return list[idx + 1];
  return null;
}

function hardwareVideoOptions(gpu, encoderKey, exportMode, cq) {
  const mode = exportMode === 'auto' ? 'balanced' : exportMode;
  const id = gpu && gpu.id;
  const gpuIndex = gpuIndexFromExtra(gpu && gpu.extra);
  const hevcTag = encoderKey === 'h265' ? ['-tag:v', 'hvc1'] : [];

  if (id === 'h264_nvenc' || id === 'hevc_nvenc') {
    const preset = mode === 'fast' ? 'p1' : mode === 'quality' ? 'p5' : 'p4';
    const opts = [];
    if (gpuIndex != null) opts.push('-gpu', String(gpuIndex));
    opts.push('-c:v', id, '-preset', preset, '-tune', mode === 'fast' ? 'll' : 'hq');
    opts.push('-rc', 'vbr', '-cq', String(cq), '-b:v', '0');
    if (mode === 'fast') opts.push('-rc-lookahead', '0', '-bf', '0');
    else if (mode === 'quality') opts.push('-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '16', '-bf', '2');
    else opts.push('-spatial-aq', '1', '-rc-lookahead', '8', '-bf', '2');
    opts.push('-async_depth', '2');
    return withPlayerCompatibleTags(encoderKey, opts.concat(hevcTag));
  }

  if (id === 'h264_amf' || id === 'hevc_amf') {
    const quality = mode === 'fast' ? 'speed' : mode === 'quality' ? 'quality' : 'balanced';
    return withPlayerCompatibleTags(encoderKey, [
      '-c:v', id, '-quality', quality, '-rc', 'cqp', '-qp_i', String(cq), '-qp_p', String(cq + 2),
      ...hevcTag
    ]);
  }

  if (id === 'h264_qsv' || id === 'hevc_qsv') {
    const preset = mode === 'fast' ? 'veryfast' : mode === 'quality' ? 'medium' : 'fast';
    return withPlayerCompatibleTags(encoderKey, [
      '-c:v', id, '-preset', preset, '-global_quality', String(cq), ...hevcTag
    ]);
  }

  if (id === 'h264_videotoolbox' || id === 'hevc_videotoolbox') {
    const q = mode === 'fast' ? 55 : mode === 'quality' ? 72 : 65;
    const opts = ['-c:v', id, '-q:v', String(q)];
    if (encoderKey === 'h264') opts.push('-profile:v', 'high');
    return withPlayerCompatibleTags(encoderKey, opts.concat(hevcTag));
  }

  return withPlayerCompatibleTags(encoderKey, ['-c:v', id, ...(gpu.extra || []), ...hevcTag]);
}

function estimateOutputBytes({ width, height, fps, duration, encoderKey, exportMode }) {
  const cq = perceptualCq(encoderKey, exportMode, width, height);
  const bpp = encoderKey === 'h265'
    ? 0.042 + (28 - cq) * 0.0035
    : 0.065 + (26 - cq) * 0.005;
  const video = pixelCount(width, height) * Math.max(1, fps || 30) * Math.max(0.1, duration || 1) * bpp / 8;
  const audioBps = (exportMode === 'quality' ? 16000 : 12000) * Math.max(0.1, duration || 1);
  return Math.max(MIN_OUTPUT_BYTES, Math.round(video + audioBps));
}

function describeEncodeWork({ overlay, closeup, source, shorts, target }) {
  const scale = Boolean(
    source && target && (source.width !== target.width || source.height !== target.height)
  ) || Boolean(shorts && target && (shorts.width !== target.width || shorts.height !== target.height));
  const fpsConvert = Boolean(source && target && needsFpsConvert(target.fps, source.fps))
    || Boolean(shorts && target && needsFpsConvert(target.fps, shorts.fps));
  return {
    mustEncodeVideo: true,
    streamCopy: false,
    scale,
    fpsConvert,
    overlay: Boolean(overlay),
    split: Boolean(closeup),
    keepSourceFps: Boolean(source && target && !needsFpsConvert(target.fps, source.fps)),
    reason: 'вставка Shorts в середину всегда собирает новый видеопоток одним ffmpeg'
  };
}

/**
 * Hardware encoder если доступен, CQ/CRF по разрешению, CPU только на фильтры.
 */
function resolveEncodePlan(encoderKey, accelOrOptions, hardware) {
  const options = normalizeExportOptions(accelOrOptions);
  const hw = hardware || {};
  const family = resolveEncoderKey(encoderKey, hw);
  const cpu = ENCODERS[family] || ENCODERS.h264;
  const wantGpu = !options.forceCpu && family !== 'prores';
  const gpu = family === 'h265' ? hw.h265 : family === 'h264' ? hw.h264 : null;
  const usingGpu = Boolean(wantGpu && gpu);
  const threads = threadBudget(options.resourceUsage, hw.cores, usingGpu, options.jobs);
  const width = options.target && options.target.width;
  const height = options.target && options.target.height;
  const cq = perceptualCq(family, options.exportMode, width, height);
  const audioOptions = family === 'prores'
    ? ENCODERS.prores.audioOptions
    : ['-c:a', 'aac', '-b:a', audioBitrateForMode(options.exportMode)];
  const extraOptions = (cpu.extraOptions && cpu.extraOptions.length) ? cpu.extraOptions : ['-movflags', '+faststart'];
  const pace = family !== 'prores' && !isMaxSpeed(options.resourceUsage) &&
    (options.resourceUsage === 'low' || usingGpu);

  if (family === 'prores') {
    return {
      encoderKey: family,
      exportMode: options.exportMode,
      resourceUsage: options.resourceUsage,
      label: `${cpu.label} — CPU`,
      encoderName: 'prores_ks',
      pixelFormat: cpu.pixelFormat,
      videoOptions: [...cpu.videoOptions, '-threads', String(threads.encodeThreads)],
      audioOptions,
      extraOptions: cpu.extraOptions || [],
      hwaccel: null,
      usingGpu: false,
      vendor: null,
      threads,
      pace: false,
      cq: null
    };
  }

  if (usingGpu) {
    return {
      encoderKey: family,
      exportMode: options.exportMode,
      resourceUsage: options.resourceUsage,
      label: `${gpu.vendor} ${family === 'h265' ? 'HEVC' : 'H.264'} · ${EXPORT_MODES[options.exportMode].label}`,
      encoderName: gpu.id,
      pixelFormat: 'yuv420p',
      videoOptions: hardwareVideoOptions(gpu, family, options.exportMode, cq),
      audioOptions,
      extraOptions,
      hwaccel: null,
      usingGpu: true,
      vendor: gpu.vendor,
      threads,
      pace,
      cq
    };
  }

  const reason = options.forceCpu
    ? 'выбран процессор'
    : hw.probeError
      ? `видеокарта не приняла тест (${hw.probeError})`
      : 'видеокарта недоступна';
  return {
    encoderKey: family,
    exportMode: options.exportMode,
    resourceUsage: options.resourceUsage,
    label: `${ENCODERS[family].label} ${options.exportMode} · ${reason}, ${threads.encodeThreads} из ${threads.cores} потоков`,
    encoderName: family === 'h265' ? 'libx265' : 'libx264',
    pixelFormat: 'yuv420p',
    videoOptions: withPlayerCompatibleTags(family, softwareVideoOptions(family, options.exportMode, threads.encodeThreads, cq)),
    audioOptions,
    extraOptions,
    hwaccel: null,
    usingGpu: false,
    vendor: null,
    threads,
    pace,
    cq
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

/**
 * У VFR-роликов с телефона r_frame_rate — это тикрейт контейнера (120, 90000),
 * а не частота кадров: по нему итог получал лишние дубли кадров. Когда
 * r_frame_rate заметно выше средней частоты, верим avg_frame_rate.
 */
function streamFrameRate(stream) {
  const real = parseFrameRate(stream.r_frame_rate, NaN);
  const avg = parseFrameRate(stream.avg_frame_rate, NaN);
  if (Number.isFinite(avg) && (!Number.isFinite(real) || real >= avg * 1.9)) return avg;
  return Number.isFinite(real) ? real : 30;
}

function isVariableFrameRate(stream) {
  const real = parseFrameRate(stream.r_frame_rate, NaN);
  const avg = parseFrameRate(stream.avg_frame_rate, NaN);
  return Number.isFinite(real) && Number.isFinite(avg) && Math.abs(real - avg) / avg > 0.02;
}

/** Селектор потока для графа: точный индекс дорожки, которую выбрал probe. */
function videoStreamSpec(inputIndex, media) {
  return media && Number.isInteger(media.videoIndex) ? `${inputIndex}:${media.videoIndex}` : `${inputIndex}:v:0`;
}

function audioStreamSpec(inputIndex, media) {
  return media && Number.isInteger(media.audioIndex) ? `${inputIndex}:${media.audioIndex}` : `${inputIndex}:a:0`;
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

/** Разбор вывода `ffmpeg -i file` — резерв на случай отсутствия ffprobe. */
function parseFfmpegProbe(text) {
  const lines = String(text || '').split(/\r?\n/);
  const videoLine =
    lines.find((line) => /:\s*Video:/.test(line) && !/attached pic/i.test(line)) || '';
  const audioLine = lines.find((line) => /:\s*Audio:/.test(line)) || '';
  const streamIndex = (line) => {
    const match = line.match(/Stream #\d+:(\d+)/);
    return match ? Number(match[1]) : null;
  };
  const durationMatch = String(text || '').match(/Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  const size = videoLine.match(/(\d{2,5})x(\d{2,5})/);
  const fpsMatch = videoLine.match(/([\d.]+)\s+fps/) || videoLine.match(/([\d.]+)\s+tbr/);
  const displayMatrix = String(text || '').match(/rotation of\s*(-?[\d.]+)\s*degrees/i);
  const rotateTag = String(text || '').match(/rotate\s*:\s*(-?[\d.]+)/i);
  let rotation = 0;
  if (displayMatrix) rotation = Number(displayMatrix[1]);
  else if (rotateTag) rotation = Number(rotateTag[1]);
  if (!Number.isFinite(rotation)) rotation = 0;
  const videoCodec = (videoLine.match(/Video:\s*([A-Za-z0-9_]+)/) || [])[1] || null;
  const audioCodec = (audioLine.match(/Audio:\s*([A-Za-z0-9_]+)/) || [])[1] || null;
  const langMatch = audioLine.match(/Stream #\d+:\d+(?:\[[^\]]*\])?\(([A-Za-z]{2,3})\)/);
  return {
    hasVideo: Boolean(videoLine && size),
    hasAudio: Boolean(audioLine),
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    rotation: ((Math.round(rotation) % 360) + 360) % 360,
    duration: Number.isFinite(duration) ? duration : 0,
    fps: fpsMatch ? Number(fpsMatch[1]) : null,
    videoIndex: videoLine ? streamIndex(videoLine) : null,
    audioIndex: audioLine ? streamIndex(audioLine) : null,
    videoCodec,
    audioCodec,
    audioLanguage: langMatch && langMatch[1].toLowerCase() !== 'und' ? langMatch[1].toLowerCase() : null
  };
}

/** `ffmpeg -i` без выхода всегда завершается с кодом 1 — нужен только его stderr. */
function runFfmpegProbe(file) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-i', file],
      { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = `${stderr || ''}${stdout || ''}`;
        if (text.trim()) resolve(text);
        else reject(err || new Error('ffmpeg не вернул информацию о файле'));
      }
    );
  });
}

/** То же, что probeMedia, но без ffprobe — только силами ffmpeg. */
async function probeMediaViaFfmpeg(file) {
  let text = '';
  try {
    text = await runFfmpegProbe(file);
  } catch (err) {
    throw new Error(
      `Не удалось прочитать файл (${path.basename(file)}): ${shortenFfmpegError(err && err.message)}`
    );
  }
  const parsed = parseFfmpegProbe(text);
  if (!parsed.hasVideo) {
    throw new Error(`В файле нет видеодорожки: ${path.basename(file)}`);
  }
  const swapped = parsed.rotation === 90 || parsed.rotation === 270;
  const width = Number(swapped ? parsed.height : parsed.width);
  const height = Number(swapped ? parsed.width : parsed.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
    throw new Error(`Некорректные размеры кадра: ${path.basename(file)}`);
  }
  return {
    file,
    width: Math.floor(width / 2) * 2,
    height: Math.floor(height / 2) * 2,
    rotation: parsed.rotation,
    duration: parsed.duration,
    fps: parsed.fps && parsed.fps > 0 && parsed.fps <= 240 ? Math.round(parsed.fps * 1000) / 1000 : 30,
    hasAudio: parsed.hasAudio,
    videoIndex: parsed.videoIndex,
    audioIndex: parsed.audioIndex,
    videoCodec: parsed.videoCodec || 'unknown',
    codecTag: '',
    audioCodec: parsed.hasAudio ? parsed.audioCodec || 'unknown' : null
  };
}

/**
 * Метаданные файла. Если ffprobe отсутствует или не запускается,
 * файл всё равно читается — через ffmpeg.
 */
async function probeMedia(file) {
  if (!ffprobeAvailable()) return probeMediaViaFfmpeg(file);
  try {
    return await probeMediaWithFfprobe(file);
  } catch (err) {
    const message = String((err && err.message) || '');
    if (/ENOENT|spawn|EACCES|not recognized|не является внутренней/i.test(message)) {
      ffprobeWorks = false;
      return probeMediaViaFfmpeg(file);
    }
    throw err;
  }
}

/** Метаданные файла: размеры (с учётом поворота), длительность, fps, наличие дорожек. */
function probeMediaWithFfprobe(file) {
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
      const audioStream = streams.find(
        (s) => s.codec_type === 'audio' && Number(s.channels) !== 0 && Number(s.sample_rate) !== 0
      ) || streams.find((s) => s.codec_type === 'audio');

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
        fps: streamFrameRate(videoStream),
        vfr: isVariableFrameRate(videoStream),
        hasAudio: Boolean(audioStream),
        videoIndex: Number.isInteger(videoStream.index) ? videoStream.index : null,
        audioIndex: audioStream && Number.isInteger(audioStream.index) ? audioStream.index : null,
        videoDuration: Number(videoStream.duration) || null,
        audioDuration: audioStream ? Number(audioStream.duration) || null : null,
        sampleRate: audioStream ? Number(audioStream.sample_rate) || null : null,
        channels: audioStream ? Number(audioStream.channels) || null : null,
        pixelFormat: videoStream.pix_fmt || null,
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

/** 32 -> "00:32.000", 3725.5 -> "62:05.500" */
function formatClock(seconds) {
  const ms = Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : 0) * 1000);
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${mm}:${ss}.${String(ms % 1000).padStart(3, '0')}`;
}

function hasFreezePercent(settings) {
  return settings.freezePercent != null && settings.freezePercent !== '';
}

/** Момент Overlay в секундах для ролика: процент длины (как у Shorts) или старое абсолютное время. */
function freezeMomentFor(settings, sourceDuration) {
  if (hasFreezePercent(settings)) {
    return (sourceDuration * clamp(Number(settings.freezePercent) || 0, 0, 100)) / 100;
  }
  return Number(settings.freezeAt) || 0;
}

/**
 * Момент и длина Overlay на сетке кадров итогового fps: стоп-кадр держится
 * целое число кадров, а T попадает ровно на кадр. Меньше кадра от начала — 0,
 * меньше кадра до конца — сам конец ролика.
 */
function planFreeze({ at, media, size, sourceDuration, fps }) {
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  const frame = 1 / rate;
  const requested = Number.isFinite(Number(at)) ? Number(at) : 0;
  let snapped = clamp(Math.round(clamp(requested, 0, sourceDuration) * rate) / rate, 0, sourceDuration);
  if (snapped < frame) snapped = 0;
  if (snapped > sourceDuration - frame) snapped = sourceDuration;
  const frames = Math.max(1, Math.round(media.duration * rate));
  return {
    at: snapped,
    requested,
    clamped: requested > sourceDuration,
    frameIndex: Math.round(snapped * rate),
    frames,
    duration: frames / rate,
    media,
    size: clamp(Number(size) || 100, 10, 100)
  };
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
  return clamp(sourceFps, 1, MAX_KEEP_FPS);
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
 * Мягкая граница split-screen. Raised-cosine на полном кадре маски.
 * Маска статична, поэтому geq считается на одном кадре, а дальше этот кадр
 * повторяется через loop — раньше geq пересчитывал каждый пиксель на каждом
 * кадре и был самым медленным местом сплита. Без eval: на ffmpeg 6.1
 * `geq=...:eval=init` ломает разбор опций.
 */
function buildFeatherMaskFilter({ width, height, fps, duration, feather, outputLabel }) {
  const denom = Math.max(1, feather - 1).toFixed(1);
  const ease = `0.5-0.5*cos(PI*clip(X/${denom},0,1))`;
  const maskDuration = Math.max(1, duration + 1).toFixed(3);
  const rate = Number.isFinite(fps) && fps > 0 ? fps : MAX_OUTPUT_FPS;
  return (
    `color=c=black:s=${width}x${height}:r=${rate}:d=1,trim=end_frame=1,` +
      `format=gray,geq=lum='255*(${ease})',` +
      `loop=loop=-1:size=1:start=0,setpts=N/(${rate}*TB),trim=duration=${maskDuration}[${outputLabel}]`
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

function buildCloseupPrepFilters({ closeupIndex, wrap, target, duration, closeupFps, closeupMedia = null, prefix = '', remaining = 0 }) {
  const spec = (index) => videoStreamSpec(index, closeupMedia);
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
        `[${spec(closeupIndex)}]trim=duration=${tailDur},setpts=PTS-STARTPTS[${tail}]`,
        `[${spec(closeupIndex + 1)}]trim=duration=${loopDur},setpts=PTS-STARTPTS[${loop}]`,
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
    prep: `[${spec(closeupIndex)}]trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,${fps}setsar=1`
  };
}

/**
 * Делит кадр на две половины: слева смонтированный ролик, справа второе видео.
 *
 * Каждая половина заполняется независимо (cover), поэтому вертикальный 9:16
 * исходник сохраняет полный рост в колонке 540×1080, а не обрезается сверху
 * и снизу до квадрата. Правая половина по умолчанию увеличена в 1.8 раза.
 */
/**
 * Вставляет стоп-кадр длиной D в поток, который уже ужат до «живого» времени.
 * at — секунда этого потока, на которой кадр замирает.
 */
function holdStreamFilters(inputLabel, outputLabel, { at, duration, active, fps, label }) {
  const D = Number(duration).toFixed(6);
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  if (!(at > 1 / rate)) {
    return [`[${inputLabel}]fps=${rate},tpad=start_mode=clone:start_duration=${D}[${outputLabel}]`];
  }
  if (at >= active - 1 / rate) {
    return [`[${inputLabel}]fps=${rate},tpad=stop_mode=clone:stop_duration=${D}[${outputLabel}]`];
  }
  // Пауза держит кадр момента T, тот же, что замирает у основного видео,
  // а не предыдущий. После паузы хвост начинается с этого же кадра.
  const A = Number(at).toFixed(6);
  const frame = (1 / rate).toFixed(6);
  const clone = Math.max(0, Number(duration) - 1 / rate).toFixed(6);
  return [
    `[${inputLabel}]split=3[${label('hs')}][${label('ps')}][${label('ts')}]`,
    `[${label('hs')}]trim=duration=${A},setpts=PTS-STARTPTS[${label('hh')}]`,
    `[${label('ps')}]trim=start=${A}:duration=${frame},setpts=PTS-STARTPTS,fps=${rate},tpad=stop_mode=clone:stop_duration=${clone}[${label('pp')}]`,
    `[${label('ts')}]trim=start=${A},setpts=PTS-STARTPTS[${label('tt')}]`,
    `[${label('hh')}][${label('pp')}][${label('tt')}]concat=n=3:v=1:a=0[${outputLabel}]`
  ];
}

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
  closeupRemaining = 0,
  freezeHold = null
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
  const activeDuration = freezeHold ? Math.max(1 / target.fps, duration - freezeHold.duration) : duration;
  const closeupPrep = buildCloseupPrepFilters({
    closeupIndex,
    wrap: Boolean(closeupWrap),
    target,
    duration: activeDuration,
    closeupFps: closeup.fps,
    closeupMedia: closeup,
    prefix,
    remaining: closeupRemaining
  });
  filters.push(...closeupPrep.filters);
  let rightPrep = closeupPrep.prep;
  if (freezeHold) {
    const ready = L('cuReady');
    filters.push(`${closeupPrep.prep}[${ready}]`);
    filters.push(...holdStreamFilters(ready, L('cuHeld'), {
      at: freezeHold.at,
      duration: freezeHold.duration,
      active: activeDuration,
      fps: target.fps,
      label: (name) => L(`cu${name}`)
    }));
    rightPrep = `[${L('cuHeld')}]`;
  }

  const rightChain = rightPrep.endsWith(']') ? rightPrep : `${rightPrep},`;
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
        rightChain,
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
      rightChain,
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
 * Куски исходника между точками вставки (Shorts и/или Overlay). Каждый кусок —
 * свой вход с -ss/-t. Overlay не режет таймлайн: он цепляется к куску,
 * который начинается в момент T (стоп-кадр = первый кадр куска), а если T
 * совпадает с концом ролика — к хвосту предыдущего куска.
 */
function planInsertSegments({ source, shorts, splitAt, freeze, fps, inputs, inputBase }) {
  const frame = 1 / (Number(fps) > 0 ? Number(fps) : 30);
  const end = source.duration;
  const cuts = [];
  if (shorts) cuts.push(splitAt);
  let freezeAt = freeze ? clamp(Number(freeze.at) || 0, 0, end) : null;
  if (freeze && shorts && Math.abs(freezeAt - splitAt) < frame) freezeAt = splitAt;
  if (freeze && freezeAt > 0 && freezeAt < end && !cuts.includes(freezeAt)) cuts.push(freezeAt);
  cuts.sort((a, b) => a - b);

  const bounds = [0, ...cuts, end];
  const segments = [];
  let freezeInput = -1;
  if (freeze) {
    freezeInput = inputBase + inputs.length;
    inputs.push({ file: freeze.media.file, options: segmentInputOptions(0, freeze.duration) });
  }
  let shortsInput = -1;
  if (shorts) {
    shortsInput = inputBase + inputs.length;
    inputs.push({ file: shorts.file, options: segmentInputOptions(0, shorts.duration) });
  }

  const freezeInfo = (mode, offset) => ({
    mode,
    offset,
    inputIndex: freezeInput,
    media: freeze.media,
    duration: freeze.duration,
    size: freeze.size
  });

  for (let i = 0; i < bounds.length - 1; i += 1) {
    const start = bounds[i];
    const stop = bounds[i + 1];
    const length = stop - start;
    if (length > 1e-6) {
      const index = inputBase + inputs.length;
      inputs.push({ file: source.file, options: segmentInputOptions(start, length) });
      const piece = {
        videoInput: index,
        media: source,
        audioSource: source,
        audioInput: index,
        duration: length,
        fps: source.fps,
        width: source.width,
        height: source.height
      };
      if (freeze && Math.abs(start - freezeAt) < 1e-6) piece.freeze = freezeInfo('start', 0);
      else if (freeze && freezeAt >= end && i === bounds.length - 2) piece.freeze = freezeInfo('stop', length);
      segments.push(piece);
    }
    if (shorts && Math.abs(stop - splitAt) < 1e-6 && stop < end) {
      segments.push({
        videoInput: shortsInput,
        media: shorts,
        audioSource: shorts,
        audioInput: shortsInput,
        duration: shorts.duration,
        fps: shorts.fps,
        width: shorts.width,
        height: shorts.height
      });
    }
  }
  if (freeze && !segments.some((segment) => segment.freeze)) {
    throw new Error('Overlay: не удалось привязать момент вставки к ролику');
  }
  return segments;
}

/**
 * Стоп-кадр + overlay поверх него. Главное видео держит кадр момента T ровно
 * D секунд (tpad clone), overlay рисуется выше по Z-порядку по центру кадра.
 * Звук идёт строго последовательно через concat: главный звук на паузе,
 * пока играет overlay, без amix и без наложения.
 */
const FREEZE_BG_BLUR = 'gblur=sigma=4';

/**
 * Размывает только окно [at, at+duration) потока. До и после кадр остаётся резким.
 * Один вход нельзя читать дважды, поэтому при нескольких кусках он делится через split.
 */
function blurHoldFilters(inputLabel, outputLabel, { at, duration, total, label }) {
  const start = Math.max(0, Number(at) || 0);
  const end = start + Number(duration);
  const length = Number(total);
  const cuts = [];
  if (start > 0.001) cuts.push({ from: 0, to: start, blur: false });
  cuts.push({ from: start, to: Math.min(end, length), blur: true });
  if (length - end > 0.001) cuts.push({ from: end, to: length, blur: false });
  if (cuts.length === 1) {
    return [`[${inputLabel}]${FREEZE_BG_BLUR}[${outputLabel}]`];
  }
  const pads = cuts.map((_, i) => `[${label(`s${i}`)}]`);
  const filters = [`[${inputLabel}]split=${cuts.length}${pads.join('')}`];
  const outs = [];
  cuts.forEach((cut, i) => {
    const out = label(`c${i}`);
    outs.push(`[${out}]`);
    const blur = cut.blur ? `,${FREEZE_BG_BLUR}` : '';
    filters.push(
      `${pads[i]}trim=start=${cut.from.toFixed(6)}:end=${cut.to.toFixed(6)},setpts=PTS-STARTPTS${blur}[${out}]`
    );
  });
  filters.push(`${outs.join('')}concat=n=${cuts.length}:v=1:a=0[${outputLabel}]`);
  return filters;
}

function buildFreezeFilters({ segment, montage, videoIn, audioIn, videoOut, audioOut, label, drawOverlay = true }) {
  const info = segment.freeze;
  const D = info.duration.toFixed(6);
  const H = segment.duration.toFixed(6);
  const size = clamp(Number(info.size) || 100, 10, 100) / 100;
  const boxW = evenRound(montage.width * size);
  const boxH = evenRound(montage.height * size);
  const filters = [];

  // Кусок сначала добивается до точной длины H (если видеопоток в файле
  // короче контейнера), потом стоп-кадр держится ровно D. tpad считает кадры
  // по частоте канала, а setpts её сбрасывает — поэтому впереди fps.
  const pad = info.mode === 'start' ? `tpad=start_mode=clone:start_duration=${D}` : `tpad=stop_mode=clone:stop_duration=${D}`;
  const hold = `fps=${montage.fps},tpad=stop_mode=clone:stop_duration=${H},trim=duration=${H},${pad}`;
  filters.push(`[${videoIn}]${hold}[${label('fzbg')}]`);

  const shift = info.mode === 'start' ? 'PTS-STARTPTS' : `PTS-STARTPTS+${H}/TB`;
  if (drawOverlay) {
    filters.push(
      `[${videoStreamSpec(info.inputIndex, info.media)}]${filterChain(
        `trim=duration=${D}`,
        'setpts=PTS-STARTPTS',
        info.media.vfr || needsFpsConvert(montage.fps, info.media.fps) ? `fps=${montage.fps}` : '',
        `scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=${SCALE_FLAGS}`,
        'setsar=1',
        `tpad=stop_mode=clone:stop_duration=${D}`,
        `trim=duration=${D}`,
        `setpts=${shift}`
      )}[${label('fzfg')}]`
    );
    const held = info.mode === 'start' ? 0 : segment.duration;
    filters.push(...blurHoldFilters(label('fzbg'), label('fzblur'), {
      at: held,
      duration: info.duration,
      total: segment.duration + info.duration,
      label: (name) => label(`bl${name}`)
    }));
    filters.push(
      `[${label('fzblur')}][${label('fzfg')}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:format=auto,` +
        `setsar=1,format=${montage.pixelFormat}[${videoOut}]`
    );
  } else {
    // Картинка overlay рисуется позже, поверх уже собранного split-screen.
    filters.push(`[${label('fzbg')}]format=${montage.pixelFormat}[${videoOut}]`);
  }

  filters.push(`[${audioIn}]apad=whole_dur=${H},atrim=duration=${H},asetpts=PTS-STARTPTS[${label('fzma')}]`);
  if (info.media.hasAudio) {
    filters.push(
      `[${audioStreamSpec(info.inputIndex, info.media)}]atrim=duration=${D},asetpts=PTS-STARTPTS,` +
        `aresample=${AUDIO_SAMPLE_RATE}:first_pts=0,${AUDIO_FORMAT_FILTER},` +
        `apad=whole_dur=${D},atrim=duration=${D},asetpts=PTS-STARTPTS[${label('fzoa')}]`
    );
  } else {
    filters.push(silentSegmentFilter(label('fzoa'), info.duration));
  }
  const order = info.mode === 'start'
    ? `[${label('fzoa')}][${label('fzma')}]`
    : `[${label('fzma')}][${label('fzoa')}]`;
  filters.push(`${order}concat=n=2:v=0:a=1[${audioOut}]`);
  return filters;
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
  freeze = null,
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
  applyPace = false
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

  let segments;
  if (shorts && !freeze) {
    const headIndex = inputBase + inputs.length;
    inputs.push({ file: source.file, options: segmentInputOptions(0, headDuration) });
    const tailIndex = inputBase + inputs.length;
    inputs.push({ file: source.file, options: segmentInputOptions(splitAt, tailDuration) });
    const shortsIndex = inputBase + inputs.length;
    inputs.push({ file: shorts.file, options: segmentInputOptions(0, shorts.duration) });
    segments = [
      { videoInput: headIndex, media: source, audioSource: source, audioInput: headIndex, duration: headDuration, fps: source.fps, width: source.width, height: source.height },
      { videoInput: shortsIndex, media: shorts, audioSource: shorts, audioInput: shortsIndex, duration: shorts.duration, fps: shorts.fps, width: shorts.width, height: shorts.height },
      { videoInput: tailIndex, media: source, audioSource: source, audioInput: tailIndex, duration: tailDuration, fps: source.fps, width: source.width, height: source.height }
    ];
  } else {
    segments = planInsertSegments({ source, shorts, splitAt, freeze, fps: montage.fps, inputs, inputBase });
  }

  let outputCursor = 0;
  let freezeWindow = null;
  segments.forEach((segment) => {
    if (segment.freeze) {
      const at = outputCursor + (segment.freeze.mode === 'stop' ? segment.duration : 0);
      segment.freeze.outputAt = at;
      freezeWindow = segment.freeze;
    }
    outputCursor += segment.duration + (segment.freeze ? segment.freeze.duration : 0);
  });

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
    const closeupNeeded = freezeWindow ? Math.max(0.05, duration - freezeWindow.duration) : duration;
    const planned = planCloseupInputs(closeup, closeupStart, closeupNeeded);
    closeupIndex = inputBase + inputs.length;
    closeupWrap = planned.wrap;
    closeupRemaining = planned.remaining;
    planned.inputs.forEach((input) => inputs.push({ ...input, pace: false }));
  }

  const concatLabels = [];
  segments.forEach((segment, i) => {
    const videoLabel = L(`v${i}`);
    const audioLabel = L(`a${i}`);
    const rawVideo = segment.freeze ? L(`v${i}raw`) : videoLabel;
    const rawAudio = segment.freeze ? L(`a${i}raw`) : audioLabel;

    // У VFR длительность последнего кадра куска теряется, и -vsync cfr
    // подтягивает следующий кусок на кадр раньше звука: такой кусок всегда
    // ставится на сетку итогового fps.
    filters.push(videoSegmentFilter(
      videoStreamSpec(segment.videoInput, segment.media),
      rawVideo,
      montage,
      segment.media && segment.media.vfr ? NaN : segment.fps,
      { width: segment.width, height: segment.height },
      segment.duration
    ));

    // Сегмент без звука заменяется тишиной, иначе concat не соберёт дорожку.
    if (segment.audioSource.hasAudio) {
      filters.push(audioSegmentFilter(audioStreamSpec(segment.audioInput, segment.audioSource), rawAudio, segment.duration));
    } else {
      filters.push(silentSegmentFilter(rawAudio, segment.duration));
    }

    if (segment.freeze) {
      filters.push(...buildFreezeFilters({
        segment,
        montage,
        videoIn: rawVideo,
        audioIn: rawAudio,
        videoOut: videoLabel,
        audioOut: audioLabel,
        label: (name) => L(`${name}${i}`),
        drawOverlay: !closeup
      }));
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
      closeupRemaining,
      freezeHold: freezeWindow
        ? { at: freezeWindow.outputAt, duration: freezeWindow.duration }
        : null
    });
    filters.push(...built.filters);
    layout = built.layout;
    videoOut = L('sv');
  }

  // Со сплитом картинка overlay лежит поверх обеих половин, пока они стоят.
  if (closeup && freezeWindow) {
    const size = clamp(Number(freezeWindow.size) || 100, 10, 100) / 100;
    const boxW = evenRound(target.width * size);
    const boxH = evenRound(target.height * size);
    const D = freezeWindow.duration.toFixed(6);
    const at = freezeWindow.outputAt.toFixed(6);
    filters.push(
      `[${videoStreamSpec(freezeWindow.inputIndex, freezeWindow.media)}]${filterChain(
        `trim=duration=${D}`,
        'setpts=PTS-STARTPTS',
        freezeWindow.media.vfr || needsFpsConvert(target.fps, freezeWindow.media.fps) ? `fps=${target.fps}` : '',
        `scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=${SCALE_FLAGS}`,
        'setsar=1',
        `setpts=PTS+${at}/TB`
      )}[${L('fzTop')}]`
    );
    filters.push(...blurHoldFilters(videoOut, L('fzBlur'), {
      at: freezeWindow.outputAt,
      duration: freezeWindow.duration,
      total: duration,
      label: (name) => L(`fb${name}`)
    }));
    filters.push(
      `[${L('fzBlur')}][${L('fzTop')}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:format=auto,` +
        `setsar=1,format=${target.pixelFormat}[${L('fzFull')}]`
    );
    videoOut = L('fzFull');
  }

  // Оверлей ложится последним — поверх уже собранного split-screen.
  if (overlay) {
    const opacity = clamp(Number(overlayOpacity) / 100, 0, 1);
    const overlayFps = needsFpsConvert(target.fps, overlay.fps) ? `fps=${target.fps},` : '';
    const overlayAlpha = opacity >= 0.999
      ? 'format=rgba'
      : `format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}`;
    filters.push(
      `[${videoStreamSpec(overlayIndex, overlay)}]setpts=PTS-STARTPTS,${overlayFps}` +
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
/** Скрипты графов, которые сейчас читает какой-то ffmpeg (любой вкладки). */
const activeFilterScripts = new Set();

function releaseFilterScript(script) {
  if (!script) return;
  activeFilterScripts.delete(script);
  safeUnlink(script);
}

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
  activeFilterScripts.add(script);
  command._complexFilters('-filter_complex_script', script);
  command._filterScriptPath = script;
  return script;
}

function applyInputs(command, inputs, plan, pace) {
  inputs.forEach((input) => {
    const added = command.input(input.file);
    if (plan.hwaccel) added.inputOptions(['-hwaccel', plan.hwaccel]);
    if (plan.resourceUsage === 'low') added.inputOptions(['-threads', '1']);
    if (pace && input.pace !== false) added.inputOptions(paceGlobalArgs(plan));
    if (input.options && input.options.length) added.inputOptions(input.options);
  });
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.max(0, Math.round(seconds));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function runCommand(command, { plan, totalDuration, onProgress, onCommand, onDebug }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastEmit = 0;
    const cleanup = () => releaseFilterScript(command._filterScriptPath);
    const finish = (handler) => (value) => {
      if (settled) return;
      settled = true;
      Promise.resolve(waitForFfmpegExit(command))
        .catch(() => {})
        .then(() => {
          cleanup();
          handler(value);
        });
    };

    command.on('start', (commandLine) => {
      command._startedAt = Date.now();
      command._commandLine = commandLine;
      lowerFfmpegPriority(command);
      if (typeof onCommand === 'function') onCommand(command);
      if (typeof onDebug === 'function') onDebug(commandLine);
    });
    command.on('stderr', (line) => {
      if (typeof onDebug === 'function') onDebug(line);
    });
    command.on('progress', (progress) => {
      if (typeof onProgress !== 'function' || totalDuration <= 0) return;
      const now = Date.now();
      if (now - lastEmit < PROGRESS_INTERVAL_MS) return;
      lastEmit = now;
      const done = timemarkToSeconds(progress.timemark);
      const percent = clamp((done / totalDuration) * 100, 0, 99.9);
      const fps = Number(progress.currentFps) || 0;
      const elapsedSec = (now - (command._startedAt || now)) / 1000;
      const eta = percent > 1.5 && elapsedSec > 0.4
        ? ((100 - percent) / percent) * elapsedSec
        : 0;
      onProgress(percent, {
        fps,
        kbps: Number(progress.currentKbps) || 0,
        eta,
        timemark: progress.timemark
      });
    });
    command.on('error', (err, stdout, stderr) => {
      if (err && typeof err === 'object') {
        err.ffmpegStderr = String(stderr || '');
        err.ffmpegCommand = command._commandLine || '';
      }
      handleError(err);
    });
    const handleError = finish((err) => {
      if (isCommandTooLong(err) || isUnknownFfmpegOption(err)) {
        reject(err);
        return;
      }
      if (plan && plan.usingGpu) {
        reject(new GpuUnavailableError(err));
        return;
      }
      reject(err);
    });
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
  const seedPlan = params.plan || { pixelFormat: 'yuv420p' };
  const target = resolveTarget(params.frame, params.fit, source, seedPlan);
  const plan = params.plan && params.plan.videoOptions
    ? params.plan
    : resolveEncodePlan(encoder, {
      accel: params.accel,
      exportMode: params.exportMode,
      resourceUsage: params.resourceUsage,
      forceCpu: params.forceCpu,
      target
    }, hardware);
  const freeze = params.freeze || null;
  const timeline = isolateJobTimeline({
    closeupStart: params.closeupStart,
    splitAt: !shorts
      ? NaN
      : Number.isFinite(Number(params.splitAt)) && Number(params.splitAt) > 0
        ? Number(params.splitAt)
        : resolveSplitAt(source, percent),
    duration: Number.isFinite(Number(params.duration)) && Number(params.duration) > 0
      ? Number(params.duration)
      : source.duration + (shorts ? shorts.duration : 0) + (freeze ? freeze.duration : 0),
    percent
  });
  const splitAt = timeline.splitAt;
  const totalDuration = timeline.duration;

  const { inputs, filters, videoOut, audioOut, layout, pace } = buildGraph({
    source,
    shorts,
    freeze,
    overlay,
    closeup,
    closeupStart: timeline.closeupStart,
    split,
    target,
    splitAt,
    overlayOpacity,
    duration: totalDuration,
    applyPace: Boolean(plan.pace)
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
    .format(outputContainer(plan.encoderKey || encoder))
    .output(outputFile);

  return runCommand(command, {
    plan,
    totalDuration,
    onProgress: typeof onProgress === 'function'
      ? (pct, meta) => onProgress(pct, meta)
      : null,
    onCommand,
    onDebug
  }).then(() => {
    if (typeof onProgress === 'function') onProgress(100, { fps: 0, eta: 0 });
    return {
      outputFile,
      splitAt,
      layout,
      expectedDuration: totalDuration
    };
  });
}


async function verifyOutputFile(file, expected = {}) {
  if (!file || !fs.existsSync(file)) throw new Error('итоговый файл не появился');
  const size = fs.statSync(file).size;
  if (size < MIN_OUTPUT_BYTES) throw new Error('итоговый файл слишком маленький');
  const info = await probeMedia(file);
  if (expected.requireAudio && !info.hasAudio) throw new Error('в результате нет звука');
  if (expected.width && expected.height) {
    if (Math.abs(info.width - expected.width) > 2 || Math.abs(info.height - expected.height) > 2) {
      throw new Error(`ожидали ${expected.width}x${expected.height}, получили ${info.width}x${info.height}`);
    }
  }
  if (Number.isFinite(expected.duration) && Math.abs(info.duration - expected.duration) > 0.55) {
    throw new Error(`длительность ${info.duration.toFixed(2)}с вместо ${expected.duration.toFixed(2)}с`);
  }
  const warnings = [];
  if (Number.isFinite(expected.duration)) {
    [['видеопоток', info.videoDuration], ['аудиопоток', info.audioDuration]].forEach(([name, value]) => {
      if (Number.isFinite(value) && value > 0 && Math.abs(value - expected.duration) > 0.55) {
        warnings.push(`${name} ${value.toFixed(2)}с при ожидаемых ${expected.duration.toFixed(2)}с`);
      }
    });
  }
  return { info, size, warnings };
}

/** Минимальный размер готового результата: всё меньше считаем незавершённым. */
const MIN_RENDER_BYTES = 64 * 1024;

/**
 * Очистка очереди рендера: удаляем незавершённые результаты (esN.mp4 / esN.mov
 * нулевого размера, .part и .tmp) и временные filter-script-файлы ffmpeg.
 * Готовые файлы не трогаем.
 */
function clearRenderArtifacts(options = {}) {
  const prefix = options.outputPrefix || DEFAULTS.outputPrefix;
  const outputDir = options.outputDir;
  const removed = [];
  if (outputDir && fs.existsSync(outputDir)) {
    const pattern = new RegExp(`^${escapeRegExp(prefix)}\\d+\\.(mov|mp4)(\\.part|\\.tmp)?$`, 'i');
    fs.readdirSync(outputDir).forEach((name) => {
      if (!pattern.test(name)) return;
      const file = path.join(outputDir, name);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        return;
      }
      const partial = /\.(part|tmp)$/i.test(name) || size < MIN_RENDER_BYTES;
      if (!partial) return;
      safeUnlink(file);
      if (!fs.existsSync(file)) removed.push(name);
    });
  }
  try {
    const temp = os.tmpdir();
    fs.readdirSync(temp).forEach((name) => {
      if (!/^shorts-fc-.*\.ffilter$/i.test(name)) return;
      const file = path.join(temp, name);
      if (activeFilterScripts.has(file)) return;
      safeUnlink(file);
      if (!fs.existsSync(file)) removed.push(name);
    });
  } catch {
    /* нет доступа к temp — не критично */
  }
  return { removed: removed.length, files: removed };
}

// ---------------------------------------------------------------------------
// Пакетная обработка
// ---------------------------------------------------------------------------

/**
 * Общий на всё приложение лимит одновременных ffmpeg-кодирований.
 *
 * Вкладки работают независимо, но процессор и видеокарта у них одни: без
 * общего лимита пять вкладок по несколько файлов забивали бы машину так, что
 * суммарно выходило бы медленнее. Слот выдаётся по очереди (FIFO), GPU-сессии
 * считаются отдельно — у потребительских карт NVIDIA их число ограничено.
 */
class EncodeSlots {
  constructor(cores = (os.cpus() || []).length || 4) {
    this.total = clamp(Math.floor(Math.max(1, cores) / 2), 3, 8);
    this.gpuCap = 3;
    this.active = 0;
    this.gpuActive = 0;
    this.waiters = [];
  }

  canRun(gpu) {
    return this.active < this.total && (!gpu || this.gpuActive < this.gpuCap);
  }

  grant(gpu) {
    this.active += 1;
    if (gpu) this.gpuActive += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (gpu) this.gpuActive -= 1;
      this.drain();
    };
  }

  drain() {
    for (let i = 0; i < this.waiters.length;) {
      const waiter = this.waiters[i];
      if (this.canRun(waiter.gpu)) {
        this.waiters.splice(i, 1);
        waiter.resolve(this.grant(waiter.gpu));
      } else {
        i += 1;
      }
    }
  }

  /**
   * Возвращает функцию освобождения слота. drain() срабатывает на каждом
   * освобождении, поэтому в очереди стоят только те, кому сейчас нельзя, —
   * новый запрос, которому можно (например, CPU-файл при занятых GPU-сессиях),
   * получает слот сразу.
   */
  acquire(owner, gpu) {
    if (this.canRun(gpu)) return Promise.resolve(this.grant(gpu));
    return new Promise((resolve, reject) => {
      this.waiters.push({ owner, gpu: Boolean(gpu), resolve, reject });
    });
  }

  wouldWait(gpu) {
    return !this.canRun(gpu);
  }

  cancel(owner) {
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.owner !== owner) return true;
      waiter.reject(new ProcessingCancelledError());
      return false;
    });
  }

  /** Видеокарта отказала при нескольких сессиях сразу — дальше держим их меньше. */
  lowerGpuCap(othersActive) {
    this.gpuCap = Math.max(1, Math.min(this.gpuCap - 1, othersActive));
  }
}

const encodeSlots = new EncodeSlots();

/** Promise.all с ограничением параллельности; порядок результатов сохраняется. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

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
    this.activeCommands = new Set();
    this.running = false;
  }

  log(level, message) {
    if (typeof this.hooks.onLog === 'function') this.hooks.onLog(level, message);
  }

  /**
   * Ошибка файла: короткая строка в лог плюс полный stderr ffmpeg (если он был)
   * в лог программы и в ffmpeg_errors.log рядом с результатами.
   */
  logFileFailure(humanIndex, fileName, err) {
    const message = err && err.message ? err.message : String(err);
    this.log('error', `[${humanIndex}] Ошибка на файле ${fileName}: ${shortenFfmpegError(message)} — файл пропущен`);
    const stderr = err && err.ffmpegStderr ? String(err.ffmpegStderr).trim() : '';
    if (!stderr) return;
    const command = err.ffmpegCommand ? `Команда: ${err.ffmpegCommand}\n` : '';
    this.log('error', `[${humanIndex}] Полный stderr FFmpeg для ${fileName}:\n${command}${stderr}`);
    const outputDir = this.settings && this.settings.outputDir;
    if (!outputDir) return;
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.appendFileSync(
        path.join(outputDir, 'ffmpeg_errors.log'),
        `===== ${new Date().toISOString()} [${humanIndex}] ${fileName}\n${message}\n${command}${stderr}\n\n`,
        'utf8'
      );
    } catch (writeErr) {
      this.log('warn', `Не удалось записать ffmpeg_errors.log: ${writeErr.message}`);
    }
  }

  emitProgress(state) {
    if (typeof this.hooks.onProgress === 'function') this.hooks.onProgress(state);
  }

  stop() {
    if (!this.running || this.cancelled) return;
    this.cancelled = true;
    this.log('warn', 'Получен запрос на остановку. Прерываем текущие файлы…');
    encodeSlots.cancel(this);
    this.activeCommands.forEach((command) => {
      try {
        command.kill('SIGKILL');
      } catch (err) {
        this.log('error', `Не удалось остановить FFmpeg: ${err.message}`);
      }
    });
  }

  validate() {
    const s = this.settings;
    const errors = [];

    if (!s.sourceDir || !fs.existsSync(s.sourceDir)) errors.push('Папка с исходными видео не найдена.');
    const useShorts = s.useShorts !== false;
    if (useShorts && (!s.shortsFile || !fs.existsSync(s.shortsFile))) errors.push('Файл Shorts не найден.');
    if (s.useFreeze) {
      const freezeFile = s.freezeFile || s.shortsFile;
      if (!freezeFile || !fs.existsSync(freezeFile)) {
        errors.push('Overlay-вставка включена, но видео для неё не выбрано или не найдено.');
      }
      if (hasFreezePercent(s)) {
        const pct = Number(s.freezePercent);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          errors.push('Момент Overlay должен быть процентом от 0 до 100.');
        }
      } else {
        const at = Number(s.freezeAt);
        if (s.freezeAt != null && s.freezeAt !== '' && (!Number.isFinite(at) || at < 0)) {
          errors.push('Момент Overlay должен быть временем от 0 секунд.');
        }
      }
    }
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
      const hardware = await detectHardwareAsync();
      const exportOptions = {
        exportMode: normalizeExportMode(s.exportMode),
        resourceUsage: normalizeResourceUsage(s.resourceUsage || s.accel || DEFAULTS.resourceUsage),
        forceCpu: s.accel === 'cpu' || s.forceCpu === true,
        jobs: 1
      };
      const encoder = resolveEncoderKey(s.encoder, hardware);
      const prefix = s.outputPrefix || DEFAULTS.outputPrefix;
      const overlayOpacity = Number.isFinite(Number(s.overlayOpacity)) ? Number(s.overlayOpacity) : 100;

      fs.mkdirSync(s.outputDir, { recursive: true });

      const sameDir = path.resolve(s.outputDir) === path.resolve(s.sourceDir);
      const sources = listVideoFiles(s.sourceDir, { skipOutputNames: sameDir, outputPrefix: prefix });
      summary.total = sources.length;

      if (!sources.length) {
        throw new Error('В выбранной папке нет видеофайлов.');
      }

      const seedPlan = resolveEncodePlan(encoder, exportOptions, hardware);
      const parallel = Math.min(
        sources.length,
        resolveParallelJobs(s.parallelJobs, {
          resourceUsage: exportOptions.resourceUsage,
          usingGpu: seedPlan.usingGpu,
          encoderKey: seedPlan.encoderKey,
          cores: hardware.cores
        })
      );
      exportOptions.jobs = parallel;
      const plan = resolveEncodePlan(encoder, exportOptions, hardware);

      const frame = FRAME_PRESETS[s.frame] ? s.frame : DEFAULTS.frame;
      const fit = FIT_MODES[s.fit] ? s.fit : DEFAULTS.fit;

      this.log('info', `Найдено видео: ${sources.length}`);
      this.log('info', `FFmpeg: ${ffmpegPath}`);
      this.log(
        'info',
        `Экспорт: ${plan.label}; обрезка ${percent}%; ` +
          (parallel > 1
            ? `параллельно ${parallel} файла (по одному ffmpeg на файл)`
            : isMaxSpeed(exportOptions.resourceUsage) || sources.length === 1
              ? 'по одному файлу'
              : 'по одному файлу (параллельно — в режиме «Максимальная скорость»)')
      );
      if (plan.encoderKey === 'prores') {
        this.log('info', `ProRes на CPU, ${plan.threads.encodeThreads} из ${plan.threads.cores} потоков`);
      } else if (plan.usingGpu) {
        this.log(
          'info',
          `Кодирование на GPU (${plan.encoderName}), CPU только склейка (${plan.threads.filterThreads} поток(а) фильтров)`
        );
      } else {
        this.log(
          'info',
          `Software ${plan.encoderName}, ${plan.threads.encodeThreads} из ${plan.threads.cores} потоков, пресет не slower/veryslow`
        );
      }
      if (plan.encoderKey !== 'prores') {
        if (plan.pace) {
          const speed = encodePaceSpeed(plan);
          this.log(
            'info',
            plan.usingGpu
              ? `GPU: чтение ${speed}× без стартового выброса; следующий файл — после закрытия NVENC`
              : `Режим LOW: чтение входа ограничено ${speed}×, чтобы нагрузка не скакала`
          );
        } else {
          this.log(
            'info',
            `Без искусственного потолка fps. Файл сразу в ${prefix}N${outputExtension(encoder)}`
          );
        }
      }
      if (hardware.compiledGpu && hardware.compiledGpu.length) {
        this.log('info', `Hardware Encoder: ${plan.vendor || 'нет'} · в FFmpeg: ${hardware.compiledGpu.join(', ')}`);
      }
      if (!plan.usingGpu && !exportOptions.forceCpu && hardware.probeError) {
        this.log('warn', `Тест видеокарты: ${hardware.probeError}`);
      }
      this.log(
        'info',
        `Кадр: ${FRAME_PRESETS[frame].label}, ${FIT_MODES[fit].label.toLowerCase()}`
      );

      let shorts = null;
      if (s.useShorts !== false) {
        shorts = await probeMedia(s.shortsFile);
        this.log(
          'info',
          `Shorts: ${path.basename(shorts.file)} — ${shorts.width}x${shorts.height}, ` +
            `${formatDuration(shorts.duration)}${shorts.hasAudio ? '' : ', без звука'}`
        );
      } else {
        this.log('info', 'Shorts: выключен — ролики собираются без вставки Shorts');
      }

      let freezeMedia = null;
      if (s.useFreeze) {
        freezeMedia = await probeMedia(s.freezeFile || s.shortsFile);
        if (!(freezeMedia.duration > 0)) throw new Error('Overlay-видео пустое или повреждено.');
        this.log(
          'info',
          `Overlay-вставка: ${path.basename(freezeMedia.file)} — ${freezeMedia.width}x${freezeMedia.height}, ` +
            `${freezeMedia.fps} fps, ${formatDuration(freezeMedia.duration)}` +
            `${freezeMedia.hasAudio ? '' : ', без звука (на время вставки — тишина)'}; ` +
            `момент ${hasFreezePercent(s) ? `${Number(s.freezePercent)}% каждого ролика` : formatClock(Number(s.freezeAt) || 0)}, ` +
            `размер ${clamp(Number(s.freezeSize) || 100, 10, 100)}%`
        );
      }

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

      this.emitProgress({
        fileIndex: 0,
        total: sources.length,
        filePercent: 0,
        overallPercent: 0,
        status: `Читаем ${sources.length} файлов…`,
        done: 0,
        failed: 0
      });
      const probes = await mapLimit(sources, PROBE_CONCURRENCY, (file) => (
        this.cancelled
          ? Promise.resolve({ ok: false, error: new ProcessingCancelledError() })
          : probeMedia(file).then((info) => ({ ok: true, info }), (error) => ({ ok: false, error }))
      ));

      let closeupHead = 0;
      const jobs = [];
      /** Файлы, которые уже в конечном состоянии (готово или ошибка). */
      let settled = 0;

      for (let i = 0; i < sources.length; i += 1) {
        if (this.cancelled) break;

        const sourceFile = sources[i];
        const fileName = path.basename(sourceFile);
        const outputFile = path.join(s.outputDir, `${prefix}${i + 1}${outputExtension(encoder)}`);
        const humanIndex = `${i + 1}/${sources.length}`;

        try {
          if (!probes[i].ok) throw probes[i].error;
          const source = probes[i].info;
          if (source.duration <= 0.2) {
            throw new Error('Слишком короткое или повреждённое видео.');
          }

          this.log(
            'info',
            `[${humanIndex}] ${fileName} — ${source.width}x${source.height}, ${source.fps} fps, ` +
              `${formatDuration(source.duration)}${source.hasAudio ? '' : ', без звука'}`
          );
          if (shorts) {
            this.log(
              'info',
              `[${humanIndex}] Точка вставки: ${formatDuration((source.duration * percent) / 100)} ` +
                `(${percent}%) → ${path.basename(outputFile)}`
            );
          }

          const target = resolveTarget(frame, fit, source, plan);
          const freeze = freezeMedia
            ? planFreeze({
              at: freezeMomentFor(s, source.duration),
              media: freezeMedia,
              size: s.freezeSize,
              sourceDuration: source.duration,
              fps: target.fps
            })
            : null;
          if (freeze) {
            this.log(
              'info',
              `[${humanIndex}] Overlay: стоп-кадр на ${formatClock(freeze.at)}` +
                `${hasFreezePercent(s) ? ` (${Number(s.freezePercent)}%)` : ''} (кадр ${freeze.frameIndex} при ${target.fps} fps` +
                `${freeze.clamped ? `, ${formatClock(freeze.requested)} длиннее ролика — ограничено концом` : ''}), ` +
                `пауза ${formatClock(freeze.duration)} (${freeze.frames} кадров) → ${path.basename(outputFile)}`
            );
          }
          const jobPlan = resolveEncodePlan(encoder, { ...exportOptions, target }, hardware);
          if (i === 0) {
            const work = describeEncodeWork({ overlay, closeup, source, shorts, target });
            this.log(
              'info',
              `Smart render: ${work.reason}. Масштаб: ${work.scale ? 'да' : 'нет'}, ` +
                `FPS: ${work.keepSourceFps ? `как у исходника ${target.fps}` : `приводим к ${target.fps}`}, ` +
                `оверлей: ${work.overlay ? 'да' : 'нет'}, split: ${work.split ? 'да' : 'нет'}`
            );
          }
          const estimated = estimateOutputBytes({
            width: target.width,
            height: target.height,
            fps: target.fps,
            duration: source.duration + (shorts ? shorts.duration : 0) + (freeze ? freeze.duration : 0),
            encoderKey: encoder,
            exportMode: exportOptions.exportMode
          });
          this.log(
            'info',
            `[${humanIndex}] ${target.width}x${target.height} ${target.fps} fps · ${jobPlan.encoderName}` +
              `${jobPlan.cq != null ? ` CQ/CRF ${jobPlan.cq}` : ''} · оценка ~${(estimated / 1024 / 1024).toFixed(1)} МБ`
          );
          const splitAt = shorts ? resolveSplitAt(source, percent) : NaN;
          const duration = source.duration + (shorts ? shorts.duration : 0) + (freeze ? freeze.duration : 0);
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
            freeze,
            encoder,
            hardware,
            frame,
            fit,
            plan: jobPlan,
            estimatedBytes: estimated
          });
          // Playhead двигаем по плану этого ролика, не по фактическому хвосту.
          // Иначе 20% текущего файла оседают как «остаток» следующего Shorts.
          // Позиция считается заранее, поэтому порядок параллельного рендера на неё не влияет.
          // На время overlay сплит стоит, поэтому следующий ролик продолжает
          // крупный план с кадра паузы, а не после пропущенных секунд вставки.
          if (closeup) closeupHead += timeline.duration - (freeze ? freeze.duration : 0);
        } catch (err) {
          if (this.cancelled) break;
          summary.failed += 1;
          settled += 1;
          this.logFileFailure(humanIndex, fileName, err);
          safeUnlink(outputFile);
          this.emitProgress({
            fileIndex: i,
            total: sources.length,
            fileName,
            filePercent: 0,
            overallPercent: (settled / sources.length) * 100,
            status: `Ошибка ${humanIndex}: ${fileName}`,
            done: summary.done,
            failed: summary.failed
          });
        }
      }

      /** Прогресс файлов, которые кодируются прямо сейчас: index → { percent, fps, eta }. */
      const active = new Map();

      const emitJobProgress = (job, filePercent, status, extra = {}) => {
        const encodePlan = extra.plan || job.plan || plan;
        if (active.has(job.index)) {
          active.set(job.index, { percent: filePercent, fps: extra.fps || 0, eta: extra.eta });
        }
        let sum = 0;
        let fps = 0;
        let eta = null;
        active.forEach((value) => {
          sum += value.percent;
          fps += value.fps || 0;
          if (Number.isFinite(value.eta)) eta = eta == null ? value.eta : Math.max(eta, value.eta);
        });
        const running = active.size;
        const shownPercent = running > 1 ? sum / running : filePercent;
        const runningNames = running > 1
          ? Array.from(active.keys()).sort((a, b) => a - b).map((index) => `${index + 1}`).join(', ')
          : null;
        this.emitProgress({
          fileIndex: job.index,
          total: sources.length,
          fileName: job.fileName,
          outputName: path.basename(job.outputFile),
          filePercent: shownPercent,
          overallPercent: clamp(((settled + sum / 100) / sources.length) * 100, 0, 100),
          status: status || (runningNames
            ? `Рендер файлов ${runningNames} из ${sources.length} — ${Math.round(shownPercent)}%`
            : `Rendering ${job.humanIndex}: ${job.fileName} — ${Math.round(filePercent)}%`),
          done: summary.done,
          failed: summary.failed,
          active: running,
          parallel,
          fps,
          eta: eta != null ? formatEta(eta) : '—',
          encoderName: encodePlan.encoderName || encodePlan.label,
          vendor: encodePlan.vendor || (encodePlan.usingGpu ? 'GPU' : 'CPU'),
          resolution: job.target ? `${job.target.width}x${job.target.height}` : '',
          estimatedSize: job.estimatedBytes
            ? `${Math.max(1, Math.round(job.estimatedBytes / 1024 / 1024))} MB`
            : '',
          usingGpu: Boolean(encodePlan.usingGpu)
        });
      };

      const finished = new Set();
      const markJobDone = async (job) => {
        if (!job || finished.has(job.outputFile)) return false;
        const verified = await verifyOutputFile(job.outputFile, {
          requireAudio: true,
          width: job.target && job.target.width,
          height: job.target && job.target.height,
          duration: job.duration
        });
        verified.warnings.forEach((warning) => this.log('warn', `[${job.humanIndex}] Проверка результата: ${warning}`));
        finished.add(job.outputFile);
        summary.done += 1;
        summary.results.push({ source: job.source.file, output: job.outputFile, size: verified.size });
        this.log(
          'success',
          `[${job.humanIndex}] Готово: ${path.basename(job.outputFile)} ` +
            `(${(verified.size / 1024 / 1024).toFixed(1)} МБ, ${verified.info.width}x${verified.info.height}, ` +
            `${verified.info.fps} fps)`
        );
        return true;
      };

      const encodeOne = async (job, encodePlan) => {
        let own = null;
        try {
          await renderVideo({
            source: job.source,
            shorts,
            overlay,
            closeup,
            closeupStart: job.closeupStart,
            splitAt: job.splitAt,
            duration: job.duration,
            freeze: job.freeze,
            split,
            outputFile: job.outputFile,
            percent: job.percent,
            encoder,
            plan: encodePlan,
            hardware,
            frame,
            fit,
            overlayOpacity,
            onCommand: (command) => {
              own = command;
              this.activeCommands.add(command);
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
            onProgress: (filePercent, meta = {}) => emitJobProgress(job, filePercent, null, {
              plan: encodePlan,
              fps: meta.fps,
              eta: meta.eta
            })
          });
        } finally {
          if (own) this.activeCommands.delete(own);
        }
      };

      const cpuPlanFor = (job) => resolveEncodePlan(
        encoder,
        { ...exportOptions, forceCpu: true, target: job.target },
        hardware
      );
      /** Видеокарта признана нерабочей: следующие файлы сразу идут на процессор. */
      let gpuGaveUp = false;

      const acquireSlot = async (job, encodePlan) => {
        if (encodeSlots.wouldWait(encodePlan.usingGpu)) {
          this.emitProgress({
            fileIndex: job.index,
            total: sources.length,
            fileName: job.fileName,
            filePercent: 0,
            overallPercent: clamp((settled / sources.length) * 100, 0, 100),
            status: `Ждём свободный слот рендера (заняты другими файлами или вкладками)…`,
            done: summary.done,
            failed: summary.failed
          });
        }
        return encodeSlots.acquire(this, encodePlan.usingGpu);
      };

      /**
       * Кодирует файл с откатами: при отказе GPU на фоне других сессий —
       * повтор на GPU с меньшим числом сессий, иначе повтор на CPU. Видеокарта
       * считается нерабочей, только если CPU справился с тем же файлом, —
       * битый исходник больше не переводит всю очередь на медленный CPU.
       */
      const encodeWithFallback = async (job) => {
        let encodePlan = gpuGaveUp ? cpuPlanFor(job) : job.plan;
        let gpuRetryLeft = true;
        let gpuFailure = null;
        for (;;) {
          if (this.cancelled) throw new ProcessingCancelledError();
          const release = await acquireSlot(job, encodePlan);
          try {
            if (this.cancelled) throw new ProcessingCancelledError();
            active.set(job.index, { percent: 0, fps: 0, eta: null });
            emitJobProgress(job, 0, `Обработка ${job.humanIndex}: ${job.fileName}`, { plan: encodePlan });
            await encodeOne(job, encodePlan);
            if (gpuFailure && !encodePlan.usingGpu && !gpuGaveUp) {
              gpuGaveUp = true;
              this.log(
                'warn',
                `Видеокарта не приняла кадр (${shortenFfmpegError(gpuFailure.message)}), дальше кодируем на процессоре`
              );
            }
            return encodePlan;
          } catch (err) {
            if (this.cancelled || !(err && err.gpuFallback && encodePlan.usingGpu)) throw err;
            safeUnlink(job.outputFile);
            const othersOnGpu = encodeSlots.gpuActive - 1;
            if (gpuRetryLeft && othersOnGpu > 0) {
              gpuRetryLeft = false;
              encodeSlots.lowerGpuCap(othersOnGpu);
              this.log(
                'warn',
                `[${job.humanIndex}] Видеокарта отказала при ${othersOnGpu + 1} одновременных файлах — ` +
                  `повторяю на GPU, дальше не больше ${encodeSlots.gpuCap} сразу`
              );
            } else {
              gpuFailure = err;
              this.log('warn', `[${job.humanIndex}] GPU не справился, повторяю файл на процессоре`);
              encodePlan = cpuPlanFor(job);
            }
          } finally {
            active.delete(job.index);
            release();
          }
        }
      };

      let cursor = 0;
      const worker = async () => {
        let previousPlan = null;
        while (!this.cancelled) {
          const job = jobs[cursor];
          if (!job) return;
          cursor += 1;
          if (previousPlan) await sleep(handoffDelayMs(previousPlan));
          if (this.cancelled) return;
          try {
            previousPlan = await encodeWithFallback(job);
            if (this.cancelled) {
              safeUnlink(job.outputFile);
              return;
            }
            if (!(await markJobDone(job))) {
              throw new Error(`Файл не записался: ${path.basename(job.outputFile)}`);
            }
            settled += 1;
            emitJobProgress(job, 100, `Завершено ${summary.done + summary.failed} из ${sources.length}`);
          } catch (err) {
            if (this.cancelled) {
              safeUnlink(job.outputFile);
              return;
            }
            previousPlan = previousPlan || job.plan;
            summary.failed += 1;
            settled += 1;
            this.logFileFailure(job.humanIndex, job.fileName, err);
            safeUnlink(job.outputFile);
            emitJobProgress(job, 0, `Ошибка ${job.humanIndex}: ${job.fileName}`);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, jobs.length)) }, worker));

      summary.cancelled = this.cancelled;
      summary.elapsedMs = Date.now() - startedAt;
      return summary;
    } finally {
      encodeSlots.cancel(this);
      this.running = false;
      this.activeCommands.clear();
    }
  }
}

module.exports = {
  BatchProcessor,
  clearRenderArtifacts,
  MIN_RENDER_BYTES,
  ENCODERS,
  EXPORT_MODES,
  RESOURCE_MODES,
  PARALLEL_MODES,
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
  detectHardwareAsync,
  resolveEncodePlan,
  resolveParallelJobs,
  threadBudget,
  EncodeSlots,
  encodeSlots,
  resolveEncoderKey,
  perceptualCq,
  estimateOutputBytes,
  describeEncodeWork,
  chooseOutputFps,
  listVideoFiles,
  probeMedia,
  probeMediaViaFfmpeg,
  parseFfmpegProbe,
  ffprobeAvailable,
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
  GPU_PACE_BALANCED,
  GPU_PACE_HIGH,
  MAX_EXPORT_JOBS,
  MAX_PARALLEL_JOBS,
  INTER_FILE_DELAY_MS,
  CPU_HANDOFF_MS,
  GPU_HANDOFF_MS,
  FILTER_SCRIPT_THRESHOLD,
  paceGlobalArgs,
  encodePaceSpeed,
  handoffDelayMs,
  attachFilterGraph,
  isUnknownFfmpegOption,
  fitStep,
  videoSegmentFilter,
  formatClock,
  planFreeze,
  freezeMomentFor,
  planInsertSegments,
  verifyOutputFile
};
