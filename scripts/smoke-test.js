'use strict';

/**
 * Проверка конвейера processor.js без графического интерфейса.
 *
 *   npm run smoke
 *
 * Скрипт генерирует тестовые ролики через FFmpeg, прогоняет через
 * BatchProcessor и проверяет длительность, размер кадра и обработку ошибок.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ffmpeg = require('fluent-ffmpeg');
const {
  BatchProcessor,
  ffmpegPath,
  probeMedia,
  listVideoFiles,
  wrapCloseupOffset,
  planCloseupInputs,
  isolateJobTimeline,
  segmentInputOptions,
  buildFeatherMaskFilter,
  outputExtension,
  resolveEncodePlan,
  ENCODE_PACE_SPEED,
  INTER_FILE_DELAY_MS,
  FILTER_SCRIPT_THRESHOLD,
  paceGlobalArgs,
  attachFilterGraph,
  isUnknownFfmpegOption
} = require('../processor');

const ROOT = path.join(os.tmpdir(), `shorts-inserter-smoke-${process.pid}`);
const SOURCE_DIR = path.join(ROOT, 'source');
const OUTPUT_DIR = path.join(ROOT, 'output');
const ASSETS_DIR = path.join(ROOT, 'assets');

function outH264(dir, n) {
  return path.join(dir, `es${n}${outputExtension('h264')}`);
}

function check(condition, description, details = '') {
  if (condition) {
    console.log(`  OK   ${description}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${description}${details ? ` — ${details}` : ''}`);
  }
}

function ffmpegRun(args) {
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
}

/** Средний цвет кадра в момент time — по нему видно, какой сегмент играет. */
function samplePixel(file, time) {
  const buffer = execFileSync(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(time), '-i', file,
      '-frames:v', '1', '-vf', 'scale=1:1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
    ],
    { maxBuffer: 1024 }
  );
  return [buffer[0], buffer[1], buffer[2]];
}

function colorsMatch(actual, expected, tolerance = 30) {
  return actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance);
}

/** Цвет конкретной точки кадра — по нему проверяется геометрия раскладки. */
function samplePoint(file, time, x, y) {
  const buffer = execFileSync(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(time), '-i', file,
      '-frames:v', '1',
      '-vf', `crop=2:2:${Math.round(x)}:${Math.round(y)},scale=1:1`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
    ],
    { maxBuffer: 1024 }
  );
  return [buffer[0], buffer[1], buffer[2]];
}

/** Кадр из четырёх вертикальных полос — удобно ловить сдвиг и зум. */
function makeStripedVideo({ file, colors, width, height, duration, fps }) {
  const stripe = width / colors.length;
  const boxes = colors
    .map((color, i) => `drawbox=x=${i * stripe}:y=0:w=${stripe}:h=${height}:color=${color}:t=fill`)
    .join(',');
  ffmpegRun([
    '-f', 'lavfi',
    '-i', `color=c=black:size=${width}x${height}:rate=${fps}:duration=${duration}`,
    '-vf', boxes,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    file
  ]);
}

/** Кадр из горизонтальных полос — чтобы проверить, что вертикальный ролик не обрезан сверху. */
function makeBandedVideo({ file, colors, width, height, duration, fps }) {
  const band = height / colors.length;
  const boxes = colors
    .map((color, i) => `drawbox=x=0:y=${i * band}:w=${width}:h=${band}:color=${color}:t=fill`)
    .join(',');
  ffmpegRun([
    '-f', 'lavfi',
    '-i', `color=c=black:size=${width}x${height}:rate=${fps}:duration=${duration}`,
    '-vf', boxes,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    file
  ]);
}

function makeSolidVideo({ file, color, width, height, duration, fps }) {
  ffmpegRun([
    '-f', 'lavfi',
    '-i', `color=c=${color}:size=${width}x${height}:rate=${fps}:duration=${duration}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    file
  ]);
}

/** Два цвета подряд и редкие кейфреймы — ловит перенос хвоста 20% на следующий Shorts. */
function makeTwoToneVideo({ file, headColor, tailColor, duration, headShare, fps, gop = 250 }) {
  const headDur = duration * headShare;
  const tailDur = Math.max(0.05, duration - headDur);
  ffmpegRun([
    '-filter_complex',
    `color=c=${headColor}:s=640x360:r=${fps}:d=${headDur.toFixed(3)}[h];` +
      `color=c=${tailColor}:s=640x360:r=${fps}:d=${tailDur.toFixed(3)}[t];` +
      '[h][t]concat=n=2:v=1:a=0[v]',
    '-map', '[v]',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0`,
    '-pix_fmt', 'yuv420p',
    file
  ]);
}

/** Сплошные цвета подряд — чтобы проверить, что правая половина идёт по таймлайну. */
function makeConcatColorVideo({ file, parts, width, height, fps }) {
  const sources = [];
  const labels = [];
  parts.forEach((part, i) => {
    sources.push(`color=c=${part.color}:s=${width}x${height}:r=${fps}:d=${part.duration}[c${i}]`);
    labels.push(`[c${i}]`);
  });
  ffmpegRun([
    '-filter_complex',
    `${sources.join(';')};${labels.join('')}concat=n=${parts.length}:v=1:a=0[v]`,
    '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1', '-pix_fmt', 'yuv420p',
    file
  ]);
}

function makeVideo({ file, width, height, duration, fps, withAudio, pattern = 'testsrc2' }) {
  const args = [
    '-f', 'lavfi',
    '-i', `${pattern}=size=${width}x${height}:rate=${fps}:duration=${duration}`
  ];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`);
    args.push('-c:a', 'aac', '-shortest');
  }
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file);
  ffmpegRun(args);
}

async function main() {
  console.log(`FFmpeg: ${ffmpegPath}`);
  const hybridPlan = resolveEncodePlan('h264', 'hybrid', { h264: null, h265: null, cores: 8 });
  const cpuPlan = resolveEncodePlan('h264', 'cpu', { h264: null, h265: null, cores: 8 });
  check(
    hybridPlan.threads.encodeThreads === 2 && hybridPlan.threads.filterThreads === 2,
    'hybrid без GPU занимает 2 из 8 ядер, а не все',
    `encode=${hybridPlan.threads.encodeThreads} filter=${hybridPlan.threads.filterThreads}`
  );
  check(
    cpuPlan.threads.encodeThreads === 3,
    'режим «только процессор» берёт треть ядер (не больше 4)',
    `encode=${cpuPlan.threads.encodeThreads}`
  );
  const paceArgs = paceGlobalArgs().join(' ');
  check(
    ENCODE_PACE_SPEED >= 3 && ENCODE_PACE_SPEED <= 4,
    'потолок кодирования около 50% Video Encode (3–4×)',
    `speed=${ENCODE_PACE_SPEED}`
  );
  check(
    paceArgs.includes('-readrate') && paceArgs.includes('readrate_initial_burst 0'),
    'чтение входа ограничено с первого пакета, без стартового выброса',
    paceArgs
  );
  check(
    INTER_FILE_DELAY_MS >= 80 && INTER_FILE_DELAY_MS <= 400,
    'между файлами короткая пауза, чтобы NVENC закрыл предыдущую сессию',
    `delay=${INTER_FILE_DELAY_MS}`
  );
  check(
    outputExtension('h264') === '.mp4' && outputExtension('h265') === '.mp4' && outputExtension('prores') === '.mov',
    'H.264/H.265 пишутся в mp4 для Windows, ProRes остаётся mov'
  );
  const maskGraph = buildFeatherMaskFilter({
    width: 588, height: 1080, fps: 30, duration: 6, feather: 48, outputLabel: 'splitMask'
  });
  check(
    maskGraph.includes('geq=') && maskGraph.includes('eval=init'),
    'маска мягкой границы считается один раз (eval=init), без пустого loop-видео',
    maskGraph
  );
  const shortGraphCmd = ffmpeg();
  attachFilterGraph(shortGraphCmd, ['[0:v]null[v]']);
  const shortGraphArgs = shortGraphCmd._getArguments();
  check(
    shortGraphArgs.includes('-filter_complex') &&
      !shortGraphArgs.some((arg) => String(arg).startsWith('-/filter')),
    'короткий граф идёт как -filter_complex — ffmpeg 6.1 на Windows не знает -/filter_complex'
  );
  const longGraphCmd = ffmpeg();
  const longScript = attachFilterGraph(longGraphCmd, [`[0:v]null[v];${'n'.repeat(FILTER_SCRIPT_THRESHOLD)}`]);
  const longGraphArgs = longGraphCmd._getArguments();
  check(
    longGraphArgs.includes('-filter_complex_script') && !longGraphArgs.includes('-/filter_complex'),
    'длинный граф пишется в файл через -filter_complex_script, не через -/filter_complex'
  );
  check(Boolean(longScript) && fs.existsSync(longScript), 'файл длинного графа создан');
  if (longScript) fs.unlinkSync(longScript);
  check(
    isUnknownFfmpegOption(new Error(
      "Unrecognized option '/filter_complex'.\nError splitting the argument list: Option not found"
    )),
    'неизвестная опция ffmpeg не считается отказом видеокарты'
  );
  [SOURCE_DIR, OUTPUT_DIR, ASSETS_DIR].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

  console.log('\n1) Готовим тестовые файлы…');
  const src1 = path.join(SOURCE_DIR, 'clip1.mp4');
  const src2 = path.join(SOURCE_DIR, 'clip2.mp4');
  const broken = path.join(SOURCE_DIR, 'clip3.mp4');
  const shorts = path.join(ASSETS_DIR, 'shorts.mp4');
  const overlay = path.join(ASSETS_DIR, 'overlay.mp4');

  makeVideo({ file: src1, width: 1280, height: 720, duration: 6, fps: 30, withAudio: true });
  // второй исходник — другое разрешение, другой fps и вообще без звука
  makeVideo({ file: src2, width: 640, height: 480, duration: 4, fps: 25, withAudio: false });
  // вертикальный shorts со звуком
  makeVideo({ file: shorts, width: 540, height: 960, duration: 2, fps: 30, withAudio: true });
  // короткий оверлей — должен зациклиться на весь результат
  makeVideo({ file: overlay, width: 320, height: 180, duration: 1, fps: 30, withAudio: false, pattern: 'smptebars' });
  fs.writeFileSync(broken, 'это не видео');

  const found = listVideoFiles(SOURCE_DIR);
  check(found.length === 3, 'найдены все три файла в папке источников', `найдено ${found.length}`);
  const mixedDir = path.join(ROOT, 'mixed-prefix');
  fs.mkdirSync(mixedDir, { recursive: true });
  fs.copyFileSync(src1, path.join(mixedDir, 'clip.mp4'));
  fs.copyFileSync(src1, path.join(mixedDir, 'es+1.mov'));
  const mixedFound = listVideoFiles(mixedDir, { skipOutputNames: true, outputPrefix: 'es+' });
  check(
    mixedFound.length === 1 && path.basename(mixedFound[0]) === 'clip.mp4',
    'префикс с спецсимволами не ломает фильтр готовых файлов',
    mixedFound.map((file) => path.basename(file)).join(',')
  );

  console.log('\n2) Пакетная обработка (90%, оверлей включён)…');
  const logs = [];
  const progressStates = [];
  const batch = new BatchProcessor(
    {
      sourceDir: SOURCE_DIR,
      shortsFile: shorts,
      useOverlay: true,
      overlayFile: overlay,
      overlayOpacity: 60,
      outputDir: OUTPUT_DIR,
      frame: 'source',
      percent: 90,
      encoder: 'h264',
      verbose: false
    },
    {
      onLog: (level, message) => {
        logs.push(`${level}: ${message}`);
        console.log(`    [${level}] ${message}`);
      },
      onProgress: (state) => progressStates.push(state)
    }
  );

  const summary = await batch.run();

  console.log('\n3) Проверки результата…');
  check(summary.total === 3, 'в очереди три файла', `total=${summary.total}`);
  check(summary.done === 2, 'два файла обработаны успешно', `done=${summary.done}`);
  check(summary.failed === 1, 'битый файл дал ошибку и не остановил очередь', `failed=${summary.failed}`);
  check(
    logs.some((line) => line.startsWith('error:') && line.includes('clip3.mp4')),
    'ошибка по битому файлу попала в лог'
  );
  check(progressStates.length > 5, 'прогресс приходил в интерфейс', `событий: ${progressStates.length}`);
  check(
    progressStates.some((state) => Number(state.done) >= 1) &&
      progressStates.some((state) => Number(state.failed) >= 1),
    'счётчики Готово/Ошибок обновляются во время очереди, а не только в конце'
  );
  check(
    logs.some((line) => line.includes('до ') && line.includes('пишется сразу')),
    'в логе есть ограничение скорости и сохранение каждого файла сразу'
  );

  const out1 = outH264(OUTPUT_DIR, 1);
  const out2 = outH264(OUTPUT_DIR, 2);
  check(fs.existsSync(out1), 'создан es1.mp4');
  check(fs.existsSync(out2), 'создан es2.mp4');
  check(!fs.existsSync(path.join(OUTPUT_DIR, 'es3.mp4')), 'битый файл не оставил мусорный es3.mp4');

  const info1 = await probeMedia(out1);
  const info2 = await probeMedia(out2);

  check(
    Math.abs(info1.duration - 8) < 0.6,
    'es1.mp4 = исходник 6с + shorts 2с',
    `${info1.duration.toFixed(2)}s`
  );
  check(
    Math.abs(info2.duration - 6) < 0.6,
    'es2.mp4 = исходник 4с + shorts 2с',
    `${info2.duration.toFixed(2)}s`
  );
  check(
    info1.width === 1280 && info1.height === 720,
    'es1.mp4 сохранил разрешение исходника 1280x720',
    `${info1.width}x${info1.height}`
  );
  check(
    info2.width === 640 && info2.height === 480,
    'es2.mp4 сохранил разрешение исходника 640x480',
    `${info2.width}x${info2.height}`
  );
  check(info1.hasAudio && info2.hasAudio, 'у обоих результатов есть звуковая дорожка (немой исходник дополнен тишиной)');
  check(info1.videoCodec === 'h264', 'es1.mp4 содержит видео H.264, а не только звук', info1.videoCodec);
  check(
    /avc1/i.test(info1.codecTag),
    'H.264 помечен тегом avc1 — Windows покажет картинку',
    info1.codecTag || '(пусто)'
  );

  console.log('\n4) Проверяем порядок сегментов и зацикливание оверлея по цвету кадров…');
  const colorDir = path.join(ROOT, 'colors');
  const colorOut = path.join(ROOT, 'colors-out');
  fs.mkdirSync(colorDir, { recursive: true });

  // Исходник целиком красный, Shorts зелёный, оверлей белый и вдвое короче результата.
  const redSource = path.join(colorDir, 'red.mp4');
  const greenShorts = path.join(ASSETS_DIR, 'green.mp4');
  const whiteOverlay = path.join(ASSETS_DIR, 'white.mp4');
  makeSolidVideo({ file: redSource, color: 'red', width: 640, height: 360, duration: 4, fps: 30 });
  makeSolidVideo({ file: greenShorts, color: 'lime', width: 640, height: 360, duration: 2, fps: 30 });
  makeSolidVideo({ file: whiteOverlay, color: 'white', width: 640, height: 360, duration: 1, fps: 30 });

  const colorBatch = new BatchProcessor(
    {
      sourceDir: colorDir,
      shortsFile: greenShorts,
      useOverlay: false,
      outputDir: colorOut,
      frame: 'source',
      percent: 75,
      encoder: 'h264'
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );
  await colorBatch.run();

  // 4 c исходника + 2 c shorts, точка вставки на третьей секунде.
  const montage = outH264(colorOut, 1);
  check(colorsMatch(samplePixel(montage, 1.0), [255, 0, 0]), 'до вставки играет исходник (красный)',
    String(samplePixel(montage, 1.0)));
  check(colorsMatch(samplePixel(montage, 4.0), [0, 255, 0]), 'в середине играет Shorts (зелёный)',
    String(samplePixel(montage, 4.0)));
  check(colorsMatch(samplePixel(montage, 5.5), [255, 0, 0]), 'после вставки играет хвост исходника (красный)',
    String(samplePixel(montage, 5.5)));

  const overlayOut = path.join(ROOT, 'colors-out-overlay');
  const overlayBatch = new BatchProcessor(
    {
      sourceDir: colorDir,
      shortsFile: greenShorts,
      useOverlay: true,
      overlayFile: whiteOverlay,
      overlayOpacity: 50,
      outputDir: overlayOut,
      frame: 'source',
      percent: 75,
      encoder: 'h264'
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );
  await overlayBatch.run();

  // Белый оверлей на 50% осветляет каждый сегмент; длится он 1 с, значит дальше идёт луп.
  const blended = outH264(overlayOut, 1);
  check(colorsMatch(samplePixel(blended, 0.5), [255, 128, 128]), 'оверлей смешан с началом ролика',
    String(samplePixel(blended, 0.5)));
  check(colorsMatch(samplePixel(blended, 4.0), [128, 255, 128]), 'оверлей зациклился и лежит поверх Shorts',
    String(samplePixel(blended, 4.0)));
  check(colorsMatch(samplePixel(blended, 5.5), [255, 128, 128]), 'оверлей зациклился до самого конца',
    String(samplePixel(blended, 5.5)));

  console.log('\n5) Проверяем раскладку split-screen…');
  const splitDir = path.join(ROOT, 'split');
  const splitOut = path.join(ROOT, 'split-out');
  fs.mkdirSync(splitDir, { recursive: true });

  // Кадр 1920x1080 из полос по 480 px; итог — квадрат 1080x1080, каждая
  // половина заполняет свою колонку 540x1080 (cover), без предварительной
  // обрезки исходника до квадрата.
  const stripedSource = path.join(splitDir, 'striped.mp4');
  const stripedCloseup = path.join(ASSETS_DIR, 'closeup.mp4');
  makeStripedVideo({
    file: stripedSource,
    colors: ['red', 'lime', 'blue', 'yellow'],
    width: 1920, height: 1080, duration: 4, fps: 30
  });
  makeStripedVideo({
    file: stripedCloseup,
    colors: ['magenta', 'cyan', 'white', 'gray'],
    width: 1920, height: 1080, duration: 3, fps: 30
  });

  const runSplit = async (outputDir, feather, extra = {}) => {
    const batch = new BatchProcessor(
      {
        sourceDir: splitDir,
        shortsFile: greenShorts,
        useOverlay: false,
        useSplit: true,
        closeupFile: stripedCloseup,
        split: { leftShare: 50, feather, leftZoom: 1, leftOffset: 0, rightZoom: 1.8, rightOffset: 0 },
        outputDir,
        frame: 'square1080',
        percent: 75,
        encoder: 'h264',
        ...extra
      },
      { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
    );
    const result = await batch.run();
    return { result, file: outH264(outputDir, 1) };
  };

  const hard = await runSplit(splitOut, 0);
  check(hard.result.done === 1, 'split-screen: файл собран', `done=${hard.result.done}`);

  const splitInfo = await probeMedia(hard.file);
  check(
    splitInfo.width === 1080 && splitInfo.height === 1080,
    'split-screen: результат всегда 1080x1080',
    `${splitInfo.width}x${splitInfo.height}`
  );

  // Левая колонка 540 px, cover без сдвига: центр 1920-кадра (стык полос 2 и 3).
  check(colorsMatch(samplePoint(hard.file, 1, 200, 540), [0, 255, 0]),
    'левая половина: ближе к центру вторая полоса исходника',
    String(samplePoint(hard.file, 1, 200, 540)));
  check(colorsMatch(samplePoint(hard.file, 1, 400, 540), [0, 0, 255]),
    'левая половина: ближе к стыку третья полоса исходника',
    String(samplePoint(hard.file, 1, 400, 540)));

  // Правая колонка, зум 1.8 без сдвига: центр второго видео (cyan / white).
  check(colorsMatch(samplePoint(hard.file, 1, 600, 540), [0, 255, 255]),
    'правая половина: зум 1.8 даёт ожидаемый кусок второго видео',
    String(samplePoint(hard.file, 1, 600, 540)));
  check(colorsMatch(samplePoint(hard.file, 1, 1000, 540), [255, 255, 255]),
    'правая половина: у правого края видна следующая полоса второго видео',
    String(samplePoint(hard.file, 1, 1000, 540)));

  check(colorsMatch(samplePoint(hard.file, 1, 530, 540), [0, 0, 255]),
    'чёткая граница: слева от стыка ещё исходник',
    String(samplePoint(hard.file, 1, 530, 540)));
  check(colorsMatch(samplePoint(hard.file, 1, 550, 540), [0, 255, 255]),
    'чёткая граница: справа от стыка уже второе видео',
    String(samplePoint(hard.file, 1, 550, 540)));

  check(colorsMatch(samplePoint(hard.file, 4, 200, 540), [0, 255, 0]),
    'split-screen: в середине слева играет Shorts',
    String(samplePoint(hard.file, 4, 200, 540)));

  const softOut = path.join(ROOT, 'split-out-soft');
  const soft = await runSplit(softOut, 40);
  check(soft.result.done === 1, 'мягкая граница: файл собран', `done=${soft.result.done}`);

  const seam = samplePoint(soft.file, 1, 530, 540);
  check(colorsMatch(samplePoint(soft.file, 1, 500, 540), [0, 0, 255], 40),
    'мягкая граница: до растушёвки чистый исходник',
    String(samplePoint(soft.file, 1, 500, 540)));
  check(
    seam[1] > 40 && seam[2] > 150,
    'мягкая граница: в середине стыка половины смешаны',
    `rgb=${seam}`
  );
  check(colorsMatch(samplePoint(soft.file, 1, 580, 540), [0, 255, 255], 40),
    'мягкая граница: за стыком чистое второе видео',
    String(samplePoint(soft.file, 1, 580, 540)));

  // Квадрат 1080x1080 из горизонтальных исходников: холст задаётся настройкой,
  // а не размером исходника, при этом раскладка половин не съезжает.
  const squareOut = path.join(ROOT, 'split-out-square');
  const squareBatch = new BatchProcessor(
    {
      sourceDir: colorDir,
      shortsFile: greenShorts,
      useSplit: true,
      closeupFile: whiteOverlay,
      split: { leftShare: 50, feather: 0, leftZoom: 1, leftOffset: 0, rightZoom: 1.8, rightOffset: 0 },
      outputDir: squareOut,
      percent: 75,
      frame: 'square1080',
      fit: 'cover',
      encoder: 'h264'
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );
  const squareSummary = await squareBatch.run();
  check(squareSummary.done === 1, 'квадратный кадр: файл собран', `done=${squareSummary.done}`);

  const square = outH264(squareOut, 1);
  const squareInfo = await probeMedia(square);
  check(
    squareInfo.width === 1080 && squareInfo.height === 1080,
    'квадратный кадр: результат 1080x1080 из горизонтального исходника',
    `${squareInfo.width}x${squareInfo.height}`
  );
  check(colorsMatch(samplePoint(square, 1, 270, 540), [255, 0, 0]),
    'квадратный кадр: слева исходник без полей',
    String(samplePoint(square, 1, 270, 540)));
  check(colorsMatch(samplePoint(square, 1, 810, 540), [255, 255, 255]),
    'квадратный кадр: справа второе видео',
    String(samplePoint(square, 1, 810, 540)));

  // Вертикальный 9:16 должен сохранить полный рост в левой колонке 540x1080,
  // а не обрезаться до центрального квадрата.
  const verticalDir = path.join(ROOT, 'vertical');
  const verticalOut = path.join(ROOT, 'vertical-out');
  fs.mkdirSync(verticalDir, { recursive: true });
  makeBandedVideo({
    file: path.join(verticalDir, 'portrait.mp4'),
    colors: ['red', 'lime', 'blue', 'yellow'],
    width: 1080, height: 1920, duration: 3, fps: 30
  });
  const verticalBatch = new BatchProcessor(
    {
      sourceDir: verticalDir,
      shortsFile: greenShorts,
      useSplit: true,
      closeupFile: whiteOverlay,
      split: { leftShare: 50, feather: 0, leftZoom: 1, leftOffset: 0, rightZoom: 1.8, rightOffset: 0 },
      outputDir: verticalOut,
      frame: 'square1080',
      percent: 75,
      encoder: 'h264'
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );
  const verticalSummary = await verticalBatch.run();
  check(verticalSummary.done === 1, '9:16: файл собран', `done=${verticalSummary.done}`);
  const portrait = outH264(verticalOut, 1);
  const portraitInfo = await probeMedia(portrait);
  check(
    portraitInfo.width === 1080 && portraitInfo.height === 1080,
    '9:16: итог 1080x1080',
    `${portraitInfo.width}x${portraitInfo.height}`
  );
  check(colorsMatch(samplePoint(portrait, 1, 270, 100), [255, 0, 0]),
    '9:16: вверху левой колонки первая полоса — полный рост сохранён',
    String(samplePoint(portrait, 1, 270, 100)));
  check(colorsMatch(samplePoint(portrait, 1, 270, 980), [255, 255, 0]),
    '9:16: внизу левой колонки последняя полоса — полный рост сохранён',
    String(samplePoint(portrait, 1, 270, 980)));

  // Сплит и оверлей вместе, да ещё и в 10-битном ProRes: оверлей должен лечь
  // поверх обеих половин, а альфа-канал не сломать формат кодека.
  const comboOut = path.join(ROOT, 'split-out-combo');
  const comboBatch = new BatchProcessor(
    {
      sourceDir: colorDir,
      shortsFile: greenShorts,
      useSplit: true,
      closeupFile: whiteOverlay,
      split: { leftShare: 50, feather: 16, leftZoom: 1, leftOffset: 0, rightZoom: 1.8, rightOffset: 0 },
      useOverlay: true,
      overlayFile: greenShorts,
      overlayOpacity: 50,
      outputDir: comboOut,
      percent: 75,
      encoder: 'prores'
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );
  const comboSummary = await comboBatch.run();
  check(comboSummary.done === 1, 'сплит вместе с оверлеем: файл собран', `done=${comboSummary.done}`);

  // Холст здесь квадратный по умолчанию, поэтому половины делятся по x = 540.
  const combo = outH264(comboOut, 1);
  check(colorsMatch(samplePoint(combo, 1, 270, 540), [128, 128, 0], 40),
    'сплит + оверлей: слева исходник, смешанный с оверлеем',
    String(samplePoint(combo, 1, 270, 540)));
  check(colorsMatch(samplePoint(combo, 1, 810, 540), [128, 255, 128], 40),
    'сплит + оверлей: справа второе видео, смешанное с оверлеем',
    String(samplePoint(combo, 1, 810, 540)));

  console.log('\n5b) Правая половина идёт подряд по роликам, а не с начала каждый раз…');
  check(wrapCloseupOffset(0, 10) === 0, 'смещение: ноль остаётся нулём');
  check(Math.abs(wrapCloseupOffset(6, 10) - 6) < 1e-9, 'смещение: внутри файла без обёртки');
  check(wrapCloseupOffset(10, 10) === 0, 'смещение: ровно длина файла — снова начало');
  check(Math.abs(wrapCloseupOffset(14, 10) - 4) < 1e-9, 'смещение: после конца файла — остаток');
  check(
    Math.abs(wrapCloseupOffset(5.985, 6) - 5.985) < 1e-9,
    'смещение у конца файла не прыгает в 0 и не повторяет начало следующего Shorts'
  );
  const frozen = isolateJobTimeline({ closeupStart: 3.5, splitAt: 4, duration: 6, percent: 80 });
  frozen.closeupStart = 99;
  const nextFrozen = isolateJobTimeline({ closeupStart: 6, splitAt: 4, duration: 6, percent: 80 });
  check(nextFrozen.closeupStart === 6, 'таймлайн следующего Shorts не наследует playhead предыдущего');
  const tailOpts = segmentInputOptions(4, 1).join(' ');
  check(
    tailOpts.includes('-ss 4.000') && tailOpts.includes('-t 1.000') && tailOpts.includes('-accurate_seek'),
    'хвост 20% читается со своей позиции и со своим лимитом',
    tailOpts
  );
  const headOpts = segmentInputOptions(0, 4).join(' ');
  check(headOpts.includes('-ss 0') && headOpts.includes('-t 4.000'), 'голова 80% всегда с нуля, не с хвоста предыдущего');

  const seqDir = path.join(ROOT, 'seq');
  const seqOut = path.join(ROOT, 'seq-out');
  const seqWrapOut = path.join(ROOT, 'seq-wrap-out');
  fs.mkdirSync(seqDir, { recursive: true });

  makeSolidVideo({ file: path.join(seqDir, 'a-first.mp4'), color: 'red', width: 640, height: 360, duration: 4, fps: 30 });
  makeSolidVideo({ file: path.join(seqDir, 'b-second.mp4'), color: 'red', width: 640, height: 360, duration: 4, fps: 30 });

  const timedCloseup = path.join(ASSETS_DIR, 'timed-closeup.mp4');
  makeConcatColorVideo({
    file: timedCloseup,
    parts: [
      { color: 'magenta', duration: 6 },
      { color: 'yellow', duration: 6 }
    ],
    width: 640, height: 360, fps: 30
  });

  const seqLogs = [];
  const seqBatch = new BatchProcessor(
    {
      sourceDir: seqDir,
      shortsFile: greenShorts,
      useSplit: true,
      closeupFile: timedCloseup,
      split: { leftShare: 50, feather: 0, leftZoom: 1, leftOffset: 0, rightZoom: 1, rightOffset: 0 },
      outputDir: seqOut,
      frame: 'square1080',
      percent: 75,
      encoder: 'h264'
    },
    {
      onLog: (level, message) => {
        seqLogs.push(`${level}: ${message}`);
        console.log(`    [${level}] ${message}`);
      }
    }
  );
  const seqSummary = await seqBatch.run();
  check(seqSummary.done === 2, 'последовательный крупный план: два файла собраны', `done=${seqSummary.done}`);
  check(
    seqLogs.filter((line) => line.startsWith('success:') && line.includes('Готово:')).length === 2,
    'каждый готовый файл сразу попадает в лог как сохранённый'
  );
  const leftoverTemps = fs.readdirSync(seqOut).filter((name) => name.startsWith('.shorts-') || name.startsWith('shorts-seg-'));
  check(leftoverTemps.length === 0, 'временные файлы не остаются в папке результата', leftoverTemps.join(', '));

  const seq1 = outH264(seqOut, 1);
  const seq2 = outH264(seqOut, 2);
  // Исходник 4с + Shorts 2с = 6с. Первое видео берёт крупный план 0–6 (magenta),
  // второе продолжает с 6-й секунды (yellow).
  check(colorsMatch(samplePoint(seq1, 1, 810, 540), [255, 0, 255]),
    'es1 справа: крупный план с начала (пурпурный)',
    String(samplePoint(seq1, 1, 810, 540)));
  check(colorsMatch(samplePoint(seq2, 1, 810, 540), [255, 255, 0]),
    'es2 справа: крупный план продолжается (жёлтый), а не начинается заново',
    String(samplePoint(seq2, 1, 810, 540)));

  const wrapCloseup = path.join(ASSETS_DIR, 'wrap-closeup.mp4');
  makeConcatColorVideo({
    file: wrapCloseup,
    parts: [
      { color: 'magenta', duration: 4 },
      { color: 'yellow', duration: 3 }
    ],
    width: 640, height: 360, fps: 30
  });

  const wrapPlan = planCloseupInputs({ file: wrapCloseup, duration: 6 }, 5, 6);
  check(wrapPlan.wrap === true, 'если крупный план кончается посередине ролика — включается обёртка');
  check(wrapPlan.inputs.length === 2, 'обёртка: хвост текущего круга и луп с начала', `inputs=${wrapPlan.inputs.length}`);

  const wrapBatch = new BatchProcessor(
    {
      sourceDir: seqDir,
      shortsFile: greenShorts,
      useSplit: true,
      closeupFile: wrapCloseup,
      split: { leftShare: 50, feather: 0, leftZoom: 1, leftOffset: 0, rightZoom: 1, rightOffset: 0 },
      outputDir: seqWrapOut,
      frame: 'square1080',
      percent: 75,
      encoder: 'h264'
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );
  const wrapSummary = await wrapBatch.run();
  check(wrapSummary.done === 2, 'обёртка крупного плана: два файла собраны', `done=${wrapSummary.done}`);

  const wrap2 = outH264(seqWrapOut, 2);
  check(fs.existsSync(wrap2), 'обёртка: es2.mp4 записан');
  if (fs.existsSync(wrap2)) {
    // Крупный план 7с: 0–4 magenta, 4–7 yellow. es1 (6с) забирает 0–6.
    // es2 начинается с 6-й: 1с yellow, затем снова magenta с начала файла.
    check(colorsMatch(samplePoint(wrap2, 0.4, 810, 540), [255, 255, 0]),
      'es2 справа сразу после обёртки: ещё хвост жёлтого',
      String(samplePoint(wrap2, 0.4, 810, 540)));
    check(colorsMatch(samplePoint(wrap2, 2.0, 810, 540), [255, 0, 255]),
      'es2 справа после конца файла: крупный план начался сначала (пурпурный)',
      String(samplePoint(wrap2, 2.0, 810, 540)));
  }

  console.log('\n5c) 10 подряд Shorts: 80%+20% без переноса хвоста на следующий ролик…');
  const chainDir = path.join(ROOT, 'chain');
  const chainOut = path.join(ROOT, 'chain-out');
  fs.mkdirSync(chainDir, { recursive: true });

  const chainClips = [
    { head: 'red', headRgb: [255, 0, 0], tail: 'white', tailRgb: [255, 255, 255] },
    { head: 'lime', headRgb: [0, 255, 0], tail: 'black', tailRgb: [0, 0, 0] },
    { head: 'blue', headRgb: [0, 0, 255], tail: 'gray', tailRgb: [128, 128, 128] },
    { head: 'yellow', headRgb: [255, 255, 0], tail: 'navy', tailRgb: [0, 0, 128] },
    { head: 'cyan', headRgb: [0, 255, 255], tail: 'maroon', tailRgb: [128, 0, 0] },
    { head: 'magenta', headRgb: [255, 0, 255], tail: 'olive', tailRgb: [128, 128, 0] },
    { head: 'orange', headRgb: [255, 165, 0], tail: 'teal', tailRgb: [0, 128, 128] },
    { head: 'pink', headRgb: [255, 192, 203], tail: 'purple', tailRgb: [128, 0, 128] },
    { head: 'brown', headRgb: [165, 42, 42], tail: 'silver', tailRgb: [192, 192, 192] },
    { head: 'green', headRgb: [0, 128, 0], tail: 'gold', tailRgb: [255, 215, 0] }
  ];
  const closeupChapters = [
    { color: 'magenta', rgb: [255, 0, 255] },
    { color: 'yellow', rgb: [255, 255, 0] },
    { color: 'cyan', rgb: [0, 255, 255] },
    { color: 'orange', rgb: [255, 165, 0] },
    { color: 'white', rgb: [255, 255, 255] },
    { color: 'red', rgb: [255, 0, 0] },
    { color: 'lime', rgb: [0, 255, 0] },
    { color: 'blue', rgb: [0, 0, 255] },
    { color: 'pink', rgb: [255, 192, 203] },
    { color: 'purple', rgb: [128, 0, 128] }
  ];

  chainClips.forEach((clip, i) => {
    makeTwoToneVideo({
      file: path.join(chainDir, `${String(i + 1).padStart(2, '0')}-${clip.head}.mp4`),
      headColor: clip.head,
      tailColor: clip.tail,
      duration: 5,
      headShare: 0.8,
      fps: 30,
      gop: 250
    });
  });

  const chainCloseup = path.join(ASSETS_DIR, 'chain-closeup.mp4');
  makeConcatColorVideo({
    file: chainCloseup,
    parts: closeupChapters.map((chapter) => ({ color: chapter.color, duration: 7 })),
    width: 640,
    height: 360,
    fps: 30
  });

  const chainBatch = new BatchProcessor(
    {
      sourceDir: chainDir,
      shortsFile: greenShorts,
      useSplit: true,
      closeupFile: chainCloseup,
      split: { leftShare: 50, feather: 0, leftZoom: 1, leftOffset: 0, rightZoom: 1, rightOffset: 0 },
      outputDir: chainOut,
      frame: 'square1080',
      percent: 80,
      encoder: 'h264'
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );
  const chainSummary = await chainBatch.run();
  check(chainSummary.done === 10, 'цепочка: собраны 10 Shorts подряд', `done=${chainSummary.done}`);

  const leftoverChainTemps = fs.readdirSync(chainOut).filter((name) => (
    name.startsWith('.shorts-') || name.startsWith('shorts-seg-')
  ));
  check(leftoverChainTemps.length === 0, 'цепочка: временные данные предыдущего Shorts не остаются', leftoverChainTemps.join(', '));

  for (let i = 0; i < chainClips.length; i += 1) {
    const file = outH264(chainOut, i + 1);
    const clip = chainClips[i];
    const prev = i > 0 ? chainClips[i - 1] : null;
    check(fs.existsSync(file), `цепочка: есть es${i + 1}.mp4`);
    if (!fs.existsSync(file)) continue;

    const startLeft = samplePoint(file, 0.35, 270, 540);
    const midLeft = samplePoint(file, 4.6, 270, 540);
    const endLeft = samplePoint(file, 6.6, 270, 540);
    const startRight = samplePoint(file, 0.35, 810, 540);

    check(
      colorsMatch(startLeft, clip.headRgb, 45),
      `es${i + 1} начинается с 80% своего исходника (${clip.head}), а не с хвоста предыдущего`,
      `rgb=${startLeft}`
    );
    if (prev) {
      check(
        !colorsMatch(startLeft, prev.tailRgb, 40),
        `es${i + 1}: 20% предыдущего (${prev.tail}) не перенесены в начало`,
        `rgb=${startLeft}`
      );
    }
    check(
      colorsMatch(midLeft, [0, 255, 0], 45),
      `es${i + 1}: после 80% вставлен Shorts`,
      `rgb=${midLeft}`
    );
    check(
      colorsMatch(endLeft, clip.tailRgb, 50),
      `es${i + 1}: в конце свой хвост 20% (${clip.tail})`,
      `rgb=${endLeft}`
    );
    check(
      colorsMatch(startRight, closeupChapters[i].rgb, 45),
      `es${i + 1} справа: крупный план с своей секунды (${closeupChapters[i].color}), без повтора предыдущего хвоста`,
      `rgb=${startRight}`
    );
  }

  const namedTransitions = [
    ['A', 'B', 0, 1],
    ['B', 'C', 1, 2],
    ['C', 'D', 2, 3],
    ['D', 'E', 3, 4]
  ];
  namedTransitions.forEach(([from, to, a, b]) => {
    const first = outH264(chainOut, a + 1);
    const second = outH264(chainOut, b + 1);
    if (!fs.existsSync(first) || !fs.existsSync(second)) return;
    const endOfFirst = samplePoint(first, 6.6, 270, 540);
    const startOfSecond = samplePoint(second, 0.35, 270, 540);
    const endRight = samplePoint(first, 6.6, 810, 540);
    const startRight = samplePoint(second, 0.35, 810, 540);
    check(
      colorsMatch(endOfFirst, chainClips[a].tailRgb, 50) &&
        colorsMatch(startOfSecond, chainClips[b].headRgb, 45) &&
        !colorsMatch(startOfSecond, chainClips[a].tailRgb, 40),
      `переход ${from} → ${to}: конец es${a + 1} = 20% ${from}, начало es${b + 1} = 80% ${to}`,
      `end=${endOfFirst} start=${startOfSecond}`
    );
    check(
      colorsMatch(endRight, closeupChapters[a].rgb, 45) &&
        colorsMatch(startRight, closeupChapters[b].rgb, 45) &&
        !colorsMatch(startRight, closeupChapters[a].rgb, 35),
      `переход ${from} → ${to} справа: крупный план продолжается, хвост ${from} не повторяется в начале ${to}`,
      `endR=${endRight} startR=${startRight}`
    );
  });

  console.log('\n6) Проверяем остановку обработки…');
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const stopBatch = new BatchProcessor(
    {
      sourceDir: SOURCE_DIR,
      shortsFile: shorts,
      useOverlay: false,
      outputDir: OUTPUT_DIR,
      frame: 'source',
      percent: 90,
      encoder: 'prores',
      verbose: false
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );

  const stopPromise = stopBatch.run();
  setTimeout(() => stopBatch.stop(), 1200);
  const stopSummary = await stopPromise;

  check(stopSummary.cancelled === true, 'обработка помечена как остановленная');
  check(stopSummary.done < 3, 'остановка прервала очередь', `done=${stopSummary.done}`);
  check(
    !fs.existsSync(path.join(OUTPUT_DIR, `es${stopSummary.done + 1}.mov`)),
    'недописанный файл удалён'
  );

  console.log('\n7) Проверяем ProRes и работу без оверлея…');
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  const proresBatch = new BatchProcessor(
    {
      sourceDir: SOURCE_DIR,
      shortsFile: shorts,
      useOverlay: false,
      outputDir: OUTPUT_DIR,
      frame: 'source',
      percent: 50,
      encoder: 'prores',
      verbose: false
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );
  const proresSummary = await proresBatch.run();
  check(proresSummary.done === 2, 'ProRes: два файла готовы', `done=${proresSummary.done}`);
  const proresInfo = await probeMedia(path.join(OUTPUT_DIR, 'es1.mov'));
  check(proresInfo.videoCodec === 'prores', 'ProRes: кодек в результате верный', proresInfo.videoCodec);

  console.log(`\nИтог: ${failures ? `${failures} проверок провалено` : 'все проверки пройдены'}`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nСмоук-тест упал:', err);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
