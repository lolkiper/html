'use strict';

/**
 * Проверка выбора языка аудиодорожки без реальных запросов к YouTube.
 *
 *   node scripts/download-audio-smoke-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DownloadQueue,
  STATUS,
  extractVideoId,
  normalizeAudioLang,
  audioLangLabel,
  describeAudioLang,
  audioMissingMessage,
  collectAudioTracks,
  summarizeAudioTracks,
  selectAudioTrack,
  buildAudioLangFormat,
  parseFfmpegStreamInfo,
  FALLBACK_FORMAT,
  DEFAULT_AUDIO_LANG
} = require('../downloader');

const ROOT = path.join(os.tmpdir(), `shorts-audio-smoke-${process.pid}`);
let failures = 0;

function check(condition, description, details = '') {
  if (condition) {
    console.log(`  OK   ${description}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${description}${details ? ` — ${details}` : ''}`);
  }
}

const VIDEO_FORMATS = [
  { format_id: '137', height: 1080, width: 1920, fps: 60, vcodec: 'avc1.640028', acodec: 'none', vbr: 4000 },
  { format_id: '271', height: 1440, width: 2560, fps: 60, vcodec: 'vp9', acodec: 'none', vbr: 8000 }
];

/** Испанский оригинал + английский и два русских дубляжа. */
function multiAudioFormats() {
  return [
    ...VIDEO_FORMATS,
    {
      format_id: 'audio-es-orig',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      abr: 129,
      asr: 48000,
      ext: 'm4a',
      language: 'es',
      language_preference: 10,
      format_note: 'Spanish original (default)'
    },
    {
      format_id: 'audio-en-dub',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      abr: 128,
      asr: 48000,
      ext: 'm4a',
      language: 'en',
      format_note: 'English dubbed'
    },
    {
      format_id: 'audio-ru-dub',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      abr: 160,
      asr: 48000,
      ext: 'm4a',
      language: 'ru',
      format_note: 'Russian dubbed'
    },
    {
      format_id: 'audio-ru-hi',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      abr: 96,
      asr: 44100,
      ext: 'm4a',
      language: 'ru',
      format_note: 'Russian'
    }
  ];
}

/** Только испанский оригинал и английский дубляж — русского нет. */
function noRussianFormats() {
  return multiAudioFormats().filter((fmt) => !String(fmt.format_id).includes('-ru-'));
}

function infoFor(id) {
  const formats = id === 'NORUSSIAN01' ? noRussianFormats() : multiAudioFormats();
  return { id, title: `Title ${id}`, language: 'es', formats };
}

function writeDummyVideo(file) {
  fs.writeFileSync(file, Buffer.alloc(8192, 7));
}

/** Мок yt-dlp: -J отдаёт мультиязычный список форматов, download пишет файл. */
function createAudioRunner(options = {}) {
  const probed = [];
  const downloads = [];

  const runner = async (args, onLine) => {
    const url = args[args.length - 1];
    const id = extractVideoId(url) || url;
    if (args.includes('-J')) {
      probed.push(id);
      return { stdout: JSON.stringify(infoFor(id)), stderr: '' };
    }
    downloads.push({ id, args });
    const outFlag = args.indexOf('-o');
    const template = outFlag >= 0 ? args[outFlag + 1] : path.join(options.outputDir, `${id}.mp4`);
    const file = String(template).replace('%(ext)s', 'mp4');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeDummyVideo(file);
    fs.writeFileSync(`${file.replace(/\.mp4$/i, '')}.info.json`, JSON.stringify(infoFor(id)));
    if (typeof onLine === 'function') onLine('[download] Destination: ' + file);
    return { stdout: `${file}\n`, stderr: '' };
  };

  runner.stats = () => ({ probed, downloads });
  return runner;
}

function makeQueue(dir, runner, logs) {
  let clock = 1_000_000;
  return new DownloadQueue({
    outputDir: dir,
    ffmpegPath: 'ffmpeg',
    ffprobePath: null,
    runner,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    hooks: {
      onLog: (_level, message) => {
        if (logs) logs.push(String(message));
      }
    }
  });
}

async function main() {
  console.log('1) Определение аудиодорожек и приоритеты выбора…');
  const info = infoFor('MULTIAUDIO1');
  const tracks = collectAudioTracks(info.formats, info);
  check(tracks.length === 4, 'найдены все четыре аудиодорожки', `tracks=${tracks.length}`);
  check(
    tracks.every((track) => track.formatId && track.available),
    'у каждой дорожки есть идентификатор формата и признак доступности'
  );
  const languages = tracks.map((track) => track.language).sort();
  check(String(languages) === String(['en', 'es', 'ru', 'ru']), 'язык каждой дорожки определён', String(languages));
  const original = tracks.filter((track) => track.isOriginal);
  check(original.length === 1 && original[0].language === 'es', 'испанская дорожка помечена как Original');
  check(
    tracks.filter((track) => track.isDub).length === 2,
    'дубляжи распознаны по пометке'
  );
  const summary = summarizeAudioTracks(tracks);
  check(
    summary.includes('Español (Original)') && summary.includes('English') && summary.includes('Русский'),
    'список языков для UI собран',
    summary.join(', ')
  );

  const ru = selectAudioTrack(tracks, 'ru', info);
  check(ru.ok && ru.track.language === 'ru', 'выбран русский язык, а не другой');
  check(ru.track.formatId === 'audio-ru-dub', 'из двух русских вариантов взят лучший по битрейту', ru.track.formatId);
  const orig = selectAudioTrack(tracks, 'original', info);
  check(orig.ok && orig.track.language === 'es', 'Original — это испанский оригинал, а не English Dub', orig.track.language);
  const auto = selectAudioTrack(tracks, 'auto', info);
  check(auto.ok && auto.track === null && auto.mode === 'auto', 'при «Авто» дорожка не пинится — прежняя логика');
  const missing = selectAudioTrack(collectAudioTracks(noRussianFormats(), info), 'ru', info);
  check(!missing.ok && missing.reason === 'language-missing', 'отсутствующий язык не подменяется английским');
  check(normalizeAudioLang('Russian original') === 'ru' && normalizeAudioLang('rus') === 'ru', 'коды и названия языков нормализуются');
  check(DEFAULT_AUDIO_LANG === 'auto', 'язык по умолчанию — Авто (обратная совместимость)');

  const fmt = buildAudioLangFormat('audio-ru-dub', 'ru');
  check(fmt.startsWith('bv*+ba[language^=ru]'), 'селектор пинит аудио по коду языка, а не по нестабильному номеру формата', fmt);
  check(fmt.includes('+audio-ru-dub'), 'format_id остаётся резервным вариантом', fmt);
  check(!/\bbest\b|bestaudio|\+ba(?:\*)?(?:\/|$)/.test(fmt), 'в селекторе нет fallback на чужое аудио', fmt);
  check(/^bv\*/.test(fmt), 'видео берётся максимального доступного качества (без ограничения на avc/1080p)', fmt);
  check(FALLBACK_FORMAT.startsWith('bv*+ba'), 'в режиме «Авто» тоже берётся максимальное видео', FALLBACK_FORMAT);
  check(describeAudioLang('ru') === '🇷🇺 Русский', 'подпись языка с флагом', describeAudioLang('ru'));
  check(audioMissingMessage('ru') === '⚠ Русский недоступен', 'текст о недоступном языке', audioMissingMessage('ru'));

  console.log('\n2) Очередь: язык есть, языка нет, очередь не встаёт…');
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const runner = createAudioRunner({ outputDir: ROOT });
  const logs = [];
  const queue = makeQueue(ROOT, runner, logs);
  queue.setLinks(
    ['https://youtube.com/shorts/MULTIAUDIO1', 'https://youtube.com/shorts/NORUSSIAN01', 'https://youtube.com/shorts/MULTIAUDIO2'].join('\n'),
    { defaultAudioLang: 'ru' }
  );
  check(
    queue.items.every((item) => item.audioLang === 'ru'),
    'язык по умолчанию назначен всем новым ссылкам'
  );
  const runSummary = await queue.run();

  const stats = runner.stats();
  const byId = (id) => queue.items.find((item) => item.videoId === id);
  const okItem = byId('MULTIAUDIO1');
  const skipItem = byId('NORUSSIAN01');
  check(okItem.status === STATUS.SUCCESS, 'видео с доступным русским скачано', okItem.status);
  check(okItem.audioFormatId === 'audio-ru-dub', 'в скачивание ушёл идентификатор русской дорожки', String(okItem.audioFormatId));
  check(okItem.audioLangResolved === 'ru' && okItem.audioMissing === false, 'язык доведён до элемента очереди');
  const okArgs = stats.downloads.filter((entry) => entry.id === 'MULTIAUDIO1').map((entry) => entry.args.join(' '));
  check(okArgs.length === 1 && okArgs[0].includes('audio-ru-dub'), 'yt-dlp вызван с русской аудиодорожкой');
  check(!okArgs[0].includes('audio-en-dub') && !okArgs[0].includes(FALLBACK_FORMAT), 'английская дорожка и общий fallback не подставлены');

  check(skipItem.status === STATUS.SKIPPED, 'видео без русского получило статus «Пропущено»', skipItem.status);
  check(skipItem.audioMissing === true, 'у пропущенного видео отмечена недоступность языка');
  check(
    stats.downloads.every((entry) => entry.id !== 'NORUSSIAN01'),
    'скачивание без нужного языка вообще не запускалось — английский не подменил русский'
  );
  check(
    logs.some((line) => line.includes('[VIDEO 2]') && line.includes('недоступна — пропуск')),
    'в логе есть сообщение о пропуске видео',
    logs.filter((line) => line.includes('пропуск')).join(' | ')
  );
  check(
    logs.some((line) => line.includes('Получение информации')) &&
      logs.some((line) => line.includes('Найдено аудио:')) &&
      logs.some((line) => line.includes('Выбран язык:')),
    'этапы «Получение информации → Проверка аудио → Скачивание» логируются'
  );
  check(runSummary.completed === 2, 'одно проблемное видео не остановило очередь', `completed=${runSummary.completed}`);
  check(runSummary.skipped === 1, 'пропущенные считаются отдельно от ошибок', `skipped=${runSummary.skipped}`);
  check(runSummary.permanent === 0 && runSummary.retry === 0, 'отсутствие языка не считается системной ошибкой');
  check(
    Array.isArray(skipItem.audioLanguages) && skipItem.audioLanguages.length > 0,
    'для пропущенного видео сохранён список доступных языков',
    (skipItem.audioLanguages || []).join(', ')
  );

  const savedQueue = JSON.parse(fs.readFileSync(path.join(ROOT, 'download_queue.json'), 'utf8'));
  check(
    savedQueue.items.every((item) => item.audioLang === 'ru'),
    'язык сохранён в очереди на диске и не сбросится после перезапуска'
  );

  console.log('\n3) Проверка языка в готовом MP4…');
  check(queue.verifyAudioLanguage(okItem, { requested: 'ru', track: { language: 'ru' } }, { audioLanguage: 'rus' }) === true,
    'русская дорожка в MP4 подтверждается');
  check(
    queue.verifyAudioLanguage(
      okItem,
      { requested: 'ru', track: { language: 'ru', acodec: 'mp4a.40.2', ext: 'm4a' } },
      { audioLanguage: 'eng' }
    ) === false,
    'английская дорожка в MP4 при запросе русского фиксируется как расхождение'
  );
  check(
    queue.verifyAudioLanguage(
      okItem,
      { requested: 'es', track: { language: 'es', acodec: 'opus', ext: 'webm', formatId: '251-3' } },
      { audioLanguage: 'eng' }
    ) === null,
    'тег «eng» после слияния opus не считается чужим языком'
  );
  check(
    queue.verifyAudioLanguage(
      okItem,
      { requested: 'es', track: { language: 'es', acodec: 'opus', ext: 'webm' } },
      { audioLanguage: 'deu' }
    ) === false,
    'реально другой язык в MP4 всё равно фиксируется'
  );
  check(queue.verifyAudioLanguage(okItem, { requested: 'auto', track: null }, { audioLanguage: 'eng' }) === null,
    'при «Авто» язык итогового файла не проверяется');

  const ffmpegOutput = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video01.mp4':",
    '  Duration: 00:01:23.45, start: 0.000000, bitrate: 2500 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1080x1920 [SAR 1:1 DAR 9:16], 2300 kb/s, 30 fps, 30 tbr',
    '  Stream #0:1[0x2](rus): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s',
    'At least one output file must be specified'
  ].join('\n');
  const opusPick = selectAudioTrack(
    [
      { formatId: '251', language: 'es', isOriginal: true, isDub: false, abr: 130, asr: 48000, ext: 'webm', acodec: 'opus', available: true },
      { formatId: '140', language: 'es', isOriginal: true, isDub: false, abr: 129, asr: 44100, ext: 'm4a', acodec: 'mp4a.40.2', available: true }
    ],
    'original',
    { language: 'es' }
  );
  check(opusPick.ok && opusPick.track.formatId === '140',
    'm4a/AAC выбирается вместо opus при близком битрейте — иначе MP4 без звука',
    opusPick.track && opusPick.track.formatId);

  const viaFfmpeg = parseFfmpegStreamInfo(ffmpegOutput);
  check(viaFfmpeg.audioLanguage === 'rus' && viaFfmpeg.hasVideo && viaFfmpeg.width === 1080,
    'без ffprobe язык дорожки и параметры файла читаются через ffmpeg', JSON.stringify(viaFfmpeg));
  check(
    queue.verifyAudioLanguage(okItem, { requested: 'ru', track: { language: 'ru' } }, viaFfmpeg) === true,
    'резервное чтение файла тоже подтверждает выбранный язык'
  );
  check(parseFfmpegStreamInfo(ffmpegOutput.replace('(rus)', '(und)')).audioLanguage === null,
    'дорожка без языковой метки не выдаётся за выбранный язык');

  console.log('\n4) Массовая установка языка и Original…');
  const bulkDir = path.join(ROOT, 'bulk');
  fs.mkdirSync(bulkDir, { recursive: true });
  const bulkRunner = createAudioRunner({ outputDir: bulkDir });
  const bulkLogs = [];
  const bulkQueue = makeQueue(bulkDir, bulkRunner, bulkLogs);
  bulkQueue.setLinks(
    ['https://youtube.com/shorts/MULTIAUDIO3', 'https://youtube.com/shorts/NORUSSIAN01', 'https://youtube.com/shorts/MULTIAUDIO4'].join('\n')
  );
  check(bulkQueue.items.every((item) => item.audioLang === 'auto'), 'без выбора языка очередь остаётся в режиме «Авто»');

  const detected = await bulkQueue.detectAudio({});
  check(detected.length === 3 && detected.every((entry) => entry.ok), 'доступные языки определены для всех видео');
  check(bulkQueue.items.every((item) => item.audioChecked === true), 'признак проверки выставлен');

  const changed = bulkQueue.setItemsAudioLang([1, 2], 'ru');
  check(changed === 2, 'язык установлен сразу для нескольких выбранных видео', `changed=${changed}`);
  check(bulkQueue.items[0].audioLang === 'ru' && bulkQueue.items[2].audioLang === 'auto', 'невыбранные видео не затронуты');
  check(bulkQueue.items[1].audioMissing === true, 'для видео без русского сразу показывается недоступность');
  check(bulkQueue.items[0].audioMissing === false, 'для видео с русским недоступность не показывается');

  const probedBeforeRun = bulkRunner.stats().probed.length;
  bulkQueue.setItemsAudioLang([2], 'original');
  check(bulkQueue.items[1].audioMissing === false, 'после смены языка на Original пропуск снимается');
  const bulkSummary = await bulkQueue.run();
  const origArgs = bulkRunner.stats().downloads.find((entry) => entry.id === 'NORUSSIAN01');
  check(Boolean(origArgs) && origArgs.args.join(' ').includes('audio-es-orig'), 'при Original скачивается испанская оригинальная дорожка');
  check(bulkQueue.items[1].audioTrackLanguage === 'es', 'фактический язык оригинальной дорожки записан', String(bulkQueue.items[1].audioTrackLanguage));
  check(bulkSummary.completed === 3 && bulkSummary.skipped === 0, 'вся очередь отработала', `completed=${bulkSummary.completed}`);

  const autoArgs = bulkRunner.stats().downloads.find((entry) => entry.id === 'MULTIAUDIO4');
  check(autoArgs.args.includes(FALLBACK_FORMAT), 'режим «Авто» качает прежним селектором формата');
  const probedDuringRun = bulkRunner.stats().probed.slice(probedBeforeRun);
  check(
    !probedDuringRun.includes('MULTIAUDIO4'),
    'для «Авто» дополнительных запросов информации при скачивании нет',
    probedDuringRun.join(',')
  );

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\nИтог: ${failures ? `${failures} проверок провалено` : 'все проверки аудиодорожек пройдены'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nТест аудиодорожек упал:', err);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
