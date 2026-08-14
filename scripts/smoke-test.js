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

const {
  BatchProcessor,
  ffmpegPath,
  probeMedia,
  listVideoFiles
} = require('../processor');

const ROOT = path.join(os.tmpdir(), `shorts-inserter-smoke-${process.pid}`);
const SOURCE_DIR = path.join(ROOT, 'source');
const OUTPUT_DIR = path.join(ROOT, 'output');
const ASSETS_DIR = path.join(ROOT, 'assets');

let failures = 0;

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

function makeSolidVideo({ file, color, width, height, duration, fps }) {
  ffmpegRun([
    '-f', 'lavfi',
    '-i', `color=c=${color}:size=${width}x${height}:rate=${fps}:duration=${duration}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
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

  const out1 = path.join(OUTPUT_DIR, 'es1.mov');
  const out2 = path.join(OUTPUT_DIR, 'es2.mov');
  check(fs.existsSync(out1), 'создан es1.mov');
  check(fs.existsSync(out2), 'создан es2.mov');
  check(!fs.existsSync(path.join(OUTPUT_DIR, 'es3.mov')), 'битый файл не оставил мусорный es3.mov');

  const info1 = await probeMedia(out1);
  const info2 = await probeMedia(out2);

  check(
    Math.abs(info1.duration - 8) < 0.6,
    'es1.mov = исходник 6с + shorts 2с',
    `${info1.duration.toFixed(2)}s`
  );
  check(
    Math.abs(info2.duration - 6) < 0.6,
    'es2.mov = исходник 4с + shorts 2с',
    `${info2.duration.toFixed(2)}s`
  );
  check(
    info1.width === 1280 && info1.height === 720,
    'es1.mov сохранил разрешение исходника 1280x720',
    `${info1.width}x${info1.height}`
  );
  check(
    info2.width === 640 && info2.height === 480,
    'es2.mov сохранил разрешение исходника 640x480',
    `${info2.width}x${info2.height}`
  );
  check(info1.hasAudio && info2.hasAudio, 'у обоих результатов есть звуковая дорожка (немой исходник дополнен тишиной)');

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
      percent: 75,
      encoder: 'h264'
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );
  await colorBatch.run();

  // 4 c исходника + 2 c shorts, точка вставки на третьей секунде.
  const montage = path.join(colorOut, 'es1.mov');
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
      percent: 75,
      encoder: 'h264'
    },
    { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
  );
  await overlayBatch.run();

  // Белый оверлей на 50% осветляет каждый сегмент; длится он 1 с, значит дальше идёт луп.
  const blended = path.join(overlayOut, 'es1.mov');
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

  // Кадр 1920x1080 из полос по 480 px: у левой половины сдвиг -25% (это -480 px),
  // значит в неё должны попасть вторая и третья полосы исходника.
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

  const runSplit = async (outputDir, feather) => {
    const batch = new BatchProcessor(
      {
        sourceDir: splitDir,
        shortsFile: greenShorts,
        useOverlay: false,
        useSplit: true,
        closeupFile: stripedCloseup,
        split: { leftShare: 50, feather, leftZoom: 1, leftOffset: -25, rightZoom: 1.8, rightOffset: 25 },
        outputDir,
        percent: 75,
        encoder: 'h264'
      },
      { onLog: (level, message) => console.log(`    [${level}] ${message}`) }
    );
    const result = await batch.run();
    return { result, file: path.join(outputDir, 'es1.mov') };
  };

  const hard = await runSplit(splitOut, 0);
  check(hard.result.done === 1, 'split-screen: файл собран', `done=${hard.result.done}`);

  const splitInfo = await probeMedia(hard.file);
  check(
    splitInfo.width === 1920 && splitInfo.height === 1080,
    'split-screen: размер кадра не изменился',
    `${splitInfo.width}x${splitInfo.height}`
  );

  // Левая половина без зума со сдвигом -480 px показывает полосы 2 и 3.
  check(colorsMatch(samplePoint(hard.file, 1, 240, 540), [0, 255, 0]),
    'левая половина сдвинута: в четверти кадра вторая полоса исходника',
    String(samplePoint(hard.file, 1, 240, 540)));
  check(colorsMatch(samplePoint(hard.file, 1, 720, 540), [0, 0, 255]),
    'левая половина сдвинута: у границы третья полоса исходника',
    String(samplePoint(hard.file, 1, 720, 540)));

  // Правая половина: зум 1.8 и сдвиг +480 показывают полосы 2 и 3 второго видео.
  check(colorsMatch(samplePoint(hard.file, 1, 1000, 540), [0, 255, 255]),
    'правая половина: зум и сдвиг дают ожидаемый кусок второго видео',
    String(samplePoint(hard.file, 1, 1000, 540)));
  check(colorsMatch(samplePoint(hard.file, 1, 1800, 540), [255, 255, 255]),
    'правая половина: у правого края видна следующая полоса второго видео',
    String(samplePoint(hard.file, 1, 1800, 540)));

  // Граница без смягчения должна быть резкой.
  check(colorsMatch(samplePoint(hard.file, 1, 950, 540), [0, 0, 255]),
    'чёткая граница: слева от стыка ещё исходник',
    String(samplePoint(hard.file, 1, 950, 540)));
  check(colorsMatch(samplePoint(hard.file, 1, 970, 540), [0, 255, 255]),
    'чёткая граница: справа от стыка уже второе видео',
    String(samplePoint(hard.file, 1, 970, 540)));

  // Shorts в середине ролика тоже попадает в левую половину.
  check(colorsMatch(samplePoint(hard.file, 4, 240, 540), [0, 255, 0]),
    'split-screen: в середине слева играет Shorts',
    String(samplePoint(hard.file, 4, 240, 540)));

  const softOut = path.join(ROOT, 'split-out-soft');
  const soft = await runSplit(softOut, 40);
  check(soft.result.done === 1, 'мягкая граница: файл собран', `done=${soft.result.done}`);

  const seam = samplePoint(soft.file, 1, 940, 540);
  check(colorsMatch(samplePoint(soft.file, 1, 900, 540), [0, 0, 255], 40),
    'мягкая граница: до растушёвки чистый исходник',
    String(samplePoint(soft.file, 1, 900, 540)));
  check(
    seam[1] > 60 && seam[1] < 200 && seam[2] > 150,
    'мягкая граница: в середине стыка половины смешаны',
    `rgb=${seam}`
  );
  check(colorsMatch(samplePoint(soft.file, 1, 1000, 540), [0, 255, 255], 40),
    'мягкая граница: за стыком чистое второе видео',
    String(samplePoint(soft.file, 1, 1000, 540)));

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

  const combo = path.join(comboOut, 'es1.mov');
  check(colorsMatch(samplePoint(combo, 1, 160, 180), [128, 128, 0], 40),
    'сплит + оверлей: слева исходник, смешанный с оверлеем',
    String(samplePoint(combo, 1, 160, 180)));
  check(colorsMatch(samplePoint(combo, 1, 480, 180), [128, 255, 128], 40),
    'сплит + оверлей: справа второе видео, смешанное с оверлеем',
    String(samplePoint(combo, 1, 480, 180)));

  console.log('\n6) Проверяем остановку обработки…');
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const stopBatch = new BatchProcessor(
    {
      sourceDir: SOURCE_DIR,
      shortsFile: shorts,
      useOverlay: false,
      outputDir: OUTPUT_DIR,
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
