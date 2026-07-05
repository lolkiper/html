import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const browsersDir = path.join(root, 'playwright-browsers');

fs.mkdirSync(browsersDir, { recursive: true });

const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: browsersDir,
};

console.log(`[bundle-playwright] Скачиваю Chromium в:\n  ${browsersDir}`);
console.log('[bundle-playwright] Это нужно один раз перед сборкой exe...');

execSync('npx playwright install chromium', {
  stdio: 'inherit',
  env,
  cwd: root,
});

console.log('[bundle-playwright] Готово. Chromium будет встроен в YT-Statico.exe');
