import fs from 'fs';
import path from 'path';

/**
 * Очередь публикации: индекс канала = индекс видео = индекс строки nazvaniya.txt.
 * Название не обрезается, не переводится и не заменяется.
 */

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm']);

export function countMismatchMessage(channelCount, videoCount, titleCount) {
  return `Ошибка: количество каналов (${channelCount}), видео (${videoCount}) и названий (${titleCount}) не совпадает. Публикация остановлена.`;
}

/** Порядок строк файла. Хвостовой перевод строки не добавляет пустое название. */
export function readTitleLines(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Стабильная естественная сортировка: 1.mp4, 2.mp4, 10.mp4. */
export function compareVideoNames(left, right) {
  return String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' });
}

export function listVideoNames(fileNames) {
  return fileNames
    .filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .slice()
    .sort(compareVideoNames);
}

/** Список каналов в том порядке, в каком они записаны в таблице профилей. */
export function channelsFromMapping(profileMapping) {
  if (!profileMapping || typeof profileMapping !== 'object') return [];
  return Object.entries(profileMapping)
    .map(([profileId, data]) => ({
      profileId,
      channelNumber: Array.isArray(data) ? data[0] : data,
    }))
    .filter((channel) => channel.channelNumber !== undefined
      && channel.channelNumber !== null
      && String(channel.channelNumber) !== '');
}

export function assemblePlan({ channels, videoNames, titles }) {
  if (channels.length !== videoNames.length || videoNames.length !== titles.length) {
    const error = new Error(countMismatchMessage(channels.length, videoNames.length, titles.length));
    error.code = 'COUNT_MISMATCH';
    throw error;
  }

  return channels.map((channel, index) => {
    const videoName = videoNames[index];
    const title = titles[index];
    if (videoName == null || videoName === '') {
      const error = new Error(`Ошибка: отсутствует видео №${index + 1}. Публикация остановлена.`);
      error.code = 'MISSING_VIDEO';
      throw error;
    }
    if (title == null) {
      const error = new Error(`Ошибка: отсутствует название №${index + 1}. Публикация остановлена.`);
      error.code = 'MISSING_TITLE';
      throw error;
    }
    return {
      index,
      profileId: channel.profileId,
      channelNumber: channel.channelNumber,
      channelLabel: `Канал ${channel.channelNumber}`,
      videoName,
      title,
    };
  });
}

export function formatPublishPreview(item, total) {
  return [
    `[${item.index + 1}/${total}]`,
    `Канал: ${item.channelLabel}`,
    `Видео: ${item.videoName}`,
    `Название: ${item.title}`,
  ].join('\n');
}

export function resolveTitlesFile(videosDir, baseDir) {
  const inVideos = path.join(videosDir, 'nazvaniya.txt');
  if (fs.existsSync(inVideos)) return inVideos;
  if (baseDir) {
    const inBase = path.join(baseDir, 'nazvaniya.txt');
    if (fs.existsSync(inBase)) return inBase;
  }
  return inVideos;
}

export function buildPublishPlanFromDisk({ profileMapping, videosDir, titlesFile }) {
  if (!videosDir || !fs.existsSync(videosDir)) {
    throw new Error(`Ошибка: папка с видео не найдена (${videosDir || ''}). Публикация остановлена.`);
  }
  if (!titlesFile || !fs.existsSync(titlesFile)) {
    throw new Error(`Ошибка: файл nazvaniya.txt не найден (${titlesFile || 'nazvaniya.txt'}). Публикация остановлена.`);
  }

  const channels = channelsFromMapping(profileMapping);
  const videoNames = listVideoNames(
    fs.readdirSync(videosDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  const titles = readTitleLines(fs.readFileSync(titlesFile, 'utf8'));
  const items = assemblePlan({ channels, videoNames, titles });
  return { items, channels, videoNames, titles };
}
