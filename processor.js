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
const ffmpeg = require('fluent-ffmpeg');

const VIDEO_EXTENSIONS = [
  '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.mts', '.m2ts', '.ts', '.3gp', '.ogv'
];

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_LAYOUT = 'stereo';

/** Пресеты кодеков для контейнера .mov. */
const ENCODERS = {
  h264: {
    label: 'H.264 (libx264) — универсальный',
    pixelFormat: 'yuv420p',
    videoOptions: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high'],
    audioOptions: ['-c:a', 'aac', '-b:a', '192k'],
    extraOptions: ['-movflags', '+faststart']
  },
  h265: {
    label: 'H.265 (libx265) — меньше размер',
    pixelFormat: 'yuv420p',
    videoOptions: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '22', '-tag:v', 'hvc1'],
    audioOptions: ['-c:a', 'aac', '-b:a', '192k'],
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

/**
 * Раскладка split-screen. Сдвиги заданы в процентах от ширины кадра, чтобы
 * настройки не зависели от разрешения: -25% это привычные -480 px при ширине 1920.
 */
const SPLIT_DEFAULTS = {
  leftShare: 50,
  feather: 8,
  leftZoom: 1,
  leftOffset: -25,
  rightZoom: 1.8,
  rightOffset: 25
};

const DEFAULTS = {
  percent: 90,
  encoder: 'h264',
  overlayOpacity: 100,
  outputPrefix: 'es',
  split: SPLIT_DEFAULTS
};

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

function videoSegmentFilter(inputLabel, outputLabel, target) {
  return (
    `[${inputLabel}]setpts=PTS-STARTPTS,fps=${target.fps},` +
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:flags=bicubic,` +
    `pad=${target.width}:${target.height}:-1:-1:color=black,setsar=1,` +
    `format=${target.pixelFormat}[${outputLabel}]`
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
 * Делит кадр на две половины: слева смонтированный ролик, справа второе видео.
 *
 * Каждая половина — это окно в «слое»: видео масштабируется на zoom, центр слоя
 * сдвигается на offset (как Position X в монтажке), а в кадр попадает только та
 * часть слоя, которая приходится на свою половину. Поэтому левая часть при
 * сдвиге -25% показывает центр исходника, а правая с зумом 1.8 — крупный план,
 * обрезанный слева.
 *
 * @returns {{filters: string[], layout: object}}
 */
function buildSplitFilters({ baseLabel, closeupIndex, outputLabel, target, split, duration }) {
  const width = target.width;
  const height = target.height;

  const leftWidth = clamp(evenRound((width * split.leftShare) / 100), 2, width - 2);
  const rightWidth = width - leftWidth;
  const featherLimit = Math.max(0, Math.min(leftWidth, rightWidth) - 2);
  const requested = clamp(split.feather, 0, featherLimit);
  // Градиент шириной в один пиксель смысла не имеет и ломает формулу маски.
  const feather = requested > 0 ? Math.max(2, requested) : 0;

  const layerOf = (zoom) => ({ width: evenRound(width * zoom), height: evenRound(height * zoom) });
  const leftLayer = layerOf(split.leftZoom);
  const rightLayer = layerOf(split.rightZoom);

  // Левый край слоя на холсте, затем — какая точка слоя попадает в окно половины.
  const layerLeft = (layer, offsetPercent) => (width - layer.width) / 2 + (width * offsetPercent) / 100;
  const cropX = (layer, offsetPercent, canvasX, windowWidth) =>
    clamp(Math.round(canvasX - layerLeft(layer, offsetPercent)), 0, Math.max(0, layer.width - windowWidth));
  const cropY = (layer) => clamp(Math.round((layer.height - height) / 2), 0, Math.max(0, layer.height - height));

  const zoomLeft =
    leftLayer.width === width && leftLayer.height === height
      ? ''
      : `,scale=${leftLayer.width}:${leftLayer.height}:flags=bicubic`;
  const leftChain = `[${baseLabel}]setsar=1${zoomLeft}`;

  // Второе видео сначала заполняет кадр целиком, потом увеличивается на zoom.
  const rightChain =
    `[${closeupIndex}:v:0]setpts=PTS-STARTPTS,fps=${target.fps},` +
    `scale=${rightLayer.width}:${rightLayer.height}:force_original_aspect_ratio=increase:flags=bicubic,` +
    `crop=${rightLayer.width}:${rightLayer.height},setsar=1`;

  const filters = [];
  const layout = { width, height, leftWidth, rightWidth, feather };

  if (feather === 0) {
    filters.push(
      `${leftChain},crop=${leftWidth}:${height}:` +
        `${cropX(leftLayer, split.leftOffset, 0, leftWidth)}:${cropY(leftLayer)}[splitLeft]`
    );
    filters.push(
      `${rightChain},crop=${rightWidth}:${height}:` +
        `${cropX(rightLayer, split.rightOffset, leftWidth, rightWidth)}:${cropY(rightLayer)}[splitRight]`
    );
    // shortest=1 обязателен: второе видео зациклено и само по себе бесконечно.
    filters.push(`[splitLeft][splitRight]hstack=inputs=2:shortest=1[${outputLabel}]`);
    return { filters, layout };
  }

  // Мягкая граница: правая половина берётся с запасом в feather пикселей и
  // накладывается на левую с альфа-градиентом, чтобы стык не был резким.
  const rightWindow = rightWidth + feather;
  const seam = leftWidth - feather;

  filters.push(
    `${leftChain},crop=${leftWidth + feather}:${height}:` +
      `${cropX(leftLayer, split.leftOffset, 0, leftWidth + feather)}:${cropY(leftLayer)},` +
      `pad=${width}:${height}:0:0:black[splitBase]`
  );
  filters.push(
    `${rightChain},crop=${rightWindow}:${height}:` +
      `${cropX(rightLayer, split.rightOffset, seam, rightWindow)}:${cropY(rightLayer)},` +
      `format=${alphaFormatFor(target.pixelFormat)}[splitRight]`
  );

  // Маска прозрачности: линейный градиент считается один раз на единственном
  // кадре и дальше просто повторяется (фильтр gradients растягивает переход
  // всего на несколько пикселей, независимо от заданной ширины).
  const maskDuration = Math.max(1, duration + 1).toFixed(3);
  filters.push(
    `color=c=black:s=${feather}x${height}:r=1:d=1,format=gray,` +
      `geq=lum='255*X/${feather - 1}',loop=loop=-1:size=1,fps=${target.fps}[splitGradient]`
  );
  filters.push(
    `color=c=white:s=${rightWidth}x${height}:r=${target.fps}:d=${maskDuration},format=gray[splitSolid]`
  );
  filters.push(`[splitGradient][splitSolid]hstack=inputs=2[splitMask]`);
  filters.push(`[splitRight][splitMask]alphamerge=shortest=1[splitSoft]`);
  filters.push(`[splitBase][splitSoft]overlay=x=${seam}:y=0:shortest=1:format=auto[${outputLabel}]`);

  return { filters, layout };
}

/**
 * Собирает список входов, граф фильтров и карту потоков для одного файла.
 *
 * Исходник подключается двумя отдельными входами (голова и хвост) вместо
 * split+trim: так ffmpeg не буферизует хвост видео в памяти, пока пишется
 * начало ролика.
 */
function buildGraph({ source, shorts, overlay, closeup, split, target, splitAt, overlayOpacity, duration }) {
  const inputs = [];
  const filters = [];

  const headDuration = splitAt;
  const tailDuration = Math.max(0, source.duration - splitAt);

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
  if (closeup) {
    // Второе видео живёт по тем же правилам: короткое зациклится, длинное обрежется.
    closeupIndex = inputs.length;
    inputs.push({ file: closeup.file, options: ['-stream_loop', '-1'] });
  }

  const segments = [
    { videoInput: 0, audioSource: source, audioInput: 0, duration: headDuration },
    { videoInput: 2, audioSource: shorts, audioInput: 2, duration: shorts.duration },
    { videoInput: 1, audioSource: source, audioInput: 1, duration: tailDuration }
  ];

  const concatLabels = [];
  segments.forEach((segment, i) => {
    const videoLabel = `v${i}`;
    const audioLabel = `a${i}`;

    filters.push(videoSegmentFilter(`${segment.videoInput}:v:0`, videoLabel, target));

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
    filters.push(
      `[${overlayIndex}:v:0]setpts=PTS-STARTPTS,fps=${target.fps},` +
        `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase:flags=bicubic,` +
        `crop=${target.width}:${target.height},setsar=1,format=rgba,` +
        `colorchannelmixer=aa=${opacity.toFixed(3)}[ovl]`
    );
    filters.push(`[${videoOut}][ovl]overlay=x=0:y=0:shortest=1:eof_action=pass:format=auto[vout]`);
    videoOut = 'vout';
  }

  // Наложения работают в форматах с альфой и могут отдать 4:4:4, который не
  // возьмёт профиль кодека, — поэтому кадр всегда приводится к целевому формату.
  filters.push(`[${videoOut}]format=${target.pixelFormat}[vfinal]`);

  return { inputs, filters, videoOut: 'vfinal', audioOut: 'ca', layout };
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
 * @param {object} params.split       настройки раскладки split-screen
 * @param {string} params.outputFile  путь к esN.mov
 * @param {number} params.percent     процент обрезки (50..99)
 * @param {string} params.encoder     ключ ENCODERS
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

  const preset = ENCODERS[encoder] || ENCODERS[DEFAULTS.encoder];
  const target = {
    width: source.width,
    height: source.height,
    fps: source.fps,
    pixelFormat: preset.pixelFormat
  };

  // У головы и хвоста должно остаться хотя бы по паре кадров, иначе concat получит пустой вход.
  const minSegment = Math.max(0.05, 2 / source.fps);
  const splitAt = clamp(
    (source.duration * percent) / 100,
    minSegment,
    Math.max(minSegment, source.duration - minSegment)
  );
  const totalDuration = source.duration + shorts.duration;

  const { inputs, filters, videoOut, audioOut, layout } = buildGraph({
    source,
    shorts,
    overlay,
    closeup,
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
      if (input.options && input.options.length) added.inputOptions(input.options);
    });

    command
      .complexFilter(filters)
      .outputOptions([
        '-map', `[${videoOut}]`,
        '-map', `[${audioOut}]`,
        ...preset.videoOptions,
        ...preset.audioOptions,
        '-ar', String(AUDIO_SAMPLE_RATE),
        '-ac', '2',
        '-r', String(target.fps),
        ...preset.extraOptions,
        '-y'
      ])
      .format('mov')
      .output(outputFile);

    command.on('start', (commandLine) => {
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
      const prefix = s.outputPrefix || DEFAULTS.outputPrefix;
      const overlayOpacity = Number.isFinite(Number(s.overlayOpacity)) ? Number(s.overlayOpacity) : 100;

      fs.mkdirSync(s.outputDir, { recursive: true });

      const sameDir = path.resolve(s.outputDir) === path.resolve(s.sourceDir);
      const sources = listVideoFiles(s.sourceDir, { skipOutputNames: sameDir, outputPrefix: prefix });
      summary.total = sources.length;

      if (!sources.length) {
        throw new Error('В выбранной папке нет видеофайлов.');
      }

      this.log('info', `Найдено видео: ${sources.length}`);
      this.log('info', `FFmpeg: ${ffmpegPath}`);
      this.log('info', `Кодек: ${ENCODERS[encoder].label}, обрезка: ${percent}%`);

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
      }

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

          this.currentOutput = outputFile;

          await renderVideo({
            source,
            shorts,
            overlay,
            closeup,
            split,
            outputFile,
            percent,
            encoder,
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

          if (this.cancelled) {
            safeUnlink(outputFile);
            break;
          }

          const size = fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0;
          summary.done += 1;
          summary.results.push({ source: sourceFile, output: outputFile, size });
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
  DEFAULTS,
  SPLIT_DEFAULTS,
  normalizeSplit,
  VIDEO_EXTENSIONS,
  ProcessingCancelledError,
  ffmpegPath,
  ffprobePath,
  listVideoFiles,
  probeMedia,
  renderVideo,
  formatDuration,
  isVideoFile,
  shortenFfmpegError
};
