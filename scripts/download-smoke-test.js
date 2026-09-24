'use strict';

/**
 * Проверка очереди скачивания без реальных запросов к YouTube.
 *
 *   node scripts/download-smoke-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DownloadQueue,
  MAX_CONCURRENT_DOWNLOADS,
  MAX_PARALLEL_DOWNLOADS,
  normalizeConcurrency,
  parseSpeedBytes,
  parseLinkList,
  extractVideoId,
  retryDelayMs,
  classifyError,
  sanitizeFilename,
  selectBestFormats,
  parseProgressLine,
  buildYtDlpDownloadArgs,
  buildBaseYtDlpArgs,
  buildAria2cDownloaderArgs,
  resolveJsRuntimeArgs,
  isBotCheckError,
  isCookieError,
  cookieBrowserCandidates,
  shouldLogYtDlpLine,
  mergeUrlsIntoQueue,
  YOUTUBE_EXTRACTOR_ARGS,
  FALLBACK_FORMAT,
  SOCKET_TIMEOUT_SEC,
  DOWNLOAD_RETRIES,
  FRAGMENT_RETRIES,
  HTTP_CHUNK_SIZE,
  ARIA2_DOWNLOADER_ARGS,
  STATUS
} = require('../downloader');

const ROOT = path.join(os.tmpdir(), `shorts-download-smoke-${process.pid}`);
let failures = 0;

function check(condition, description, details = '') {
  if (condition) {
    console.log(`  OK   ${description}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${description}${details ? ` — ${details}` : ''}`);
  }
}

function fakeFormats() {
  return [
    { format_id: '136', height: 720, width: 1280, fps: 30, vcodec: 'avc1.4d401f', acodec: 'none', vbr: 1200 },
    { format_id: '137', height: 1080, width: 1920, fps: 60, vcodec: 'avc1.640028', acodec: 'none', vbr: 4000 },
    { format_id: '271', height: 1440, width: 2560, fps: 60, vcodec: 'vp9', acodec: 'none', vbr: 8000 },
    { format_id: '140', height: null, vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, asr: 44100 },
    { format_id: '251', height: null, vcodec: 'none', acodec: 'opus', abr: 160, asr: 48000 },
    { format_id: '22', height: 720, width: 1280, fps: 30, vcodec: 'avc1', acodec: 'mp4a.40.2', tbr: 2000 }
  ];
}

function writeDummyVideo(file) {
  const payload = Buffer.alloc(8192, 7);
  fs.writeFileSync(file, payload);
}

function createMockRunner(options = {}) {
  const failOnce = new Set(options.failOnce || []);
  const failAlways = new Set(options.failAlways || []);
  const gone = new Set(options.permanent || []);
  let active = 0;
  let maxActive = 0;
  const started = [];

  const runner = async (args, onLine) => {
    const url = args[args.length - 1];
    const id = extractVideoId(url) || url;
    if (args.includes('-J')) {
      if (gone.has(id)) throw new Error('Video unavailable');
      return {
        stdout: JSON.stringify({
          id,
          title: options.titles && options.titles[id] ? options.titles[id] : `Title ${id}`,
          formats: fakeFormats()
        }),
        stderr: ''
      };
    }

    active += 1;
    maxActive = Math.max(maxActive, active);
    started.push(id);
    try {
      if (gone.has(id)) throw new Error('Video unavailable');
      if (failAlways.has(id)) throw new Error('HTTP Error 503: Service Unavailable');
      if (failOnce.has(id)) {
        failOnce.delete(id);
        throw new Error('Connection reset by peer');
      }
      const delay = options.delays && options.delays[id];
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const outFlag = args.indexOf('-o');
      const template = outFlag >= 0 ? args[outFlag + 1] : path.join(options.outputDir, `${id}.mp4`);
      const file = String(template).replace('%(ext)s', 'mp4');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeDummyVideo(file);
      const title = options.titles && options.titles[id] ? options.titles[id] : `Title ${id}`;
      fs.writeFileSync(`${file.replace(/\.mp4$/i, '')}.info.json`, JSON.stringify({ id, title, formats: fakeFormats() }));
      if (typeof onLine === 'function') {
        onLine('[youtube] Extracting URL: ' + url);
        onLine('[download] Destination: ' + file);
        onLine('[download]  42.3% of  12.34MiB at    8.40MiB/s ETA 00:18');
        onLine('PROGRESS 87.5% 2.10MiB/s 00:04');
      }
      return { stdout: `${file}\n`, stderr: '' };
    } finally {
      active -= 1;
    }
  };

  runner.stats = () => ({ maxActive, started });
  return runner;
}

async function main() {
  console.log('1) Разбор ссылок, форматов и ошибок…');
  const parsed = parseLinkList(`
    https://youtube.com/shorts/AAAAAAAAAAA
    https://www.youtube.com/watch?v=AAAAAAAAAAA
    https://youtu.be/BBBBBBBBBBB
      https://youtube.com/shorts/CCCCCCCCCCC  
    https://youtube.com/shorts/BBBBBBBBBBB

    not-a-link
  `);
  check(parsed.length === 3, 'пустые строки, пробелы и дубликаты убраны, порядок сохранён', String(parsed.length));
  check(extractVideoId(parsed[0]) === 'AAAAAAAAAAA', 'shorts URL нормализуется в video id');
  check(extractVideoId('https://www.youtube.com/watch?v=XXXXXXXXXXX&t=12s') === 'XXXXXXXXXXX', 'id извлекается из query');

  check(retryDelayMs(1) === 30_000, 'retry 1 = 30с');
  check(retryDelayMs(2) === 60_000, 'retry 2 = 60с');
  check(retryDelayMs(3) === 120_000, 'retry 3 = 120с');
  check(retryDelayMs(4) === 300_000, 'retry 4 = 300с');
  check(retryDelayMs(5) === 600_000, 'retry 5+ = 600с');
  check(retryDelayMs(12) === 600_000, 'длинная серия попыток не растёт бесконечно');

  check(classifyError('HTTP Error 503') === 'TEMPORARY', 'HTTP 5xx — временная ошибка');
  check(classifyError('Connection reset by peer') === 'TEMPORARY', 'обрыв сети — временная');
  check(classifyError('Video unavailable') === 'PERMANENT', 'удалённое видео — постоянная');
  check(classifyError('This video is private') === 'PERMANENT', 'приватное видео — постоянная');
  check(classifyError('HTTP Error 404') === 'PERMANENT', '404 — постоянная');

  check(sanitizeFilename('MAMÁ ME CULPA 😱 #roblox') === 'MAMÁ ME CULPA 😱 roblox', 'unicode сохраняется, # убирается из имени файла');
  check(!/[<>:"/\\|?*#]/.test(sanitizeFilename('a<b>:c/d|e?f*g#h')), 'запрещённые Windows-символы и # вычищены');
  check(sanitizeFilename('con') === '_con', 'зарезервированное имя Windows не используется');

  const best = selectBestFormats(fakeFormats());
  check(best.video && best.video.format_id === '271', 'лучшее видео — максимальное разрешение 1440p', best.video && best.video.format_id);
  check(best.audio && best.audio.format_id === '251', 'лучшее аудио — максимальный bitrate', best.audio && best.audio.format_id);
  check(best.format === '271+251', 'формат bestvideo+bestaudio', best.format);
  check(best.preferMp4 === false, 'VP9+Opus не форсируем в MP4 перекодированием');

  const mp4Only = selectBestFormats([
    { format_id: '137', height: 1080, width: 1920, fps: 60, vcodec: 'avc1.640028', acodec: 'none', vbr: 4000 },
    { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, asr: 44100 }
  ]);
  check(mp4Only.preferMp4 === true, 'H.264+AAC можно склеить в MP4 без перекодирования');

  const progress = parseProgressLine('[download]  42.3% of  12.34MiB at    8.40MiB/s ETA 00:18');
  check(progress && progress.percent === 42.3 && progress.speed.includes('8.40'), 'строка прогресса yt-dlp разбирается');
  const approx = parseProgressLine('[download]  12.3% of ~  45.00MiB at  1.23MiB/s ETA 00:32 (frag 3/20)');
  check(approx && approx.percent === 12.3 && approx.speed.includes('1.23'), 'прогресс с ~ и фрагментами разбирается');
  const unknown = parseProgressLine('[download]   1.0% of   12.34MiB at  Unknown ETA Unknown');
  check(unknown && unknown.percent === 1 && unknown.speed === '' && unknown.eta === '', 'Unknown скорость не ломает процент');
  const custom = parseProgressLine('PROGRESS 87.5% 2.10MiB/s 00:04');
  check(custom && custom.percent === 87.5 && custom.speed.includes('2.10'), 'кастомный PROGRESS-шаблон разбирается');
  check(!parseProgressLine('[download] Destination: C:\\out\\video.mp4'), 'строка Destination не считается прогрессом');
  check(shouldLogYtDlpLine('[youtube] Extracting URL: https://youtu.be/x'), 'строки youtube попадают в лог');
  check(!shouldLogYtDlpLine('[download]  42.3% of  12.34MiB at    8.40MiB/s ETA 00:18'), 'процент в лог не спамится');

  const dlArgs = buildYtDlpDownloadArgs({
    url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
    template: path.join(ROOT, '1_AAAAAAAAAAA.%(ext)s'),
    format: FALLBACK_FORMAT,
    ffmpegPath: 'ffmpeg',
    preferMp4: true
  });
  check(dlArgs.includes('--progress'), 'скачивание явно включает --progress');
  check(dlArgs.includes('--no-quiet'), 'скачивание не уходит в quiet');
  check(dlArgs.includes('--no-simulate'), 'скачивание не симулируется');
  check(!dlArgs.includes('--print'), 'не используем --print, который глушит прогресс');
  check(dlArgs.includes('--extractor-args'), 'youtube extractor-args заданы');
  check(dlArgs.includes('--windows-filenames'), 'имена файлов Windows-безопасные');
  check(dlArgs.includes('--write-info-json'), 'название берём из info.json после скачивания');
  check(dlArgs.includes(FALLBACK_FORMAT), 'формат как у Media Downloader, без format_id с FORMAT CHECK');
  check(dlArgs.includes('--ignore-config'), 'как Media Downloader: --ignore-config, без чужого yt-dlp.conf');
  check(SOCKET_TIMEOUT_SEC >= 45 && String(SOCKET_TIMEOUT_SEC) === String(dlArgs[dlArgs.indexOf('--socket-timeout') + 1]), 'socket-timeout не 20с — иначе googlevideo рвёт 1080p60');
  check(dlArgs.includes('--force-ipv4'), 'IPv4 для googlevideo — IPv6 на Windows часто даёт Read timed out');
  check(dlArgs.includes('--http-chunk-size') && dlArgs.includes(HTTP_CHUNK_SIZE), 'докачка кусками, чтобы таймаут не сбрасывал весь файл');
  check(Number(dlArgs[dlArgs.indexOf('--retries') + 1]) >= 15, 'повторы скачивания не меньше 15');
  check(Number(dlArgs[dlArgs.indexOf('--fragment-retries') + 1]) >= 15, 'повторы фрагментов не меньше 15');
  check(DOWNLOAD_RETRIES >= 15 && FRAGMENT_RETRIES >= 15, 'константы повторов согласованы');
  check(!dlArgs.includes('--throttled-rate'), 'throttled-rate убран — он сам рвал медленные куски');
  const ariaArgs = buildYtDlpDownloadArgs({
    url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
    template: path.join(ROOT, '1_AAAAAAAAAAA.%(ext)s'),
    format: FALLBACK_FORMAT,
    ffmpegPath: 'ffmpeg',
    preferMp4: true,
    aria2cPath: path.join(ROOT, 'aria2c.exe')
  });
  check(ariaArgs.includes('--downloader') && ariaArgs.includes('aria2c'), 'при наличии aria2c качаем им, как Media Downloader');
  check(ariaArgs.includes('dash,m3u8:native'), 'HLS/DASH остаются на нативном клиенте yt-dlp');
  check(
    ariaArgs.includes('--downloader-args') && String(ARIA2_DOWNLOADER_ARGS).includes('-x 8') && String(ARIA2_DOWNLOADER_ARGS).includes('--connect-timeout=8'),
    'aria2c: 8 соединений и connect 8с, а не один коннект на 60с к мёртвой ноде',
    ARIA2_DOWNLOADER_ARGS
  );
  check(buildAria2cDownloaderArgs(null).length === 0, 'без aria2c не подсовываем --downloader');
  const ariaProgress = parseProgressLine('[#2f4e1b 4.2MiB/32MiB(13%) CN:8 DL:1.2MiB ETA:23s]');
  check(ariaProgress && ariaProgress.percent === 13 && ariaProgress.speed.includes('1.2'), 'прогресс aria2c разбирается');
  check(
    YOUTUBE_EXTRACTOR_ARGS === 'youtube:player_client=default,-android_sdkless',
    'не форсируем сломанные tv/android_sdkless/web — из‑за них FORMAT CHECK падал на всех ссылках',
    YOUTUBE_EXTRACTOR_ARGS
  );
  check(isBotCheckError('Sign in to confirm you’re not a bot'), 'антибот YouTube распознаётся как временная ошибка');
  check(classifyError('Sign in to confirm you’re not a bot') === 'TEMPORARY', 'антибот не помечает ссылку как вечную ошибку');
  const jsArgs = resolveJsRuntimeArgs(process.execPath);
  check(
    jsArgs[0] === '--js-runtimes' && /^(deno|quickjs|node):/.test(jsArgs[1] || ''),
    'для YouTube передаём JS runtime (Deno рядом с yt-dlp или Node 22+)',
    String(jsArgs)
  );
  check(buildBaseYtDlpArgs({ ytdlpPath: process.execPath }).includes('--js-runtimes'), 'базовые аргументы yt-dlp включают JS runtime');

  check(MAX_CONCURRENT_DOWNLOADS === 1, 'одновременно качается только одно видео');

  const merged = mergeUrlsIntoQueue(
    [{ url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', videoId: 'AAAAAAAAAAA', status: STATUS.SUCCESS, number: 1 }],
    ['https://youtube.com/shorts/AAAAAAAAAAA', 'https://youtube.com/shorts/ZZZZZZZZZZZ']
  );
  check(merged.length === 2, 'уже известная ссылка не дублируется при импорте');
  check(merged[0].status === STATUS.SUCCESS, 'успешная запись не сбрасывается при повторном импорте');

  console.log('\n2) Очередь: успех, retry в конец, постоянная ошибка…');
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });

  const urls = [
    'https://youtube.com/shorts/AAAAAAAAAAA',
    'https://youtube.com/shorts/BBBBBBBBBBB',
    'https://youtube.com/shorts/GONE1111111',
    'https://youtube.com/shorts/CCCCCCCCCCC'
  ];
  const runner = createMockRunner({
    outputDir: ROOT,
    failOnce: ['AAAAAAAAAAA'],
    permanent: ['GONE1111111'],
    titles: {
      AAAAAAAAAAA: 'MAMÁ ME CULPA POR SUS PROPIOS ERRORES 😱 #roblox',
      BBBBBBBBBBB: 'FUERON CAMBIADAS AL NACER? #roblox',
      CCCCCCCCCCC: 'LE PREGUNTÉ EL COLOR FAVORITO DE UN VAMPIRO #roblox'
    }
  });

  let clock = 1_000_000;
  let lastPercent = 0;
  const seenDownloadArgs = [];
  const queue = new DownloadQueue({
    outputDir: ROOT,
    ffmpegPath: 'ffmpeg',
    ffprobePath: null,
    runner: async (args, onLine) => {
      if (!args.includes('-J')) seenDownloadArgs.push(args);
      return runner(args, onLine);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    hooks: {
      onProgress: (state) => {
        if (!state || !state.current || state.current.status !== 'DOWNLOADING') return;
        const pct = Number(state.current.percent);
        if (Number.isFinite(pct)) lastPercent = Math.max(lastPercent, pct);
      }
    }
  });
  queue.setLinks(urls.join('\n'));
  const summary = await queue.run();

  check(runner.stats().maxActive === 1, 'никогда не было двух активных загрузок', `max=${runner.stats().maxActive}`);
  check(summary.completed === 3, 'три видео скачаны успешно', `completed=${summary.completed}`);
  check(summary.permanent === 1, 'удалённое видео помечено как постоянная ошибка', `permanent=${summary.permanent}`);
  check(summary.retry === 0, 'временные ошибки докачались после retry', `retry=${summary.retry}`);
  check(lastPercent >= 87, 'прогресс с mock yt-dlp доходит до UI не нулём', `lastPercent=${lastPercent}`);
  check(seenDownloadArgs.length > 0 && seenDownloadArgs[0].includes('--progress'), 'реальный download-вызов идёт с --progress');
  check(seenDownloadArgs.every((args) => !args.includes('--print')), 'ни один download-вызов не использует --print');
  check(seenDownloadArgs.every((args) => args.includes(FALLBACK_FORMAT)), 'download не пинит format_id из FORMAT CHECK');
  check(seenDownloadArgs.every((args) => !args.includes('-J')), 'как Media Downloader: один yt-dlp, без предварительного -J');

  const titles = fs.readFileSync(path.join(ROOT, 'nazvaniya.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
  check(titles.length === 3, 'в nazvaniya.txt ровно три успешных названия', titles.join(' | '));
  check(titles.includes('MAMÁ ME CULPA POR SUS PROPIOS ERRORES 😱 #roblox'), 'unicode-название записано в UTF-8');
  check(!titles.some((line) => /GONE/i.test(line)), 'название неуспешного видео не попало в nazvaniya.txt');

  const started = runner.stats().started;
  const firstFailThenOthers = started[0] === 'AAAAAAAAAAA' && started.slice(1, 4).includes('BBBBBBBBBBB');
  check(firstFailThenOthers, 'после ошибки #1 очередь берёт следующие ссылки, а не стопорится');
  check(started.filter((id) => id === 'AAAAAAAAAAA').length === 2, 'неудачная ссылка вернулась в конец и скачалась со второй попытки');

  const saved = JSON.parse(fs.readFileSync(path.join(ROOT, 'download_queue.json'), 'utf8'));
  check(saved.items.every((item) => item.status !== STATUS.DOWNLOADING), 'после остановки нет зависшего DOWNLOADING');
  check(saved.items.filter((item) => item.status === STATUS.SUCCESS).length === 3, 'SUCCESS сохранён в download_queue.json');

  console.log('\n3) Продолжение после «перезапуска»…');
  const resumeRunner = createMockRunner({
    outputDir: ROOT,
    titles: { DDDDDDDDDDD: 'Новый ролик' }
  });
  const resumed = new DownloadQueue({
    outputDir: ROOT,
    ffmpegPath: 'ffmpeg',
    ffprobePath: null,
    runner: resumeRunner,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    }
  });
  resumed.setLinks(`${urls.join('\n')}\nhttps://youtube.com/shorts/DDDDDDDDDDD`);
  const before = resumeRunner.stats().started.length;
  const resumeSummary = await resumed.run();
  const downloadedAgain = resumeRunner.stats().started.filter((id) => ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'].includes(id));
  check(downloadedAgain.length === 0, 'уже скачанные видео не качаются повторно', downloadedAgain.join(','));
  check(resumeSummary.completed === 4, 'после перезапуска докачивается только новое', `completed=${resumeSummary.completed}`);
  check(before === 0 || resumeRunner.stats().started.includes('DDDDDDDDDDD'), 'новая ссылка пошла в работу');

  const titles2 = fs.readFileSync(path.join(ROOT, 'nazvaniya.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
  check(titles2.length === 4, 'повторный запуск не дублирует старые названия', `lines=${titles2.length}`);

  console.log('\n4) Пауза сохраняет очередь…');
  const pauseDir = path.join(ROOT, 'pause');
  fs.mkdirSync(pauseDir, { recursive: true });
  let pauseQueue = null;
  const stoppingRunner = createMockRunner({ outputDir: pauseDir });
  const originalRunner = stoppingRunner;
  pauseQueue = new DownloadQueue({
    outputDir: pauseDir,
    ffmpegPath: 'ffmpeg',
    ffprobePath: null,
    runner: async (args, onLine) => {
      const result = await originalRunner(args, onLine);
      if (!args.includes('-J')) pauseQueue.stop();
      return result;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    }
  });
  pauseQueue.setLinks('https://youtube.com/shorts/EEEEEEEEEEE\nhttps://youtube.com/shorts/FFFFFFFFFFF');
  const paused = await pauseQueue.run();
  check(paused.cancelled === true, 'STOP помечает очередь как остановленную');
  check(fs.existsSync(path.join(pauseDir, 'download_queue.json')), 'download_queue.json сохранён до выхода');
  check(paused.completed <= 1, 'после STOP очередь не докачивает остальные', `completed=${paused.completed}`);

  console.log('\n5) Без FORMAT CHECK, как Media Downloader…');
  const skipDir = path.join(ROOT, 'skip-check');
  fs.mkdirSync(skipDir, { recursive: true });
  const skipRunner = createMockRunner({
    outputDir: skipDir,
    titles: { SKIPCHECK01: 'После проверки формата' }
  });
  const skipLogs = [];
  let probeCalls = 0;
  const skipQueue = new DownloadQueue({
    outputDir: skipDir,
    ffmpegPath: 'ffmpeg',
    ffprobePath: null,
    runner: async (args, onLine) => {
      if (args.includes('-J')) {
        probeCalls += 1;
        throw new Error('FORMAT CHECK больше не должен вызываться');
      }
      return skipRunner(args, onLine);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    hooks: {
      onLog: (_level, message) => skipLogs.push(message)
    }
  });
  skipQueue.setLinks('https://youtube.com/shorts/SKIPCHECK01');
  const skipped = await skipQueue.run();
  check(skipped.completed === 1, 'скачивание идёт сразу, без предварительного -J', `completed=${skipped.completed}`);
  check(probeCalls === 0, 'yt-dlp -J (FORMAT CHECK) больше не вызывается');
  check(!skipLogs.some((line) => /FORMAT CHECK/i.test(line)), 'в логе нет FORMAT CHECK — очередь не молчит на пробе');
  const skipTitles = fs.readFileSync(path.join(skipDir, 'nazvaniya.txt'), 'utf8');
  check(skipTitles.includes('После проверки формата'), 'название взято из info.json после скачивания');

  console.log('\n6) Многопоточная загрузка…');
  check(normalizeConcurrency(0) === 1 && normalizeConcurrency(99) === MAX_PARALLEL_DOWNLOADS, 'число потоков ограничено 1…6');
  check(dlArgs.includes('--concurrent-fragments'), 'yt-dlp качает фрагменты DASH/HLS в несколько потоков');
  check(Math.round(parseSpeedBytes('8.40MiB/s') / 1024 / 1024 * 10) === 84, 'скорость yt-dlp разбирается для суммы');
  const parDir = path.join(ROOT, 'parallel');
  fs.mkdirSync(parDir, { recursive: true });
  const parIds = ['PAR00000001', 'PAR00000002', 'PAR00000003', 'PAR00000004', 'PAR00000005', 'PAR00000006', 'PAR00000007'];
  const parRunner = createMockRunner({
    outputDir: parDir,
    failOnce: ['PAR00000002'],
    // #1 самый долгий: остальные заканчивают раньше, но название #1 всё равно первое.
    delays: { PAR00000001: 300, PAR00000002: 40, PAR00000003: 60, PAR00000004: 30, PAR00000005: 50, PAR00000006: 20, PAR00000007: 10 },
    titles: Object.fromEntries(parIds.map((id, i) => [id, `Видео ${i + 1}`]))
  });
  let parClock = 5_000_000;
  let sawParallelProgress = false;
  const parSuccessOrder = [];
  const parQueue = new DownloadQueue({
    outputDir: parDir,
    ffmpegPath: 'ffmpeg',
    ffprobePath: null,
    runner: parRunner,
    concurrency: 3,
    now: () => parClock,
    sleep: async (ms) => {
      parClock += ms;
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    hooks: {
      onLog: (_level, message) => {
        const match = String(message).match(/^#(\d+) DOWNLOAD SUCCESS/);
        if (match) parSuccessOrder.push(Number(match[1]));
      },
      onProgress: (state) => {
        if (state && Array.isArray(state.active) && state.active.length > 1) sawParallelProgress = true;
      }
    }
  });
  // Заглушки не настоящие видео — без этого каждая загрузка уходила бы в retry.
  parQueue.probeOutput = async () => ({ hasVideo: true, hasAudio: true });
  parQueue.setLinks(parIds.map((id) => `https://youtube.com/shorts/${id}`).join('\n'));
  const t0 = Date.now();
  const parSummary = await parQueue.run();
  const parMs = Date.now() - t0;
  check(parRunner.stats().maxActive === 3, 'одновременно качаются ровно 3 видео', `max=${parRunner.stats().maxActive}`);
  check(parSummary.completed === parIds.length, 'все видео скачаны, включая retry', `completed=${parSummary.completed}`);
  check(sawParallelProgress, 'в интерфейс приходит прогресс нескольких загрузок сразу');
  const firstDone = parSuccessOrder.slice(0, 3);
  check(
    !firstDone.includes(1) && parSuccessOrder.length === parIds.length,
    'пока долгое #1 качается, остальные уже скачиваются параллельно',
    `${parSuccessOrder.join(',')} · ${parMs} мс`
  );
  const parTitles = fs.readFileSync(path.join(parDir, 'nazvaniya.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
  check(parTitles.length === parIds.length, 'в nazvaniya.txt все названия без дублей', parTitles.join(' | '));
  check(parTitles[0] === 'Видео 1', 'nazvaniya.txt в порядке очереди, а не в порядке завершения', parTitles.join(' | '));
  const parSaved = JSON.parse(fs.readFileSync(path.join(parDir, 'download_queue.json'), 'utf8'));
  check(parSaved.items.every((item) => item.status === STATUS.SUCCESS), 'в download_queue.json нет зависших DOWNLOADING');

  const stopDir = path.join(ROOT, 'parallel-stop');
  fs.mkdirSync(stopDir, { recursive: true });
  const stopRunner = createMockRunner({
    outputDir: stopDir,
    delays: { STOP0000001: 200, STOP0000002: 200, STOP0000003: 200, STOP0000004: 200 }
  });
  let stopQueue = null;
  let stopped = false;
  stopQueue = new DownloadQueue({
    outputDir: stopDir,
    ffmpegPath: 'ffmpeg',
    ffprobePath: null,
    concurrency: 2,
    runner: async (args, onLine) => {
      if (!stopped && !args.includes('-J')) {
        setTimeout(() => { stopped = true; stopQueue.stop(); }, 20);
      }
      return stopRunner(args, onLine);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)))
  });
  stopQueue.setLinks(['STOP0000001', 'STOP0000002', 'STOP0000003', 'STOP0000004'].map((id) => `https://youtube.com/shorts/${id}`).join('\n'));
  const stopSummary = await stopQueue.run();
  check(stopSummary.cancelled === true, 'STOP во время параллельной загрузки останавливает очередь');
  check(stopRunner.stats().started.length === 2, 'после STOP новые видео не стартуют', `started=${stopRunner.stats().started.length}`);

  console.log('\n7) YouTube просит вход, а cookies браузера не читаются…');
  check(isCookieError('ERROR: could not find chrome cookies database in "/home/u/.config/google-chrome"'), 'ошибка базы cookies распознаётся');
  check(isCookieError('ERROR: Could not copy Chrome cookie database'), 'занятая база cookies (браузер открыт) распознаётся');
  check(!isCookieError('HTTP Error 503'), 'обычная сетевая ошибка не считается ошибкой cookies');
  const cookieDir = path.join(ROOT, 'cookies');
  fs.mkdirSync(cookieDir, { recursive: true });
  const browsers = cookieBrowserCandidates();
  const workingBrowser = browsers[browsers.length - 1];
  const cookieCalls = [];
  const cookieBase = createMockRunner({ outputDir: cookieDir });
  const cookieQueue = new DownloadQueue({
    outputDir: cookieDir,
    ffmpegPath: 'ffmpeg',
    ffprobePath: null,
    concurrency: 2,
    runner: async (args, onLine) => {
      const i = args.indexOf('--cookies-from-browser');
      const browser = i >= 0 ? args[i + 1] : null;
      cookieCalls.push(browser);
      if (!browser) throw new Error('ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser');
      if (browser !== workingBrowser) throw new Error(`ERROR: could not find ${browser} cookies database`);
      return cookieBase(args, onLine);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)))
  });
  cookieQueue.probeOutput = async () => ({ hasVideo: true, hasAudio: true });
  cookieQueue.setLinks('https://youtube.com/shorts/COOKIE00001\nhttps://youtube.com/shorts/COOKIE00002');
  const cookieSummary = await cookieQueue.run();
  check(cookieSummary.completed === 2, `после отказа браузеров cookies взяты из ${workingBrowser}`, `completed=${cookieSummary.completed} calls=${cookieCalls.join(',')}`);
  check(cookieCalls.length <= 2 * (browsers.length + 1), 'нерабочие браузеры не пробуются по кругу', cookieCalls.join(','));

  const noCookieDir = path.join(ROOT, 'no-cookies');
  fs.mkdirSync(noCookieDir, { recursive: true });
  let noCookieCalls = 0;
  let noCookieClock = 9_000_000;
  const noCookieQueue = new DownloadQueue({
    outputDir: noCookieDir,
    ffmpegPath: 'ffmpeg',
    ffprobePath: null,
    runner: async (args) => {
      noCookieCalls += 1;
      if (noCookieCalls > 50) noCookieQueue.stop();
      const i = args.indexOf('--cookies-from-browser');
      if (i < 0) throw new Error('ERROR: [youtube] x: Sign in to confirm you’re not a bot');
      throw new Error(`ERROR: could not find ${args[i + 1]} cookies database`);
    },
    now: () => noCookieClock,
    sleep: async (ms) => {
      noCookieClock += ms;
      if (noCookieClock > 9_000_000 + 700_000) noCookieQueue.stop();
    }
  });
  noCookieQueue.setLinks('https://youtube.com/shorts/NOCOOKIE001');
  await noCookieQueue.run();
  check(noCookieCalls <= browsers.length + 6, 'без cookies ссылка уходит в retry, а не крутится в бесконечном цикле', `calls=${noCookieCalls}`);

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\nИтог: ${failures ? `${failures} проверок провалено` : 'все проверки очереди пройдены'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nТест очереди упал:', err);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
