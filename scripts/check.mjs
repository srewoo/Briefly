import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const manifestPath = path.join(root, 'Briefly', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sidepanelHtmlPath = path.join(root, 'Briefly', 'sidepanel', 'sidepanel.html');
const sidepanelJsPath = path.join(root, 'Briefly', 'sidepanel', 'sidepanel.js');

const jsChecks = [
  { file: path.join(root, 'Briefly', 'background', 'service_worker.js'), args: ['--experimental-default-type=module', '--check'] },
  { file: path.join(root, 'Briefly', 'background', 'intentClassifier.js'), args: ['--check'] },
  { file: path.join(root, 'Briefly', 'background', 'outputRouter.js'), args: ['--experimental-default-type=module', '--check'] },
  { file: path.join(root, 'Briefly', 'background', 'modelUtils.mjs'), args: ['--check'] },
  { file: path.join(root, 'Briefly', 'background', 'routerUtils.mjs'), args: ['--check'] },
  { file: path.join(root, 'Briefly', 'content', 'contentScript.js'), args: ['--check'] },
  { file: path.join(root, 'Briefly', 'offscreen', 'audioProcessor.js'), args: ['--check'] },
  { file: path.join(root, 'Briefly', 'sidepanel', 'sidepanel.js'), args: ['--check'] }
];

for (const check of jsChecks) {
  if (!existsSync(check.file)) {
    throw new Error(`Missing file: ${check.file}`);
  }

  execFileSync(process.execPath, [...check.args, check.file], {
    cwd: root,
    stdio: 'pipe'
  });
}

for (const iconPath of Object.values(manifest.icons || {})) {
  const fullPath = path.join(root, 'Briefly', iconPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing manifest icon: ${fullPath}`);
  }
}

if (!existsSync(path.join(root, 'Briefly', manifest.background?.service_worker || ''))) {
  throw new Error('Manifest background service worker is missing.');
}

const sidepanelHtml = readFileSync(sidepanelHtmlPath, 'utf8');
const sidepanelJs = readFileSync(sidepanelJsPath, 'utf8');

const htmlIds = new Set(
  Array.from(sidepanelHtml.matchAll(/\bid="([^"]+)"/g), match => match[1])
);
const referencedIds = new Set(
  Array.from(sidepanelJs.matchAll(/\$\('([^']+)'\)/g), match => match[1])
);

for (const id of referencedIds) {
  if (!htmlIds.has(id)) {
    throw new Error(`sidepanel.js references missing HTML id: ${id}`);
  }
}

const requiredPermissions = ['notifications', 'scripting', 'storage', 'tabs'];
for (const permission of requiredPermissions) {
  if (!manifest.permissions?.includes(permission)) {
    throw new Error(`Manifest missing required permission: ${permission}`);
  }
}

console.log('Briefly checks passed.');
