/**
 * Mobile app shell checks: manifest, icons, service worker, install wiring.
 *
 * These are asset/config assertions, not behavioural scoring. The behavioural
 * suite is test/judge-evaluation.js plus the WebSocket E2E.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function pngSize(path) {
  const buf = readFileSync(path);
  const signature = buf.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

console.log('\n📲 MOBILE APP SHELL (PWA)');

const manifest = readJson(join(PUBLIC, 'manifest.webmanifest'));
check('manifest is valid JSON', Boolean(manifest));
check('manifest names the app', manifest?.name?.includes('Bolti Bahi'), manifest?.name);
check('manifest has a short name', manifest?.short_name === 'Bolti Bahi', manifest?.short_name);
check('starts at the app root', manifest?.start_url === '/');
check('launches standalone', manifest?.display === 'standalone');
check('declares Hindi locale', manifest?.lang?.startsWith('hi'), manifest?.lang);
check('sets a theme colour', /^#[0-9A-Fa-f]{6}$/.test(manifest?.theme_color || ''), manifest?.theme_color);

const icons = manifest?.icons || [];
check('declares a 192px icon', icons.some((i) => i.sizes === '192x192'));
check('declares a 512px icon', icons.some((i) => i.sizes === '512x512'));
check('declares a maskable icon', icons.some((i) => i.purpose === 'maskable'));

for (const icon of icons) {
  const path = join(PUBLIC, icon.src.replace(/^\//, ''));
  const size = existsSync(path) ? pngSize(path) : null;
  const expected = Number(String(icon.sizes).split('x')[0]);
  check(`${icon.src} exists as ${icon.sizes} PNG`, Boolean(size) && size.width === expected && size.height === expected);
}

const appleIcon = join(PUBLIC, 'icons', 'apple-touch-icon-180.png');
check('has an iOS home-screen icon', existsSync(appleIcon) && pngSize(appleIcon)?.width === 180);

const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
check('service worker precaches the shell', /cache\.addAll/.test(sw) && /'\/index\.html'/.test(sw));
check('service worker has an offline fallback', /offline\.html/.test(sw));
check('offline API calls fail explicitly', /offline:\s*true/.test(sw));
check('service worker never fabricates ledger data', !/totalOutstanding|8750|8,750/.test(sw));

const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
check('page links the manifest', /rel="manifest"\s+href="\/manifest\.webmanifest"/.test(html));
check('page registers the service worker', /serviceWorker\.register\('\/sw\.js'\)/.test(html));
check('page declares a theme colour', /name="theme-color"/.test(html));
check('page supports notched screens', /viewport-fit=cover/.test(html));
check('page does not block pinch zoom', !/user-scalable=no/.test(html));
check('page handles the install prompt', /beforeinstallprompt/.test(html));
check('page offers an iOS install hint', /Add to Home Screen/.test(html));
check('page detects low-end devices', /deviceMemory/.test(html) && /hardwareConcurrency/.test(html));
check('page caps chat DOM growth', /MAX_NODES/.test(html));
check('page asks for 16 kHz capture', /sampleRate:\s*16000/.test(html));
check('page keeps no fake balances', !/8,750|8750|Ramesh Bhai/.test(html));
check('page contains no simulated recognition', !/simulateOfflineVoiceRecognition/.test(html));
check('page has no MediaRecorder duplicate encode', !/new MediaRecorder/.test(html));

const offline = readFileSync(join(PUBLIC, 'offline.html'), 'utf8');
check('offline page is branded and honest', /Bolti Bahi/.test(offline) && /offline/i.test(offline));

const pkg = readJson(join(ROOT, 'package.json'));
check('package is named bolti-bahi', pkg?.name === 'bolti-bahi', pkg?.name);
check('package exposes the accuracy bench', Boolean(pkg?.scripts?.['bench:stt']));
check('package exposes icon generation', Boolean(pkg?.scripts?.icons));

const serverSource = readFileSync(join(ROOT, 'server.js'), 'utf8');
check('server serves the service worker uncached', /sw\.js/.test(serverSource) && /Cache-Control/.test(serverSource));
check('server serves the manifest', /express\.static/.test(serverSource));

check('public directory has no build step', !existsSync(join(ROOT, 'vite.config.js')));
check('service worker file is non-trivial', statSync(join(PUBLIC, 'sw.js')).size > 1000);
check('page exposes the in-app key settings', /settings-modal-overlay/.test(html) && /\/api\/settings\/gnani-key/.test(html));

// Android shell
const androidManifest = readFileSync(join(ROOT, 'android', 'AndroidManifest.xml'), 'utf8');
check('Android manifest declares the package', /package="ai\.boltibahi\.app"/.test(androidManifest));
check('Android app requests the microphone', /RECORD_AUDIO/.test(androidManifest));
check('Android app allows LAN cleartext', /usesCleartextTraffic="true"/.test(androidManifest));

const mainActivity = readFileSync(join(ROOT, 'android', 'java', 'ai', 'boltibahi', 'app', 'MainActivity.java'), 'utf8');
check('Android app grants WebView audio capture', /onPermissionRequest/.test(mainActivity) && /AUDIO_CAPTURE/.test(mainActivity));
check('Android app can change the server URL', /AndroidHost/.test(mainActivity) && /changeServer/.test(mainActivity));
check('Android app validates the http(s) scheme', /startsWith\("https:\/\/"\)/.test(mainActivity));

const apkPath = join(ROOT, 'android', 'bolti-bahi-1.4.0-debug.apk');
check('signed debug APK is present', existsSync(apkPath) && statSync(apkPath).size > 15000);
check('APK build script is present', existsSync(join(ROOT, 'android', 'build-apk.sh')));

console.log(`\n${failed === 0 ? '✅' : '❌'} PWA shell: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
