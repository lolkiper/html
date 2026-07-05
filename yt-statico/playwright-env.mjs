import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function resolvePlaywrightBrowsersPath(options = {}) {
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const execPath = options.execPath || process.execPath;
  const cwd = options.cwd || process.cwd();

  const candidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    resourcesPath ? path.join(resourcesPath, 'playwright-browsers') : null,
    execPath ? path.join(path.dirname(execPath), 'playwright-browsers') : null,
    path.join(cwd, 'playwright-browsers'),
    path.join(MODULE_DIR, 'playwright-browsers'),
  ].filter(Boolean);

  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

export function initPlaywrightBrowsers(options = {}) {
  const resolved = resolvePlaywrightBrowsersPath(options);
  if (resolved) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = resolved;
    return resolved;
  }
  return null;
}
