'use strict';

/**
 * Проверка режима «Максимум скорости» и изоляции вкладок без интерфейса.
 *
 *   npm run smoke:parallel
 *
 * - лимит рендер-слотов, общий для всех вкладок (EncodeSlots);
 * - параллельный рендер нескольких файлов одной вкладки;
 * - две «вкладки» рендерят одновременно в разные папки с разными префиксами;
 * - остановка посреди параллельного рендера не оставляет недописанных файлов;
 * - крупный план справа идёт по таймлайну и при параллельном рендере;
 * - маска мягкой границы считается один раз, а не на каждом кадре.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  BatchProcessor,
  EncodeSlots,
  ffmpegPath,
  probeMedia,
  resolveEncodePlan,
  resolveParallelJobs,
  threadBudget,
  handoffDelayMs,
  buildFeatherMaskFilter,
  DEFAULTS,
  RESOURCE_MODES
} = require('../processor');

const ROOT = path.join(os.tmpdir(), `shorts-inserter-parallel-${process.pid}`);
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

function makeSolidVideo({ file, color, width, height, duration, fps, withAudio = true }) {
  const args = ['-f', 'lavfi', '-i', `color=c=${color}:size=${width}x${height}:rate=${fps}:duration=${duration}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=330:duration=${duration}`, '-c:a', 'aac', '-shortest');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file);
  ffmpegRun(args);
}

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

function colorsMatch(actual, expected, tolerance = 40) {
  return actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function testSlots() {
  console.log('\n1) Общий лимит рендер-слотов…');
  const slots = new EncodeSlots(8);
  check(slots.total === 4, 'на 8 ядрах одновременно до 4 кодирований на всё приложение', `total=${slots.total}`);
  check(new EncodeSlots(2).total === 3, 'на слабом ПК всё равно 3 слота — вкладки не стоят в очереди друг за другом');

  const tabA = {};
  const tabB = {};
  const r1 = await slots.acquire(tabA, false);
  const r2 = await slots.acquire(tabA, false);
  const r3 = await slots.acquire(tabB, false);
  const r4 = await slots.acquire(tabB, false);
  check(slots.active === 4, 'четыре слота выданы сразу');

  let fifthGranted = false;
  const fifth = slots.acquire(tabB, false).then((release) => {
    fifthGranted = true;
    return release;
  });
  let cancelledWaiter = false;
  slots.acquire(tabA, false).catch((err) => {
    cancelledWaiter = Boolean(err && err.cancelled);
  });
  await tick();
  check(!fifthGranted && slots.waiters.length === 2, 'пятый файл ждёт свободный слот');

  slots.cancel(tabA);
  await tick();
  check(cancelledWaiter && slots.waiters.length === 1, 'остановка вкладки снимает только её ожидающие файлы');

  r1();
  const r5 = await fifth;
  check(fifthGranted && slots.active === 4, 'освободившийся слот сразу уходит следующему в очереди');
  r1();
  check(slots.active === 4, 'повторный release не ломает счётчик');
  [r2, r3, r4, r5].forEach((release) => release());
  check(slots.active === 0 && slots.gpuActive === 0, 'все слоты вернулись');

  const g1 = await slots.acquire(tabA, true);
  const g2 = await slots.acquire(tabA, true);
  const g3 = await slots.acquire(tabB, true);
  let gpuFourth = false;
  const g4p = slots.acquire(tabB, true).then((release) => {
    gpuFourth = true;
    return release;
  });
  let cpuGranted = false;
  const c1p = slots.acquire(tabB, false).then((release) => {
    cpuGranted = true;
    return release;
  });
  await tick();
  check(!gpuFourth && cpuGranted, 'GPU-сессий не больше трёх, CPU-файл при этом не ждёт GPU-очередь');
  slots.lowerGpuCap(1);
  check(slots.gpuCap === 1, 'после отказа видеокарты число GPU-сессий уменьшается');
  g1();
  g2();
  await tick();
  check(!gpuFourth, 'при пониженном лимите новая GPU-сессия ждёт');
  g3();
  const g4 = await g4p;
  check(gpuFourth, 'GPU-сессия стартует, когда лимит позволяет');
  g4();
  (await c1p)();
}

function testPlans() {
  console.log('\n2) Режим «Максимум скорости»…');
  check(DEFAULTS.resourceUsage === 'max' && Boolean(RESOURCE_MODES.max), 'по умолчанию — максимум скорости');
  const hw = { h264: null, h265: null, cores: 8 };
  const nv = {
    h264: { id: 'h264_nvenc', vendor: 'NVIDIA NVENC', extra: [] },
    h265: { id: 'hevc_nvenc', vendor: 'NVIDIA NVENC', extra: [] },
    cores: 8
  };
  const maxCpu = resolveEncodePlan('h264', { exportMode: 'auto', resourceUsage: 'max', jobs: 2 }, hw);
  const maxGpu = resolveEncodePlan('auto', { exportMode: 'auto', resourceUsage: 'max', jobs: 2 }, nv);
  check(!maxCpu.pace && !maxGpu.pace, 'в режиме max нет искусственного потолка чтения (-readrate)');
  check(handoffDelayMs(maxCpu) === 0 && handoffDelayMs(maxGpu) === 0, 'в режиме max нет пауз между файлами');
  check(maxCpu.threads.encodeThreads === 4, 'ядра делятся между параллельными файлами', `threads=${maxCpu.threads.encodeThreads}`);
  const single = threadBudget('max', 16, false, 1);
  check(single.encodeThreads === 16, 'один файл в режиме max получает все ядра', `threads=${single.encodeThreads}`);

  check(resolveParallelJobs('auto', { resourceUsage: 'balanced', cores: 16 }) === 1, 'в режиме «Баланс» по-прежнему по одному файлу');
  check(resolveParallelJobs('auto', { resourceUsage: 'max', usingGpu: true, cores: 8 }) === 2, 'max + GPU на 8 ядрах: 2 файла сразу');
  check(resolveParallelJobs('auto', { resourceUsage: 'max', usingGpu: false, cores: 12 }) === 3, 'max + CPU на 12 ядрах: 3 файла сразу');
  check(resolveParallelJobs('auto', { resourceUsage: 'max', usingGpu: false, cores: 4 }) === 1, 'max на 4 ядрах: 1 файл, но без ограничений');
  check(resolveParallelJobs(3, { resourceUsage: 'low', cores: 4 }) === 3, 'явное число файлов соблюдается в любом режиме');
  check(resolveParallelJobs('9', { resourceUsage: 'max', cores: 64 }) === 4, 'не больше 4 файлов на вкладку');
}

async function testMaskSpeed() {
  console.log('\n3) Маска мягкой границы…');
  const opts = { width: 588, height: 1080, fps: 30, duration: 20, feather: 48, outputLabel: 'm' };
  const graph = buildFeatherMaskFilter(opts);
  check(graph.includes('loop=loop=-1:size=1') && graph.includes('trim=end_frame=1'), 'geq считается на одном кадре и повторяется через loop');

  const denom = (opts.feather - 1).toFixed(1);
  const oldGraph =
    `color=c=black:s=${opts.width}x${opts.height}:r=${opts.fps}:d=${opts.duration + 1},` +
    `format=gray,geq=lum='255*(0.5-0.5*cos(PI*clip(X/${denom},0,1)))'[m]`;
  const run = (text) => {
    const started = Date.now();
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-filter_complex', text, '-map', '[m]', '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    return Date.now() - started;
  };
  const oldMs = run(oldGraph);
  const newMs = run(graph);
  console.log(`  маска 588x1080, 21 с @30fps: было ${oldMs} мс, стало ${newMs} мс`);
  check(newMs < oldMs, 'новая маска быстрее старой', `old=${oldMs} new=${newMs}`);
}

function makeSources(dir, count, color) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= count; i += 1) {
    makeSolidVideo({ file: path.join(dir, `clip${i}.mp4`), color, width: 640, height: 360, duration: 3, fps: 30 });
  }
}

async function testParallelBatch(assets) {
  console.log('\n4) Параллельный рендер одной вкладки…');
  const src = path.join(ROOT, 'par-src');
  const out = path.join(ROOT, 'par-out');
  makeSources(src, 5, 'red');
  const logs = [];
  let maxActive = 0;
  const batch = new BatchProcessor(
    {
      sourceDir: src,
      shortsFile: assets.shorts,
      outputDir: out,
      outputPrefix: 'en',
      frame: 'source',
      percent: 50,
      encoder: 'h264',
      resourceUsage: 'max',
      parallelJobs: 3
    },
    {
      onLog: (level, message) => logs.push(`${level}: ${message}`),
      onProgress: (state) => {
        maxActive = Math.max(maxActive, Number(state.active) || 0);
      }
    }
  );
  const summary = await batch.run();
  check(summary.done === 5 && summary.failed === 0, 'все 5 файлов готовы', `done=${summary.done} failed=${summary.failed}`);
  check(maxActive >= 2, 'файлы действительно кодировались одновременно', `maxActive=${maxActive}`);
  check(logs.some((line) => line.includes('параллельно 3')), 'в логе указано число параллельных файлов');
  const names = fs.readdirSync(out).sort();
  check(
    names.join(',') === ['en1.mp4', 'en2.mp4', 'en3.mp4', 'en4.mp4', 'en5.mp4'].join(','),
    'нумерация и префикс вкладки сохранены при параллельном рендере',
    names.join(',')
  );
  for (let i = 1; i <= 5; i += 1) {
    const info = await probeMedia(path.join(out, `en${i}.mp4`));
    if (Math.abs(info.duration - 4) > 0.3) {
      check(false, `en${i}.mp4 длительность 3с + 1с Shorts`, `duration=${info.duration}`);
    }
  }
  check(true, 'длительность каждого файла = исходник + Shorts');
}

async function testTwoTabs(assets) {
  console.log('\n5) Две вкладки рендерят одновременно…');
  const tabs = [
    { prefix: 'es', src: path.join(ROOT, 'es-src'), out: path.join(ROOT, 'es-out'), color: 'red' },
    { prefix: 'ru', src: path.join(ROOT, 'ru-src'), out: path.join(ROOT, 'ru-out'), color: 'blue' }
  ];
  tabs.forEach((tab) => makeSources(tab.src, 3, tab.color));
  const results = await Promise.all(tabs.map((tab) => new BatchProcessor(
    {
      sourceDir: tab.src,
      shortsFile: assets.shorts,
      outputDir: tab.out,
      outputPrefix: tab.prefix,
      frame: 'source',
      percent: 50,
      encoder: 'h264',
      resourceUsage: 'max',
      parallelJobs: 2
    },
    { onLog: () => {} }
  ).run()));
  check(results.every((summary) => summary.done === 3 && summary.failed === 0), 'обе вкладки собрали по 3 файла');
  check(
    fs.readdirSync(tabs[0].out).every((name) => name.startsWith('es')) &&
      fs.readdirSync(tabs[1].out).every((name) => name.startsWith('ru')),
    'файлы вкладок не смешались: у каждой своя папка и свой префикс'
  );
  const esColor = samplePoint(path.join(tabs[0].out, 'es1.mp4'), 0.3, 320, 180);
  const ruColor = samplePoint(path.join(tabs[1].out, 'ru1.mp4'), 0.3, 320, 180);
  check(colorsMatch(esColor, [255, 0, 0]) && colorsMatch(ruColor, [0, 0, 255]), 'каждая вкладка взяла свои исходники', `es=${esColor} ru=${ruColor}`);
}

async function testStop(assets) {
  console.log('\n6) Остановка параллельного рендера…');
  const src = path.join(ROOT, 'stop-src');
  const out = path.join(ROOT, 'stop-out');
  fs.mkdirSync(src, { recursive: true });
  for (let i = 1; i <= 4; i += 1) {
    makeSolidVideo({ file: path.join(src, `long${i}.mp4`), color: 'yellow', width: 1280, height: 720, duration: 20, fps: 30 });
  }
  let stopped = false;
  const batch = new BatchProcessor(
    {
      sourceDir: src,
      shortsFile: assets.shorts,
      outputDir: out,
      outputPrefix: 'pt',
      frame: 'source',
      percent: 50,
      encoder: 'h264',
      exportMode: 'quality',
      resourceUsage: 'max',
      parallelJobs: 2
    },
    {
      onLog: () => {},
      onProgress: (state) => {
        if (!stopped && Number(state.active) >= 2 && Number(state.filePercent) > 3) {
          stopped = true;
          batch.stop();
        }
      }
    }
  );
  const summary = await batch.run();
  check(stopped && summary.cancelled, 'остановка сработала во время параллельного рендера');
  const leftovers = fs.existsSync(out) ? fs.readdirSync(out) : [];
  check(leftovers.length === summary.done, 'недописанные файлы удалены, готовые остались', `files=${leftovers.join(',')} done=${summary.done}`);
}

async function testCloseupTimeline(assets) {
  console.log('\n7) Крупный план справа при параллельном рендере…');
  const src = path.join(ROOT, 'cu-src');
  const out = path.join(ROOT, 'cu-out');
  fs.mkdirSync(src, { recursive: true });
  for (let i = 1; i <= 3; i += 1) {
    makeSolidVideo({ file: path.join(src, `c${i}.mp4`), color: 'gray', width: 640, height: 640, duration: 2, fps: 30 });
  }
  const closeup = path.join(ROOT, 'closeup.mp4');
  // 3 с на ролик (2 с исходника + 1 с Shorts): красный, зелёный, синий.
  ffmpegRun([
    '-filter_complex',
    'color=c=red:s=640x640:r=30:d=3[a];color=c=lime:s=640x640:r=30:d=3[b];color=c=blue:s=640x640:r=30:d=3[c];' +
      '[a][b][c]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1', '-pix_fmt', 'yuv420p', closeup
  ]);
  const summary = await new BatchProcessor(
    {
      sourceDir: src,
      shortsFile: assets.shorts,
      outputDir: out,
      outputPrefix: 'br',
      frame: 'square1080',
      percent: 50,
      encoder: 'h264',
      resourceUsage: 'max',
      parallelJobs: 3,
      useSplit: true,
      closeupFile: closeup,
      split: { leftShare: 50, feather: 0, leftZoom: 1, leftOffset: 0, rightZoom: 1, rightOffset: 0 }
    },
    { onLog: () => {} }
  ).run();
  check(summary.done === 3, 'три сплит-ролика готовы параллельно');
  const expected = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const actual = [1, 2, 3].map((n) => samplePoint(path.join(out, `br${n}.mp4`), 1.5, 810, 540));
  check(
    actual.every((color, i) => colorsMatch(color, expected[i], 60)),
    'каждый следующий ролик продолжает крупный план с того места, где закончился предыдущий',
    actual.map((c) => c.join('/')).join(' | ')
  );
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  const assets = { shorts: path.join(ROOT, 'shorts.mp4') };
  makeSolidVideo({ file: assets.shorts, color: 'lime', width: 360, height: 640, duration: 1, fps: 30 });

  await testSlots();
  testPlans();
  await testMaskSpeed();
  await testParallelBatch(assets);
  await testTwoTabs(assets);
  await testStop(assets);
  await testCloseupTimeline(assets);

  console.log(`\nИтог: ${failures ? `${failures} проверок провалено` : 'все проверки параллельного режима пройдены'}`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nСмоук-тест упал:', err);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
