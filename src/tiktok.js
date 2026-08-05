/**
 * Parse TikTok video/photo ID from a post URL.
 * Supports: /@user/video/123, /@user/photo/123
 */
function parseTikTokVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/(video|photo)\/(\d+)/);
  return match ? match[2] : null;
}

function isTikTokPostUrl(url) {
  return !!parseTikTokVideoId(url);
}

function isConfigured() {
  return !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

function getRedirectUri(req) {
  if (process.env.TIKTOK_REDIRECT_URI) return process.env.TIKTOK_REDIRECT_URI;
  const host = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `${req.protocol}://${req.get('host')}`;
  return `${host}/api/tiktok/callback`;
}

function getAuthUrl(req, state) {
  const redirectUri = getRedirectUri(req);
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    scope: 'user.info.basic,video.list',
    response_type: 'code',
    redirect_uri: redirectUri,
    state: state || 'tiktok-tool',
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

async function exchangeCodeForToken(code, redirectUri) {
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error?.message || 'Échec OAuth TikTok.');
  }
  return data;
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error?.message || 'Refresh token TikTok échoué.');
  }
  return data;
}

async function queryVideoMetrics(accessToken, videoIds) {
  if (!videoIds.length) return [];
  const fields = 'id,title,view_count,like_count,comment_count,share_count,create_time';
  const res = await fetch(`https://open.tiktokapis.com/v2/video/query/?fields=${fields}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ filters: { video_ids: videoIds.slice(0, 20) } }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || data.error?.code || 'Requête analytics TikTok échouée.');
  }
  return data.data?.videos || [];
}

module.exports = {
  parseTikTokVideoId,
  isTikTokPostUrl,
  isConfigured,
  getRedirectUri,
  getAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  queryVideoMetrics,
};
