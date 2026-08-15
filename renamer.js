'use strict';

/**
 * renamer.js — умное переименование видео по строкам nazvaniya.txt.
 *
 * Номер файла = позиция названия в TXT, не порядок файлов в папке.
 * Сравнение текстовое: без path.parse / GetFileNameWithoutExtension на
 * строках TXT и без двумерного Левенштейна.
 */

const fs = require('fs');
const path = require('path');

const VIDEO_EXTS = [
  '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm', '.wmv',
  '.flv', '.mpg', '.mpeg', '.mts', '.m2ts', '.ts', '.3gp', '.ogv'
];

const REPORT_NAMES = new Set([
  'nazvaniya.txt',
  'nazvaniya_missing.txt',
  'missing_titles.txt',
  'unmatched_videos.txt',
  'videos_unmatched.txt',
  'conflicts.txt',
  'rename_report.txt',
  'download_queue.json',
  'download_log.txt',
  'copyright_queue.json',
  'copyright_check.log'
]);

const TEMP_PREFIX = '.smart-rename-';
const DEFAULT_MIN_SCORE = 60;

const ACCENT_MAP = {
  á: 'a', à: 'a', ä: 'a', â: 'a', ã: 'a',
  é: 'e', è: 'e', ë: 'e', ê: 'e',
  í: 'i', ì: 'i', ï: 'i', î: 'i',
  ó: 'o', ò: 'o', ö: 'o', ô: 'o', õ: 'o',
  ú: 'u', ù: 'u', ü: 'u', û: 'u',
  ñ: 'n', ç: 'c'
};

function stripKnownExtension(text) {
  const value = String(text || '');
  const match = value.match(/^(.*?)(\.(mp4|mov|mkv|avi|m4v|webm|wmv|flv|mpg|mpeg|mts|m2ts|ts|3gp|ogv))$/i);
  return match ? match[1] : value;
}

function foldAccents(text) {
  return String(text || '').replace(/[áàäâãéèëêíìïîóòöôõúùüûñç]/gi, (ch) => {
    const mapped = ACCENT_MAP[ch.toLowerCase()];
    if (!mapped) return ch;
    return ch === ch.toUpperCase() ? mapped.toUpperCase() : mapped;
  });
}

function normalizeTitle(text) {
  let value = String(text == null ? '' : text);
  value = value.replace(/\r/g, '');
  value = stripKnownExtension(value);
  value = value.replace(/https?:\/\/[^\s]+/gi, ' ');
  value = value.replace(/www\.[^\s]+/gi, ' ');
  value = value.replace(/#[^\s#]+/g, ' ');
  value = value.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ');
  value = foldAccents(value).toLowerCase();
  value = value.replace(/[^a-z0-9\s]+/g, ' ');
  value = value.replace(/\s+/g, ' ').trim();
  return value;
}

function tokenize(normalized) {
  return String(normalized || '').split(' ').filter(Boolean);
}

function trigrams(normalized) {
  const padded = `  ${normalized} `;
  const grams = new Set();
  for (let i = 0; i < padded.length - 2; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

function setOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach((item) => {
    if (b.has(item)) inter += 1;
  });
  return inter / (a.size + b.size - inter);
}

function similarityScore(left, right) {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a && !b) return 100;
  if (!a || !b) return 0;

  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const weight = (word) => Math.max(1, word.length);

  let interWeight = 0;
  let unionWeight = 0;
  const seen = new Set();
  wordsA.concat(wordsB).forEach((word) => {
    if (seen.has(word)) return;
    seen.add(word);
    const w = weight(word);
    unionWeight += w;
    if (setA.has(word) && setB.has(word)) interWeight += w;
  });
  const weightedJaccard = unionWeight ? interWeight / unionWeight : 0;

  const weightA = wordsA.reduce((sum, word) => sum + weight(word), 0);
  const weightB = wordsB.reduce((sum, word) => sum + weight(word), 0);
  const coverA = weightA ? interWeight / weightA : 0;
  const coverB = weightB ? interWeight / weightB : 0;
  const subset = Math.max(coverA, coverB);

  const longA = wordsA.filter((word) => word.length >= 4);
  const longB = wordsB.filter((word) => word.length >= 4);
  const longSetB = new Set(longB);
  const longInter = longA.filter((word) => longSetB.has(word)).length;
  const longPrecision = longA.length && longB.length
    ? longInter / Math.min(longA.length, longB.length)
    : subset;

  const trigram = setOverlap(trigrams(a), trigrams(b));
  const score = (0.22 * weightedJaccard + 0.28 * subset + 0.32 * longPrecision + 0.18 * trigram) * 100;
  return Math.round(score * 10) / 10;
}

function parseTitles(text) {
  const titles = [];
  String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((line) => {
      const raw = line.trim();
      if (!raw) return;
      titles.push({
        number: titles.length + 1,
        raw,
        normalized: normalizeTitle(raw)
      });
    });
  return titles;
}

function readTitlesFile(file) {
  if (!file || !fs.existsSync(file)) throw new Error('Файл nazvaniya.txt не найден.');
  return parseTitles(fs.readFileSync(file, 'utf8'));
}

function isVideoName(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return VIDEO_EXTS.includes(ext);
}

function listVideos(directory) {
  if (!directory || !fs.existsSync(directory)) throw new Error('Папка с видео не найдена.');
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => isVideoName(name))
    .filter((name) => !REPORT_NAMES.has(name.toLowerCase()))
    .filter((name) => !name.startsWith(TEMP_PREFIX) && !name.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' }))
    .map((name) => ({
      name,
      path: path.join(directory, name),
      ext: name.slice(name.lastIndexOf('.')),
      normalized: normalizeTitle(name)
    }));
}

function sameFile(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function analyzeRename({ directory, titlesText, titlesFile, minScore }) {
  const titles = titlesText != null ? parseTitles(titlesText) : readTitlesFile(titlesFile);
  const videos = listVideos(directory);
  const threshold = Number.isFinite(Number(minScore)) ? Number(minScore) : DEFAULT_MIN_SCORE;
  const candidates = [];

  videos.forEach((video) => {
    titles.forEach((title) => {
      candidates.push({
        video,
        title,
        score: similarityScore(video.normalized, title.normalized)
      });
    });
  });

  candidates.sort((a, b) => b.score - a.score || a.title.number - b.title.number || a.video.name.localeCompare(b.video.name));

  const usedVideos = new Set();
  const usedTitles = new Set();
  const bestByVideo = new Map();
  candidates.forEach((item) => {
    if (!bestByVideo.has(item.video.path)) bestByVideo.set(item.video.path, item);
  });

  const rows = videos.map((video) => ({
    video: video.name,
    videoPath: video.path,
    ext: video.ext,
    txtNumber: null,
    txtTitle: null,
    newName: null,
    score: 0,
    status: 'UNMATCHED',
    reason: 'Нет подходящей строки TXT'
  }));
  const byPath = new Map(rows.map((row) => [row.videoPath, row]));

  candidates.forEach((item) => {
    if (usedVideos.has(item.video.path) || usedTitles.has(item.title.number)) return;
    if (item.score < threshold) return;
    usedVideos.add(item.video.path);
    usedTitles.add(item.title.number);
    const row = byPath.get(item.video.path);
    row.txtNumber = item.title.number;
    row.txtTitle = item.title.raw;
    row.newName = `${item.title.number}${item.video.ext}`;
    row.score = item.score;
    row.status = 'MATCH';
    row.reason = 'Совпадение';
  });

  rows.forEach((row) => {
    if (row.status !== 'UNMATCHED') return;
    const best = bestByVideo.get(row.videoPath);
    if (!best) return;
    row.score = best.score;
    row.txtNumber = best.title.number;
    row.txtTitle = best.title.raw;
    row.newName = null;
    row.status = best.score > 0 ? 'LOW_SCORE' : 'UNMATCHED';
    row.reason = best.score > 0
      ? `Похожесть ${best.score}% ниже порога ${threshold}%`
      : 'Нет подходящей строки TXT';
  });

  const planned = new Map();
  rows.forEach((row) => {
    if (row.status !== 'MATCH') return;
    planned.set(row.videoPath, row.newName);
  });

  rows.forEach((row) => {
    if (row.status !== 'MATCH') return;
    if (sameFile(row.video, row.newName)) {
      row.status = 'ALREADY_OK';
      row.reason = 'Файл уже называется нужным номером';
      return;
    }
    const dest = path.join(directory, row.newName);
    if (!fs.existsSync(dest)) return;
    const occupier = videos.find((video) => sameFile(video.name, row.newName));
    if (occupier && planned.has(occupier.path) && !sameFile(planned.get(occupier.path), row.newName)) {
      return;
    }
    if (occupier && sameFile(occupier.path, row.videoPath)) return;
    row.status = 'CONFLICT';
    row.reason = `CONFLICT: ${row.newName} already exists`;
    row.newName = null;
  });

  const matched = rows.filter((row) => row.status === 'MATCH' || row.status === 'ALREADY_OK');
  const assignedNumbers = new Set(
    rows.filter((row) => row.status === 'MATCH' || row.status === 'ALREADY_OK').map((row) => row.txtNumber)
  );
  const missing = titles.filter((title) => !assignedNumbers.has(title.number));
  const unmatched = rows.filter((row) => row.status === 'UNMATCHED' || row.status === 'LOW_SCORE');
  const conflicts = rows.filter((row) => row.status === 'CONFLICT');
  const low = rows.filter((row) => row.status === 'LOW_SCORE');

  return {
    directory,
    minScore: threshold,
    videoCount: videos.length,
    titleCount: titles.length,
    rows,
    missing,
    unmatched,
    conflicts,
    low,
    matched,
    summary: {
      titles: titles.length,
      videos: videos.length,
      matched: matched.length,
      lowSimilarity: low.length,
      conflicts: conflicts.length,
      missing: missing.length,
      unmatched: unmatched.length
    }
  };
}

function writeUtf8(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

function writeReports(analysis, options = {}) {
  const dir = analysis.directory;
  const lines = [];
  lines.push('================================');
  lines.push('RESULT');
  lines.push('================================');
  lines.push(`TXT titles: ${analysis.summary.titles}`);
  lines.push(`Videos found: ${analysis.summary.videos}`);
  lines.push('');
  lines.push(`Matched: ${analysis.summary.matched}`);
  lines.push(`Renamed: ${options.renamed != null ? options.renamed : 0}`);
  lines.push('');
  lines.push(`Low similarity: ${analysis.summary.lowSimilarity}`);
  lines.push(`Conflicts: ${analysis.summary.conflicts}`);
  lines.push('');
  lines.push(`Missing videos: ${analysis.summary.missing}`);
  lines.push(`Unmatched videos: ${analysis.summary.unmatched}`);
  lines.push('================================');
  lines.push('');
  lines.push('Таблица:');
  analysis.rows.forEach((row) => {
    lines.push(
      `${row.video} | №${row.txtNumber || '—'} | ${row.txtTitle || '—'} | ${row.score}% | ${row.status}`
    );
  });
  writeUtf8(path.join(dir, 'rename_report.txt'), `${lines.join('\n')}\n`);

  const missingText = analysis.missing.map((title) => `№${title.number}\t${title.raw}`).join('\n');
  writeUtf8(path.join(dir, 'missing_titles.txt'), missingText ? `${missingText}\n` : '');
  writeUtf8(path.join(dir, 'nazvaniya_missing.txt'), missingText ? `${missingText}\n` : '');

  const unmatchedText = analysis.unmatched
    .map((row) => `${row.video}\t${row.score}%\t${row.reason}`)
    .join('\n');
  writeUtf8(path.join(dir, 'unmatched_videos.txt'), unmatchedText ? `${unmatchedText}\n` : '');
  writeUtf8(path.join(dir, 'videos_unmatched.txt'), unmatchedText ? `${unmatchedText}\n` : '');

  const conflictText = analysis.conflicts
    .map((row) => `${row.video}\t${row.reason}`)
    .join('\n');
  writeUtf8(path.join(dir, 'conflicts.txt'), conflictText ? `${conflictText}\n` : '');

  return path.join(dir, 'rename_report.txt');
}

function safeRename(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function applyRename(analysis, options = {}) {
  const dir = analysis.directory;
  const removeUnmatched = Boolean(options.removeUnmatchedVideos);
  const createReports = options.createReports !== false;
  const keepOriginalTxt = options.keepOriginalTxt !== false;
  const logs = [];
  let renamed = 0;
  let deleted = 0;

  const taken = new Set();
  analysis.rows.forEach((row) => {
    if ((row.status === 'MATCH' || row.status === 'ALREADY_OK') && row.txtNumber) {
      if (taken.has(row.txtNumber)) {
        throw new Error(`Два видео претендуют на TXT №${row.txtNumber}`);
      }
      taken.add(row.txtNumber);
    }
  });

  const moves = analysis.rows.filter((row) => row.status === 'MATCH' && row.newName);
  const temps = [];
  moves.forEach((row, index) => {
    const tempName = `${TEMP_PREFIX}${process.pid}-${index}${row.ext}`;
    const tempPath = path.join(dir, tempName);
    safeRename(row.videoPath, tempPath);
    temps.push({ row, tempPath });
  });

  temps.forEach(({ row, tempPath }) => {
    const dest = path.join(dir, row.newName);
    if (fs.existsSync(dest)) {
      row.status = 'CONFLICT';
      row.reason = `CONFLICT: ${row.newName} already exists`;
      logs.push(`✗ ${row.txtNumber} — conflict`);
      safeRename(tempPath, row.videoPath);
      return;
    }
    safeRename(tempPath, dest);
    row.videoPath = dest;
    renamed += 1;
    logs.push(`✓ ${row.newName}`);
  });

  if (removeUnmatched) {
    analysis.unmatched.forEach((row) => {
      if (!row.videoPath || !fs.existsSync(row.videoPath)) return;
      fs.unlinkSync(row.videoPath);
      deleted += 1;
      logs.push(`⚠ ${row.video} — unmatched deleted`);
    });
  }

  analysis.missing.forEach((title) => {
    logs.push(`⚠ ${title.number} — video not found`);
  });
  analysis.low.forEach((row) => {
    if (!removeUnmatched) logs.push(`⚠ ${row.video} — low similarity`);
  });

  if (createReports) writeReports(analysis, { renamed, deleted });
  if (!keepOriginalTxt) {
    logs.push('Исходный nazvaniya.txt не удалялся — только отчёты.');
  }

  const keptFiles = analysis.rows
    .filter((row) => (row.status === 'MATCH' || row.status === 'ALREADY_OK') && row.videoPath && fs.existsSync(row.videoPath))
    .map((row) => row.videoPath);

  return {
    renamed,
    deleted,
    logs,
    keptFiles,
    reportFile: path.join(dir, 'rename_report.txt'),
    summary: {
      ...analysis.summary,
      renamed,
      deleted
    }
  };
}

module.exports = {
  VIDEO_EXTS,
  DEFAULT_MIN_SCORE,
  stripKnownExtension,
  foldAccents,
  normalizeTitle,
  similarityScore,
  parseTitles,
  readTitlesFile,
  listVideos,
  analyzeRename,
  applyRename,
  writeReports
};
