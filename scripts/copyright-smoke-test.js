'use strict';

/**
 * Проверка Copyright Check без реальных запросов к YouTube.
 *
 *   node scripts/copyright-smoke-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_COPYRIGHT_CHECKS,
  QUEUE_FILE,
  LOG_FILE,
  UPLOAD,
  PROCESSING,
  COPYRIGHT,
  AVAILABILITY,
  ACTION,
  classifyFromYoutubeVideo,
  decideAction,
  CopyrightChecker
} = require('../copyright-check');

const {
  SCOPES,
  authorizationUrl,
  privateUploadBody
} = require('../youtube-api');

const { applyRename, analyzeRename } = require('../renamer');

const ROOT = path.join(os.tmpdir(), `shorts-copyright-smoke-${process.pid}`);
let failures = 0;

function check(condition, description, details = '') {
  if (condition) {
    console.log(`  OK   ${description}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${description}${details ? ` — ${details}` : ''}`);
  }
}

function touch(file) {
  fs.writeFileSync(file, Buffer.alloc(8192, 3));
}

function processed(extra = {}) {
  return {
    id: extra.id || 'vid',
    status: {
      uploadStatus: extra.uploadStatus || 'processed',
      privacyStatus: 'private',
      rejectionReason: extra.rejectionReason
    },
    contentDetails: {
      licensedContent: extra.licensedContent === true,
      regionRestriction: extra.regionRestriction
    },
    processingDetails: {
      processingStatus: extra.processingStatus || 'succeeded'
    }
  };
}

async function runQueue(options) {
  const directory = options.directory;
  let now = 1_700_000_000_000;
  const uploads = [];
  const deletedYoutube = [];
  let getCalls = 0;
  const client = {
    uploadPrivate: async (filePath, opts) => {
      uploads.push({ filePath, title: opts && opts.title, privacy: 'private' });
      return { id: options.videoId || `yt-${path.basename(filePath)}`, status: { privacyStatus: 'private' } };
    },
    getVideo: async (id) => {
      getCalls += 1;
      if (typeof options.getVideo === 'function') return options.getVideo(id, getCalls);
      return processed({ id });
    },
    deleteVideo: async (id) => {
      deletedYoutube.push(id);
      return true;
    }
  };
  const logs = [];
  const checker = new CopyrightChecker({
    directory,
    client,
    maxWaitMs: options.maxWaitMs || 4000,
    pollMs: options.pollMs || 1000,
    autoDeleteUploads: Boolean(options.autoDeleteUploads),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    hooks: {
      onLog: (_level, line) => logs.push(line)
    }
  });
  if (options.load) checker.loadFromDisk();
  if (options.files) checker.enqueueFiles(options.files);
  await checker.run();
  return { checker, uploads, deletedYoutube, logs, getCalls };
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });

  console.log('1) OAuth и только PRIVATE…');
  const auth = authorizationUrl({
    clientId: 'client.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:1234/oauth2callback'
  });
  check(auth.includes('youtube.upload'), 'OAuth scope включает youtube.upload');
  check(auth.includes('accounts.google.com'), 'авторизация через Google OAuth');
  check(!/password/i.test(auth), 'в URL нет пароля Google');
  const body = privateUploadBody('test.mp4');
  check(body.status.privacyStatus === 'private', 'загрузка только private');
  check(body.status.privacyStatus !== 'public' && body.status.privacyStatus !== 'unlisted', 'не public и не unlisted');
  check(SCOPES.includes('youtube.upload'), 'SCOPES содержит youtube.upload');

  console.log('\n2) CLAIM ≠ BLOCK…');
  const noClaim = classifyFromYoutubeVideo(processed());
  check(noClaim.copyrightStatus === COPYRIGHT.NO_CLAIM, 'нет claim');
  check(noClaim.availabilityStatus === AVAILABILITY.AVAILABLE, 'доступно без ограничений');
  check(decideAction({
    uploadStatus: UPLOAD.SUCCESS,
    processingStatus: PROCESSING.READY,
    copyrightStatus: noClaim.copyrightStatus,
    availabilityStatus: noClaim.availabilityStatus
  }).action === ACTION.KEEP, 'NO CLAIM → KEEP');

  const claimOk = classifyFromYoutubeVideo(processed({ licensedContent: true }));
  check(claimOk.copyrightStatus === COPYRIGHT.CLAIM, 'licensedContent = CLAIM');
  check(claimOk.availabilityStatus === AVAILABILITY.AVAILABLE, 'claim не делает видео blocked');
  check(decideAction({
    uploadStatus: UPLOAD.SUCCESS,
    processingStatus: PROCESSING.READY,
    copyrightStatus: claimOk.copyrightStatus,
    availabilityStatus: claimOk.availabilityStatus
  }).deleteLocal === false, 'CLAIM + AVAILABLE не удаляет файл');

  const blocked = classifyFromYoutubeVideo(processed({
    licensedContent: true,
    regionRestriction: { allowed: [] }
  }));
  check(blocked.copyrightStatus === COPYRIGHT.CLAIM, 'при блоке copyright остаётся CLAIM');
  check(blocked.availabilityStatus === AVAILABILITY.BLOCKED, 'пустой allowed = BLOCKED');
  check(decideAction({
    uploadStatus: UPLOAD.SUCCESS,
    processingStatus: PROCESSING.READY,
    copyrightStatus: blocked.copyrightStatus,
    availabilityStatus: blocked.availabilityStatus
  }).deleteLocal === true, 'CLAIM + BLOCKED → DELETE');

  const rejected = classifyFromYoutubeVideo(processed({ uploadStatus: 'rejected', rejectionReason: 'copyright' }));
  check(rejected.availabilityStatus === AVAILABILITY.BLOCKED, 'rejected copyright = BLOCKED');

  const processing = classifyFromYoutubeVideo({
    status: { uploadStatus: 'uploaded', privacyStatus: 'private' },
    processingDetails: { processingStatus: 'processing' }
  });
  check(processing.copyrightStatus === COPYRIGHT.PROCESSING, 'processing не считается block');
  check(decideAction({
    uploadStatus: UPLOAD.SUCCESS,
    processingStatus: PROCESSING.PROCESSING,
    copyrightStatus: COPYRIGHT.PROCESSING,
    availabilityStatus: AVAILABILITY.UNKNOWN
  }).action === ACTION.WAIT, 'processing → WAIT');

  check(decideAction({
    uploadStatus: UPLOAD.ERROR,
    processingStatus: PROCESSING.PENDING,
    copyrightStatus: COPYRIGHT.UNKNOWN,
    availabilityStatus: AVAILABILITY.UNKNOWN
  }).action === ACTION.RETRY, 'upload failed → RETRY, файл остаётся');

  check(decideAction({
    uploadStatus: UPLOAD.SUCCESS,
    processingStatus: PROCESSING.TIMEOUT,
    copyrightStatus: COPYRIGHT.CHECK_ERROR,
    availabilityStatus: AVAILABILITY.UNKNOWN
  }).deleteLocal === false, 'timeout не удаляет файл');

  check(MAX_COPYRIGHT_CHECKS === 1, 'MAX_COPYRIGHT_CHECKS = 1');

  console.log('\n3) Очередь: NO CLAIM оставляет файл…');
  const keepDir = path.join(ROOT, 'keep');
  fs.mkdirSync(keepDir);
  const keepFile = path.join(keepDir, '1.mp4');
  touch(keepFile);
  const keepRun = await runQueue({
    directory: keepDir,
    files: [keepFile],
    getVideo: () => processed({ licensedContent: false })
  });
  check(fs.existsSync(keepFile), 'файл с NO CLAIM остался');
  check(keepRun.checker.items[0].action === ACTION.KEEP, 'action KEEP');
  check(keepRun.checker.items[0].youtubeVideoId.length > 0, 'сохранён YouTube video ID');
  check(keepRun.logs.some((line) => line.includes('UPLOAD START')), 'лог UPLOAD START');
  check(keepRun.logs.some((line) => line.includes('NO CLAIM')), 'лог NO CLAIM');
  check(keepRun.logs.some((line) => line.includes('KEEP')), 'лог KEEP');
  check(fs.existsSync(path.join(keepDir, QUEUE_FILE)), 'создан copyright_queue.json');
  check(fs.existsSync(path.join(keepDir, LOG_FILE)), 'создан copyright_check.log');
  check(keepRun.deletedYoutube.length === 0, 'YouTube-видео не удаляется по умолчанию');

  console.log('\n4) CLAIM + AVAILABLE оставляет файл…');
  const claimDir = path.join(ROOT, 'claim');
  fs.mkdirSync(claimDir);
  const claimFile = path.join(claimDir, '2.mp4');
  touch(claimFile);
  const claimRun = await runQueue({
    directory: claimDir,
    files: [claimFile],
    getVideo: () => processed({ licensedContent: true })
  });
  check(fs.existsSync(claimFile), 'CLAIM не удаляет локальный файл');
  check(claimRun.checker.items[0].action === ACTION.KEEP, 'CLAIM + AVAILABLE → KEEP');
  check(claimRun.logs.some((line) => line.includes('CLAIM DETECTED')), 'лог CLAIM DETECTED');
  check(claimRun.logs.some((line) => line.includes('AVAILABILITY: AVAILABLE')), 'лог AVAILABLE');

  console.log('\n5) BLOCKED удаляет только локальный файл…');
  const blockDir = path.join(ROOT, 'block');
  fs.mkdirSync(blockDir);
  const blockFile = path.join(blockDir, '3.mp4');
  touch(blockFile);
  const blockRun = await runQueue({
    directory: blockDir,
    files: [blockFile],
    getVideo: () => processed({
      licensedContent: true,
      regionRestriction: { allowed: [] }
    })
  });
  check(!fs.existsSync(blockFile), 'BLOCKED удаляет локальный файл');
  check(blockRun.checker.items[0].action === ACTION.DELETE, 'action DELETE');
  check(blockRun.checker.items[0].deleteVerified === true, 'DELETE VERIFIED');
  check(blockRun.logs.some((line) => line.includes('COPYRIGHT BLOCK')), 'лог COPYRIGHT BLOCK');
  check(blockRun.logs.some((line) => line.includes('DELETE SUCCESS')), 'лог DELETE SUCCESS');
  check(blockRun.deletedYoutube.length === 0, 'ролик на тестовом канале не удаляется автоматически');

  console.log('\n6) Timeout и ошибка API не удаляют файл…');
  const waitDir = path.join(ROOT, 'wait');
  fs.mkdirSync(waitDir);
  const waitFile = path.join(waitDir, '4.mp4');
  touch(waitFile);
  const waitRun = await runQueue({
    directory: waitDir,
    files: [waitFile],
    maxWaitMs: 2500,
    pollMs: 1000,
    getVideo: () => ({
      status: { uploadStatus: 'uploaded', privacyStatus: 'private' },
      processingDetails: { processingStatus: 'processing' }
    })
  });
  check(fs.existsSync(waitFile), 'timeout не удаляет файл');
  check(waitRun.checker.items[0].action === ACTION.RETRY, 'timeout → RETRY');
  check(waitRun.checker.items[0].processingStatus === PROCESSING.TIMEOUT, 'processing TIMEOUT');

  const errDir = path.join(ROOT, 'err');
  fs.mkdirSync(errDir);
  const errFile = path.join(errDir, '5.mp4');
  touch(errFile);
  const errRun = await runQueue({
    directory: errDir,
    files: [errFile],
    getVideo: async () => {
      throw new Error('NETWORK ERROR');
    }
  });
  check(fs.existsSync(errFile), 'NETWORK ERROR не удаляет файл');
  check(errRun.checker.items[0].action === ACTION.RETRY, 'ошибка API → RETRY');

  console.log('\n7) Retry не загружает файл повторно…');
  const retryDir = path.join(ROOT, 'retry');
  fs.mkdirSync(retryDir);
  const retryFile = path.join(retryDir, '6.mp4');
  touch(retryFile);
  let phase = 0;
  const retryFirst = await runQueue({
    directory: retryDir,
    files: [retryFile],
    videoId: 'keep-id-6',
    maxWaitMs: 2500,
    pollMs: 1000,
    getVideo: () => ({
      status: { uploadStatus: 'uploaded' },
      processingDetails: { processingStatus: 'processing' }
    })
  });
  check(retryFirst.uploads.length === 1, 'первая попытка загрузила один раз');
  const retrySecond = await runQueue({
    directory: retryDir,
    load: true,
    videoId: 'should-not-use',
    getVideo: () => {
      phase += 1;
      return processed({ id: 'keep-id-6', licensedContent: false });
    }
  });
  retrySecond.checker.retryFailed();
  check(retrySecond.checker.items[0].youtubeVideoId === 'keep-id-6', 'повтор использует существующий Video ID');
  await retrySecond.checker.run();
  check(retrySecond.uploads.length === 0, 'повторная проверка не вызывает upload');
  check(fs.existsSync(retryFile), 'после retry без block файл на месте');

  console.log('\n8) Состояние сохраняется и продолжается…');
  const resumeDir = path.join(ROOT, 'resume');
  fs.mkdirSync(resumeDir);
  const resumeFile = path.join(resumeDir, '7.mp4');
  touch(resumeFile);
  const first = await runQueue({
    directory: resumeDir,
    files: [resumeFile],
    videoId: 'resume-id',
    maxWaitMs: 2500,
    pollMs: 1000,
    getVideo: () => ({
      status: { uploadStatus: 'uploaded' },
      processingDetails: { processingStatus: 'processing' }
    })
  });
  const saved = JSON.parse(fs.readFileSync(path.join(resumeDir, QUEUE_FILE), 'utf8'));
  check(saved.items[0].youtubeVideoId === 'resume-id', 'video id записан в copyright_queue.json');
  check(first.uploads.length === 1, 'до закрытия была одна загрузка');
  const resumed = await runQueue({
    directory: resumeDir,
    load: true,
    getVideo: () => processed({ id: 'resume-id' })
  });
  check(resumed.uploads.length === 0, 'после перезапуска загрузка не начинается заново');
  check(resumed.checker.items[0].action === ACTION.KEEP, 'проверка продолжилась с сохранённого id');

  console.log('\n9) Автоудаление тестовых загрузок только если включено…');
  const autoDir = path.join(ROOT, 'auto');
  fs.mkdirSync(autoDir);
  const autoFile = path.join(autoDir, '8.mp4');
  touch(autoFile);
  const autoRun = await runQueue({
    directory: autoDir,
    files: [autoFile],
    autoDeleteUploads: true,
    getVideo: () => processed()
  });
  check(autoRun.deletedYoutube.length === 1, 'при включённой настройке тестовая загрузка удаляется');
  check(fs.existsSync(autoFile), 'локальный файл при NO CLAIM всё равно KEEP');

  console.log('\n10) Один файл за раз и интеграция с rename…');
  let active = 0;
  let maxActive = 0;
  const seqDir = path.join(ROOT, 'seq');
  fs.mkdirSync(seqDir);
  const a = path.join(seqDir, 'a.mp4');
  const b = path.join(seqDir, 'b.mp4');
  touch(a);
  touch(b);
  let now = 1_700_000_000_000;
  const seq = new CopyrightChecker({
    directory: seqDir,
    maxWaitMs: 4000,
    pollMs: 10,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    client: {
      uploadPrivate: async (filePath) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        return { id: `seq-${path.basename(filePath)}`, status: { privacyStatus: 'private' } };
      },
      getVideo: async () => processed(),
      deleteVideo: async () => true
    }
  });
  seq.enqueueFiles([a, b]);
  await seq.run();
  check(maxActive === 1, 'не загружает два видео одновременно', `maxActive=${maxActive}`);
  check(seq.items.length === 2 && seq.items.every((item) => item.action === ACTION.KEEP), 'оба файла проверены по очереди');

  const renameDir = path.join(ROOT, 'rename');
  fs.mkdirSync(renameDir);
  touch(path.join(renameDir, 'MAMA ME CULPA.mp4'));
  fs.writeFileSync(path.join(renameDir, 'nazvaniya.txt'), 'MAMÁ ME CULPA\n', 'utf8');
  const preview = analyzeRename({
    directory: renameDir,
    titlesFile: path.join(renameDir, 'nazvaniya.txt'),
    minScore: 60
  });
  const renamed = applyRename(preview, { removeUnmatchedVideos: false, createReports: true, keepOriginalTxt: true });
  check(Array.isArray(renamed.keptFiles) && renamed.keptFiles.some((file) => path.basename(file) === '1.mp4'), 'applyRename возвращает keptFiles');
  check(fs.existsSync(path.join(renameDir, '1.mp4')), 'после rename файл 1.mp4 на месте до copyright check');

  const src = fs.readFileSync(path.join(__dirname, '..', 'copyright-check.js'), 'utf8');
  check(!/bypass|обход content id|fingerprint/i.test(src), 'в модуле нет обхода Content ID');

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\nИтог: ${failures ? `${failures} проверок провалено` : 'все проверки Copyright Check пройдены'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nТест Copyright Check упал:', err);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
