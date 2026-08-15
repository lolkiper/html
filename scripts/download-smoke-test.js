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
  parseLinkList,
  extractVideoId,
  retryDelayMs,
  classifyError,
  sanitizeFilename,
  selectBestFormats,
  parseProgressLine,
  mergeUrlsIntoQueue,
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

  const runner = async (args) => {
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
      const outFlag = args.indexOf('-o');
      const template = outFlag >= 0 ? args[outFlag + 1] : path.join(options.outputDir, `${id}.mp4`);
      const file = String(template).replace('%(ext)s', 'mp4');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeDummyVideo(file);
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

  check(sanitizeFilename('MAMÁ ME CULPA 😱 #roblox') === 'MAMÁ ME CULPA 😱 #roblox', 'unicode в имени файла сохраняется');
  check(!/[<>:"/\\|?*]/.test(sanitizeFilename('a<b>:c/d|e?f*g')), 'запрещённые Windows-символы вычищены');
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
  const queue = new DownloadQueue({
    outputDir: ROOT,
    ffmpegPath: 'ffmpeg',
    ffprobePath: null,
    runner,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    hooks: {}
  });
  queue.setLinks(urls.join('\n'));
  const summary = await queue.run();

  check(runner.stats().maxActive === 1, 'никогда не было двух активных загрузок', `max=${runner.stats().maxActive}`);
  check(summary.completed === 3, 'три видео скачаны успешно', `completed=${summary.completed}`);
  check(summary.permanent === 1, 'удалённое видео помечено как постоянная ошибка', `permanent=${summary.permanent}`);
  check(summary.retry === 0, 'временные ошибки докачались после retry', `retry=${summary.retry}`);

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

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\nИтог: ${failures ? `${failures} проверок провалено` : 'все проверки очереди пройдены'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nТест очереди упал:', err);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
