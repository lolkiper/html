import fs from 'fs';
import path from 'path';

const FARM_FILES = ['main.mjs', 'youtube-studio.mjs'];

/**
 * Копирует main.mjs и youtube-studio.mjs рядом с EXE при первом запуске.
 */
export function ensureFarmScripts(baseDir, panelDir) {
  const copied = [];
  const missing = [];

  for (const file of FARM_FILES) {
    const dest = path.join(baseDir, file);
    if (fs.existsSync(dest)) continue;

    const sources = [
      path.join(process.resourcesPath || '', 'farm', file),
      path.join(panelDir, '..', file),
    ];

    let found = false;
    for (const src of sources) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        copied.push(file);
        found = true;
        break;
      }
    }
    if (!found) missing.push(file);
  }

  const videosDir = path.join(baseDir, 'videos');
  if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

  return { copied, missing };
}
