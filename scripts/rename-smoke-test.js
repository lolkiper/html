'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeTitle,
  similarityScore,
  parseTitles,
  analyzeRename,
  applyRename
} = require('../renamer');

const ROOT = path.join(os.tmpdir(), `shorts-rename-smoke-${process.pid}`);
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
  fs.writeFileSync(file, Buffer.alloc(128, 1));
}

function main() {
  console.log('1) Нормализация и похожесть…');
  check(
    normalizeTitle('MAMÁ ME CULPA POR SUS PROPIOS ERRORES 😱 #roblox') ===
      'mama me culpa por sus propios errores',
    'TXT: акценты, emoji и hashtag убираются'
  );
  check(
    normalizeTitle('MAMA ME CULPA POR SUS PROPIOS ERRORES.mp4') ===
      'mama me culpa por sus propios errores',
    'имя файла нормализуется так же, как строка TXT'
  );
  check(
    normalizeTitle('LE PREGUNTÉ EL COLOR FAVORITO DE UN VAMPIRO? #roblox') ===
      'le pregunte el color favorito de un vampiro',
    'знаки ? : | * не воспринимаются как путь'
  );
  check(
    !normalizeTitle('https://youtube.com/shorts/AAAA title #shorts').includes('http'),
    'URL вычищается из названия'
  );

  const mama = similarityScore(
    'MAMA ME CULPA POR SUS PROPIOS ERRORES.mp4',
    'MAMÁ ME CULPA POR SUS PROPIOS ERRORES 😱 #roblox'
  );
  check(mama >= 90, 'MAMA vs MAMÁ даёт 90–100%', `${mama}%`);

  const born = similarityScore(
    'FUERON CAMBIADAS AL NACER ROBLOX.mp4',
    'FUERON CAMBIADAS AL NACER? #roblox #bloxfruits'
  );
  check(born >= 80, 'основные слова совпадают при лишнем ROBLOX в имени', `${born}%`);

  const low = similarityScore('UNKNOWN VIDEO.mp4', 'LE PREGUNTÉ EL COLOR FAVORITO DE UN VAMPIRO #roblox');
  check(low < 60, 'чужое название остаётся ниже порога', `${low}%`);

  const titles = parseTitles(`
MAMÁ ME CULPA POR SUS PROPIOS ERRORES 😱 #roblox

FUERON CAMBIADAS AL NACER? #roblox #bloxfruits
LE PREGUNTÉ EL COLOR FAVORITO DE UN VAMPIRO #roblox
MI NOVIO ME DEJÓ POR OTRA 😭 #roblox
`);
  check(titles.length === 4 && titles[0].number === 1 && titles[3].number === 4, 'пустые строки не сдвигают номера');

  console.log('\n2) Предпросмотр не трогает файлы…');
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const files = {
    mama: path.join(ROOT, 'MAMA ME CULPA POR SUS PROPIOS ERRORES.mp4'),
    born: path.join(ROOT, 'FUERON CAMBIADAS AL NACER ROBLOX.mp4'),
    vamp: path.join(ROOT, 'VAMPIRO ME DIJO SU COLOR FAVORITO.mp4'),
    novio: path.join(ROOT, 'MI NOVIO ME DEJO POR OTRA.mp4'),
    extra: path.join(ROOT, 'UNKNOWN VIDEO.mp4')
  };
  Object.values(files).forEach(touch);
  const txt = path.join(ROOT, 'nazvaniya.txt');
  fs.writeFileSync(
    txt,
    [
      'MAMÁ ME CULPA POR SUS PROPIOS ERRORES 😱 #roblox',
      'FUERON CAMBIADAS AL NACER? #roblox #bloxfruits',
      'LE PREGUNTÉ EL COLOR FAVORITO DE UN VAMPIRO #roblox',
      'MI NOVIO ME DEJÓ POR OTRA 😭 #roblox'
    ].join('\n'),
    'utf8'
  );

  const preview = analyzeRename({ directory: ROOT, titlesFile: txt, minScore: 60 });
  check(preview.summary.videos === 5, 'найдено 5 видео', `videos=${preview.summary.videos}`);
  check(preview.summary.titles === 4, 'в TXT 4 названия', `titles=${preview.summary.titles}`);
  const byOld = Object.fromEntries(preview.rows.map((row) => [row.video, row]));
  check(byOld['MAMA ME CULPA POR SUS PROPIOS ERRORES.mp4'].newName === '1.mp4', 'первое видео → 1.mp4 по позиции TXT');
  check(byOld['FUERON CAMBIADAS AL NACER ROBLOX.mp4'].newName === '2.mp4', 'второе видео → 2.mp4');
  check(byOld['MI NOVIO ME DEJO POR OTRA.mp4'].newName === '4.mp4', 'четвёртое видео → 4.mp4, не по порядку файлов');
  check(
    byOld['VAMPIRO ME DIJO SU COLOR FAVORITO.mp4'].status === 'MATCH' &&
      byOld['VAMPIRO ME DIJO SU COLOR FAVORITO.mp4'].newName === '3.mp4',
    'вампир сопоставлен со строкой №3',
    `${byOld['VAMPIRO ME DIJO SU COLOR FAVORITO.mp4'].status} ${byOld['VAMPIRO ME DIJO SU COLOR FAVORITO.mp4'].score}%`
  );
  check(byOld['UNKNOWN VIDEO.mp4'].status !== 'MATCH', 'чужое видео не забирает чужой номер');
  const assigned = preview.rows.filter((row) => row.status === 'MATCH').map((row) => row.txtNumber);
  check(new Set(assigned).size === assigned.length, 'одна строка TXT назначена только одному видео');
  check(fs.existsSync(files.mama), 'предпросмотр не переименовывает файлы');

  console.log('\n3) Конфликт существующего номера…');
  const conflictDir = path.join(ROOT, 'conflict');
  fs.mkdirSync(conflictDir);
  touch(path.join(conflictDir, 'MAMA ME CULPA POR SUS PROPIOS ERRORES.mp4'));
  touch(path.join(conflictDir, '1.mp4'));
  fs.writeFileSync(path.join(conflictDir, 'nazvaniya.txt'), 'MAMÁ ME CULPA POR SUS PROPIOS ERRORES 😱 #roblox\n', 'utf8');
  const conflict = analyzeRename({
    directory: conflictDir,
    titlesFile: path.join(conflictDir, 'nazvaniya.txt'),
    minScore: 60
  });
  const conflictRow = conflict.rows.find((row) => row.video.startsWith('MAMA'));
  check(conflictRow.status === 'CONFLICT', 'занятый 1.mp4 даёт CONFLICT, а не перезапись', conflictRow.status);

  console.log('\n4) Безопасное переименование через временные имена…');
  const swapDir = path.join(ROOT, 'swap');
  fs.mkdirSync(swapDir);
  touch(path.join(swapDir, '2.mp4'));
  touch(path.join(swapDir, 'FIRST TITLE FILE.mp4'));
  fs.writeFileSync(
    path.join(swapDir, 'nazvaniya.txt'),
    'FIRST TITLE FILE\nSECOND TITLE FILE\n',
    'utf8'
  );
  fs.renameSync(path.join(swapDir, '2.mp4'), path.join(swapDir, 'SECOND TITLE FILE.mp4'));
  const swapPreview = analyzeRename({
    directory: swapDir,
    titlesFile: path.join(swapDir, 'nazvaniya.txt'),
    minScore: 60
  });
  const applied = applyRename(swapPreview, { removeUnmatchedVideos: false, createReports: true, keepOriginalTxt: true });
  check(fs.existsSync(path.join(swapDir, '1.mp4')), 'alpha стал 1.mp4');
  check(fs.existsSync(path.join(swapDir, '2.mp4')), 'второй файл стал 2.mp4 через temp, без затирания');
  check(applied.renamed === 2, 'переименованы оба файла', `renamed=${applied.renamed}`);
  check(fs.existsSync(path.join(swapDir, 'nazvaniya.txt')), 'исходный nazvaniya.txt не удалён');
  check(fs.existsSync(path.join(swapDir, 'rename_report.txt')), 'создан rename_report.txt');

  console.log('\n5) Применение на примере пользователя и удаление unmatched…');
  const result = applyRename(preview, { removeUnmatchedVideos: true, createReports: true, keepOriginalTxt: true });
  check(fs.existsSync(path.join(ROOT, '1.mp4')), '1.mp4 создан');
  check(fs.existsSync(path.join(ROOT, '2.mp4')), '2.mp4 создан');
  check(fs.existsSync(path.join(ROOT, '3.mp4')), '3.mp4 создан');
  check(fs.existsSync(path.join(ROOT, '4.mp4')), '4.mp4 создан');
  check(!fs.existsSync(files.extra), 'несопоставленное видео удалено только после применения');
  check(fs.existsSync(txt), 'nazvaniya.txt на месте');
  check(result.renamed === 4, 'четыре файла переименованы', `renamed=${result.renamed}`);
  check(fs.existsSync(path.join(ROOT, 'missing_titles.txt')), 'отчёт missing_titles.txt');
  check(fs.existsSync(path.join(ROOT, 'unmatched_videos.txt')), 'отчёт unmatched_videos.txt');

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\nИтог: ${failures ? `${failures} проверок провалено` : 'все проверки переименования пройдены'}`);
  process.exit(failures ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error('\nТест переименования упал:', err);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
}
