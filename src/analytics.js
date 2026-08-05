const { refreshAccessToken, queryVideoMetrics } = require('./tiktok');

async function getValidAccessToken(store) {
  const auth = await store.getTikTokAuth?.();
  if (!auth?.accessToken) return null;

  const expiresAt = auth.expiresAt ? new Date(auth.expiresAt).getTime() : 0;
  if (expiresAt > Date.now() + 5 * 60 * 1000) {
    return auth.accessToken;
  }

  if (!auth.refreshToken) return null;
  const refreshed = await refreshAccessToken(auth.refreshToken);
  await store.saveTikTokAuth({
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || auth.refreshToken,
    openId: refreshed.open_id || auth.openId,
    expiresIn: refreshed.expires_in,
  });
  return refreshed.access_token;
}

async function refreshPostedAnalytics(store) {
  const token = await getValidAccessToken(store);
  if (!token) {
    throw new Error('Compte TikTok non connecté. Connecte ton compte depuis Analytics.');
  }

  const posted = await store.listPostedProjects();
  const withIds = posted.filter((p) => p.tiktokVideoId);
  if (!withIds.length) {
    return { updated: 0, projects: posted, message: 'Aucun carrousel publié avec un lien TikTok valide.' };
  }

  let updated = 0;
  for (let i = 0; i < withIds.length; i += 20) {
    const batch = withIds.slice(i, i + 20);
    const videos = await queryVideoMetrics(
      token,
      batch.map((p) => p.tiktokVideoId)
    );
    const byId = Object.fromEntries(videos.map((v) => [String(v.id), v]));
    for (const project of batch) {
      const video = byId[String(project.tiktokVideoId)];
      if (!video) continue;
      await store.updateProjectAnalytics(project.id, {
        viewCount: video.view_count || 0,
        likeCount: video.like_count || 0,
        commentCount: video.comment_count || 0,
        shareCount: video.share_count || 0,
      });
      updated++;
    }
  }

  return { updated, projects: await store.listPostedProjects() };
}

module.exports = { getValidAccessToken, refreshPostedAnalytics };
