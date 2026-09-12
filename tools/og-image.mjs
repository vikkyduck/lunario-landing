/* og-картинка 1200×630 для превью ссылок в Telegram / WhatsApp / соцсетях.
   В духе обложки lunario.online: ночь, фиолетовый орб сверху, золотой снизу-справа,
   редкая звёздная пыль, луна из бренд-кита, wordmark «Лунарио» Comfortaa Light и строка Onest.
   Веб-шрифты в file:// Chrome режет — вшиваем base64. Небо детерминировано (свой PRNG).

   Запуск:  node tools/og-image.mjs
   Результат: site/assets/og.png и ../lunario-app/site/assets/og.png (1200×630 @1x, непрозрачный).
   После замены картинки поднять ?v= в og:image — мессенджеры кэшируют превью. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = join(ROOT, 'site', 'assets', 'fonts');
const BRAND = join(ROOT, 'site', 'brand');
const OUT = join(ROOT, 'site', 'assets', 'og.png');
const OUT_APP = join(ROOT, '..', 'lunario-app', 'site', 'assets', 'og.png');
const TMP = join(tmpdir(), 'lunario-og-image');
const MAX_BYTES = 300 * 1024;
mkdirSync(TMP, { recursive: true });

const W = 1200, H = 630;

/* file:// в Chrome режет @font-face с диска — шрифты вшиваем base64 */
const b64 = (p) => readFileSync(p).toString('base64');
const CYR = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';
const LAT = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const face = (family, weight, file, range) => `
@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};
  src:url(data:font/woff2;base64,${b64(join(FONTS, file))}) format('woff2');unicode-range:${range}}`;
const fontCss =
  face('Comfortaa', '300 700', 'comfortaa-300-700-cyrillic.woff2', CYR) +
  face('Comfortaa', '300 700', 'comfortaa-300-700-latin.woff2', LAT) +
  face('Onest', '100 900', 'onest-400-cyrillic.woff2', CYR) +
  face('Onest', '100 900', 'onest-400-latin.woff2', LAT);

/* mulberry32 — одно и то же небо при каждом рендере */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* звёздная пыль как на обложке: rgb(245,240,224), r .35–.95, альфа .14–.44; редкие яркие — с ореолом */
function stars({ n, seed, avoid = [], bright = 0 }) {
  const r = rng(seed);
  const out = [];
  const blocked = (x, y) => avoid.some(b => x > b[0] && x < b[2] && y > b[1] && y < b[3]);
  let guard = 0;
  while (out.length < n && guard++ < n * 40) {
    const x = r() * W, y = r() * H;
    if (blocked(x, y)) continue;
    const a = 0.14 + r() * 0.30;
    const d = (0.35 + r() * 0.6) * 2;
    out.push(`<i style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${d.toFixed(2)}px;height:${d.toFixed(2)}px;opacity:${a.toFixed(3)}"></i>`);
  }
  for (let i = 0; i < bright; i++) {
    let x, y, tries = 0;
    do { x = r() * W; y = r() * H; } while (blocked(x, y) && tries++ < 200);
    const a = 0.55 + r() * 0.35;
    r();  /* сохраняем последовательность PRNG */
    out.push(`<b style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;opacity:${a.toFixed(3)}"></b>`);
  }
  return out.join('');
}

/* ---------- сцена: луна 150px, «Лунарио» 96px, строка 30px — блок отцентрован по вертикали ---------- */
const MOON = 150, MOON_TOP = 138, WORD_TOP = 306, TAG_TOP = 428;
const moon = readFileSync(join(BRAND, 'logo-mark.svg'), 'utf8')
  .replace(/<svg /, `<svg width="${MOON}" height="${MOON}" `);

const css = `
html,body{margin:0;padding:0}
html{background:#0b0a14}
.wrap{position:relative;width:${W}px;height:${H}px;overflow:hidden;
  background:linear-gradient(180deg,#141126 0%,#0b0a14 70%)}
/* орбы как на обложке: фиолетовый сверху, золотой снизу-справа */
.orb{position:absolute;border-radius:50%;filter:blur(90px);opacity:.55}
.orb-1{width:760px;height:760px;top:-460px;left:50%;transform:translateX(-50%);
  background:radial-gradient(circle,#6d5bd0 0%,transparent 65%)}
.orb-2{width:460px;height:460px;bottom:-190px;right:-120px;
  background:radial-gradient(circle,rgba(217,184,104,.5) 0%,transparent 65%)}
/* ночное облако слева — чуть глубины, как на обложке */
.cloud{position:absolute;border-radius:50%;filter:blur(110px);opacity:.22;
  width:840px;height:310px;top:40px;left:-220px;
  background:radial-gradient(ellipse,rgba(141,130,190,.5) 0%,transparent 68%)}
/* пыль */
i,b{position:absolute;border-radius:50%;transform:translate(-50%,-50%);display:block}
i{background:rgb(245,240,224)}
b{width:6px;height:6px;background:radial-gradient(circle,#fffcf4 0%,rgba(240,228,196,.55) 35%,rgba(232,206,150,0) 70%)}
b::after{content:"";position:absolute;left:50%;top:50%;width:2.2px;height:2.2px;border-radius:50%;
  background:#fffdf7;transform:translate(-50%,-50%)}
/* луна: диск в знаке смещён влево от центра (звёзды справа) — компенсируем, как в письме */
.mark{position:absolute;left:50%;top:${MOON_TOP}px;transform:translateX(calc(-50% + 9px));
  width:${MOON}px;height:${MOON}px;line-height:0;
  filter:drop-shadow(0 10px 48px rgba(217,184,104,.36))}
.mark svg{display:block}
.wordmark{position:absolute;left:0;right:0;top:${WORD_TOP}px;margin:0;text-align:center;
  font-family:'Comfortaa',sans-serif;font-weight:300;font-size:96px;line-height:1.14;letter-spacing:.01em;
  color:#f5f2ea;text-shadow:0 2px 24px rgba(11,10,20,.55)}
.tagline{position:absolute;left:0;right:0;top:${TAG_TOP}px;margin:0;text-align:center;
  font-family:'Onest',sans-serif;font-weight:500;font-size:30px;line-height:1.6;letter-spacing:.005em;
  color:#f5f2ea;text-shadow:0 1px 12px rgba(11,10,20,.7)}
`;

const body =
  `<div class="orb orb-1"></div><div class="orb orb-2"></div><div class="cloud"></div>` +
  stars({ n: 120, seed: 20260912, bright: 5, avoid: [[440, 110, 760, 300], [300, 300, 900, 500]] }) +
  `<div class="mark">${moon}</div>` +
  `<h1 class="wordmark">Лунарио</h1>` +
  `<p class="tagline">Пространство, где можно услышать себя</p>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}${css}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
const src = join(TMP, 'og.html');
writeFileSync(src, html);

const res = spawnSync(CHROME, [
  '--headless=new', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--window-size=${W},${H}`, `--screenshot=${OUT}`, `file://${src}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
if (res.status !== 0) throw new Error(`chrome: ${res.stderr}`);

const size = statSync(OUT).size;
console.log(`${OUT} ← ${W}×${H} @1x, ${(size / 1024).toFixed(0)} КБ`);
if (size > MAX_BYTES) throw new Error(`og.png больше ${MAX_BYTES / 1024} КБ — уменьшить пыль или свечение`);

if (existsSync(dirname(OUT_APP))) {
  copyFileSync(OUT, OUT_APP);
  console.log(`${OUT_APP} ← копия`);
}

rmSync(TMP, { recursive: true, force: true });
