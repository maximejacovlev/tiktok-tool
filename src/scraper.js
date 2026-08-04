const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Referer: 'https://www.tiktok.com/',
};

/**
 * Scrape a TikTok photo-carousel post URL and return an array of
 * full-resolution image URLs, plus the caption if available.
 */
async function scrapeCarousel(tiktokUrl) {
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const agent = proxyServer ? new HttpsProxyAgent(proxyServer) : undefined;

  let data = null;
  const tried = new Set();

  for (const candidate of await buildFetchCandidates(tiktokUrl, agent)) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);

    const html = await fetchHtml(candidate, agent);
    if (!html) continue;

    const parsed = parseHydrationFromHtml(html);
    if (hasPostData(parsed)) {
      data = parsed;
      break;
    }
    if (!data) data = parsed;
  }

  if (!hasPostData(data) && !process.env.VERCEL) {
    const fallbackUrl = [...tried].find((u) => u.includes('tiktok.com/'));
    if (fallbackUrl) {
      data = await fetchHydrationDataWithBrowser(fallbackUrl, proxyServer);
    }
  }

  const { itemStruct, statusDetail, isVideoOnly } = extractItemStruct(data);

  if (!itemStruct) {
    const statusMsg = describeTiktokStatus(statusDetail);
    if (statusMsg) throw new Error(statusMsg);
    if (isBotShell(data)) {
      throw new Error(
        'TikTok n\'a pas renvoyé les données du post. Colle l\'URL complète depuis la barre d\'adresse (format @user/photo/123… ou @user/video/123…), pas un lien vm.tiktok.com.'
      );
    }
    throw new Error(
      "Impossible de trouver les données du post — le lien est-il bien un carrousel TikTok (URL contenant /photo/) ?"
    );
  }

  if (isVideoOnly) {
    throw new Error(
      "Ce lien pointe vers une vidéo TikTok classique, pas un carrousel photo. Utilise un lien avec /photo/ dans l'URL."
    );
  }

  const images = itemStruct?.imagePost?.images || [];
  if (!images.length) {
    throw new Error(
      "Ce post ne semble pas être un carrousel (pas d'images trouvées) — c'est peut-être une vidéo classique."
    );
  }

  const imageUrls = images
    .map((img, idx) => {
      const urlList = img?.imageURL?.urlList || img?.thumbnail?.urlList || [];
      return {
        index: idx,
        url: urlList[0] || null,
        width: img?.imageWidth,
        height: img?.imageHeight,
      };
    })
    .filter((i) => i.url);

  const caption = itemStruct?.desc || itemStruct?.imagePost?.title || '';

  return { caption, images: imageUrls };
}

function cleanInputUrl(input) {
  let url = String(input || '').trim();
  if (/^\d{15,25}$/.test(url)) {
    return `https://www.tiktok.com/video/${url}`;
  }
  const extracted = url.match(/https?:\/\/(?:[a-z0-9-]+\.)*tiktok\.com[^\s"'<>]*/i);
  if (extracted) url = extracted[0];
  url = url.replace(/[),.;]+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

function extractPostId(url) {
  const patterns = [
    /\/(?:photo|video)\/(\d{15,25})/i,
    /\/v\/(\d{15,25})(?:\.html)?/i,
    /[?&]share_item_id=(\d{15,25})/i,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  if (/^\d{15,25}$/.test(url)) return url;
  return null;
}

async function buildFetchCandidates(rawUrl, agent) {
  const cleaned = cleanInputUrl(rawUrl);
  const candidates = [];

  const bareId = extractPostId(cleaned);
  if (bareId && !cleaned.includes('tiktok.com')) {
    candidates.push(`https://www.tiktok.com/video/${bareId}`);
  }

  candidates.push(normalizeTiktokUrl(cleaned));

  try {
    const response = await fetch(cleaned, {
      headers: FETCH_HEADERS,
      agent,
      redirect: 'follow',
    });
    if (response.url && !response.url.endsWith('tiktok.com/')) {
      candidates.push(normalizeTiktokUrl(stripTrackingParams(response.url)));
    }
    const redirectedId = extractPostId(response.url);
    if (redirectedId) {
      candidates.push(`https://www.tiktok.com/video/${redirectedId}`);
      const oembedUrl = await resolveViaOembed(redirectedId, agent);
      if (oembedUrl) candidates.push(oembedUrl);
    }
  } catch {
    // fall through to other candidates
  }

  const inputId = extractPostId(cleaned);
  if (inputId) {
    candidates.push(`https://www.tiktok.com/video/${inputId}`);
    const oembedUrl = await resolveViaOembed(inputId, agent);
    if (oembedUrl) candidates.push(oembedUrl);
  }

  return [...new Set(candidates.filter(Boolean))];
}

async function resolveViaOembed(postId, agent) {
  try {
    const response = await fetch(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(`https://www.tiktok.com/video/${postId}`)}`,
      { headers: FETCH_HEADERS, agent }
    );
    if (!response.ok) return null;
    const payload = await response.json();
    const cite = payload.html?.match(/cite="([^"]+)"/)?.[1];
    return cite ? normalizeTiktokUrl(cite) : null;
  } catch {
    return null;
  }
}

async function fetchHtml(url, agent) {
  try {
    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      agent,
      redirect: 'follow',
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function fetchHydrationDataWithBrowser(url, proxyServer) {
  if (process.env.VERCEL) return null;
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return null;
  }

  const browser = await chromium.launch({
    executablePath: findExecutable(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    proxy: proxyServer ? { server: proxyServer } : undefined,
  });

  try {
    const context = await browser.newContext({
      userAgent: FETCH_HEADERS['User-Agent'],
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': FETCH_HEADERS['Accept-Language'],
        Referer: FETCH_HEADERS.Referer,
      },
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__', {
      state: 'attached',
      timeout: 15000,
    });
    await page.waitForTimeout(2500);

    const raw = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script#__UNIVERSAL_DATA_FOR_REHYDRATION__')];
      const best = scripts.sort(
        (a, b) => (b.textContent?.length || 0) - (a.textContent?.length || 0)
      )[0];
      return best?.textContent || null;
    });

    return raw ? JSON.parse(raw) : null;
  } finally {
    await browser.close();
  }
}

function parseHydrationFromHtml(html) {
  const match = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function hasPostData(data) {
  if (!data) return false;
  const raw = JSON.stringify(data);
  return raw.includes('itemStruct') && raw.includes('imagePost');
}

function isBotShell(data) {
  const scope = data?.__DEFAULT_SCOPE__;
  if (!scope) return true;
  return !scope['webapp.video-detail'] && !JSON.stringify(data).includes('imagePost');
}

function normalizeTiktokUrl(url) {
  return stripTrackingParams(url.trim()).replace(/\/photo\//i, '/video/');
}

function stripTrackingParams(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('_r');
    parsed.searchParams.delete('_t');
    return parsed.toString();
  } catch {
    return url.split('?')[0];
  }
}

function findExecutable() {
  const fs = require('fs');
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function extractItemStruct(data) {
  const scope = data?.__DEFAULT_SCOPE__ || data;
  const detailKeys = [
    'webapp.video-detail',
    'webapp.reflow.video.detail',
    'webapp.photo-detail',
  ];

  for (const key of detailKeys) {
    const detail = scope[key];
    if (!detail) continue;
    const itemStruct = detail?.itemInfo?.itemStruct;
    if (itemStruct?.imagePost?.images?.length) {
      return { itemStruct, statusDetail: detail, isVideoOnly: false };
    }
    if (itemStruct?.video && !itemStruct?.imagePost) {
      return { itemStruct: null, statusDetail: detail, isVideoOnly: true };
    }
    if (detail.statusCode && detail.statusCode !== 0) {
      return { itemStruct: null, statusDetail: detail, isVideoOnly: false };
    }
  }

  const found = deepFindItemStruct(data);
  return { itemStruct: found, statusDetail: null, isVideoOnly: false };
}

function describeTiktokStatus(detail) {
  if (!detail?.statusCode) return null;
  const code = detail.statusCode;
  const msg = detail.statusMsg || '';
  if (code === 10204) return 'Ce post TikTok est indisponible ou supprimé.';
  if (code === 10231) return 'Post bloqué par région — essaie avec un VPN.';
  if (code === 10222 || code === 10203) {
    return 'TikTok demande une connexion pour ce post — le scraping automatisé est bloqué.';
  }
  if (msg) return `TikTok a renvoyé une erreur (${code}) : ${msg}`;
  return `TikTok a renvoyé une erreur (${code}).`;
}

function deepFindItemStruct(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return null;

  if (node.imagePost?.images?.length) return node;

  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') {
      const found = deepFindItemStruct(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

module.exports = { scrapeCarousel, normalizeTiktokUrl, extractItemStruct, cleanInputUrl, extractPostId };
