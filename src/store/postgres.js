const { sql } = require('@vercel/postgres');
const { PROJECT_STATUSES } = require('./constants');
const blobStore = require('./blob');
const { parseTikTokVideoId } = require('../tiktok');

let ready = false;

function ensurePostgresEnv() {
  if (!process.env.POSTGRES_URL && process.env.DATABASE_URL) {
    process.env.POSTGRES_URL = process.env.DATABASE_URL;
  }
  if (!process.env.POSTGRES_URL_NON_POOLING && process.env.DATABASE_URL_UNPOOLED) {
    process.env.POSTGRES_URL_NON_POOLING = process.env.DATABASE_URL_UNPOOLED;
  }
}

function getEnvStatus() {
  ensurePostgresEnv();
  return {
    postgres: !!(process.env.POSTGRES_URL || process.env.DATABASE_URL),
    blob: blobStore.isBlobConfigured(),
  };
}

function isAvailable() {
  const { postgres, blob } = getEnvStatus();
  return postgres && blob;
}

async function init() {
  if (ready || !isAvailable()) return;
  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'to_edit',
      caption TEXT DEFAULT '',
      source_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS project_slides (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slide_index INT NOT NULL,
      file_url TEXT NOT NULL,
      PRIMARY KEY (project_id, slide_index)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS titles (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS bank_images (
      id TEXT PRIMARY KEY,
      file_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await migrateSchema();
  ready = true;
}

async function migrateSchema() {
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS posted_url TEXT DEFAULT ''`;
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS tiktok_video_id TEXT DEFAULT ''`;
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS view_count BIGINT DEFAULT 0`;
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS like_count BIGINT DEFAULT 0`;
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS comment_count BIGINT DEFAULT 0`;
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS share_count BIGINT DEFAULT 0`;
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS analytics_updated_at TIMESTAMPTZ`;
  await sql`
    CREATE TABLE IF NOT EXISTS tiktok_auth (
      id TEXT PRIMARY KEY DEFAULT 'default',
      access_token TEXT,
      refresh_token TEXT,
      open_id TEXT,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

function rowToProject(row, slideCount) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    caption: row.caption || '',
    sourceUrl: row.source_url || '',
    postedUrl: row.posted_url || '',
    tiktokVideoId: row.tiktok_video_id || '',
    viewCount: Number(row.view_count) || 0,
    likeCount: Number(row.like_count) || 0,
    commentCount: Number(row.comment_count) || 0,
    shareCount: Number(row.share_count) || 0,
    analyticsUpdatedAt: row.analytics_updated_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    slideCount,
  };
}

async function countSlides(projectId) {
  const { rows } = await sql`
    SELECT COUNT(*)::int AS count FROM project_slides WHERE project_id = ${projectId}
  `;
  return rows[0]?.count || 0;
}

async function listProjects() {
  const { rows } = await sql`SELECT * FROM projects ORDER BY updated_at DESC`;
  const projects = [];
  for (const row of rows) {
    projects.push(rowToProject(row, await countSlides(row.id)));
  }
  return projects;
}

async function getProject(id) {
  const { rows } = await sql`SELECT * FROM projects WHERE id = ${id}`;
  if (!rows.length) return null;
  const { rows: slideRows } = await sql`
    SELECT slide_index, file_url FROM project_slides
    WHERE project_id = ${id} ORDER BY slide_index ASC
  `;
  const project = rowToProject(rows[0], slideRows.length);
  project.slides = slideRows.map((s) => ({
    index: s.slide_index,
    url: blobStore.toClientUrl(s.file_url),
  }));
  return project;
}

async function createProject({ name, status, caption, sourceUrl, postedUrl, slideCount }) {
  const id = `project-${Date.now()}`;
  const safeName = (name || `carrousel-${Date.now()}`).replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim();
  const videoId = parseTikTokVideoId(postedUrl || '') || '';
  await sql`
    INSERT INTO projects (id, name, status, caption, source_url, posted_url, tiktok_video_id)
    VALUES (${id}, ${safeName}, ${status || 'to_edit'}, ${caption || ''}, ${sourceUrl || ''}, ${postedUrl || ''}, ${videoId})
  `;
  return { ...(await getProject(id)), slideCount: slideCount || 0 };
}

async function updateProject(id, { name, status, caption, sourceUrl, postedUrl }) {
  const existing = await getProject(id);
  if (!existing) return null;
  const safeName = name ? name.replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim() : existing.name;
  const nextPostedUrl = postedUrl !== undefined ? postedUrl : existing.postedUrl;
  const videoId = parseTikTokVideoId(nextPostedUrl || '') || '';
  await sql`
    UPDATE projects SET
      name = ${safeName},
      status = ${status || existing.status},
      caption = ${caption !== undefined ? caption : existing.caption},
      source_url = ${sourceUrl !== undefined ? sourceUrl : existing.sourceUrl},
      posted_url = ${nextPostedUrl || ''},
      tiktok_video_id = ${videoId},
      updated_at = NOW()
    WHERE id = ${id}
  `;
  return getProject(id);
}

async function listPostedProjects() {
  const { rows } = await sql`
    SELECT * FROM projects WHERE status = 'posted' ORDER BY updated_at DESC
  `;
  const projects = [];
  for (const row of rows) {
    projects.push(rowToProject(row, await countSlides(row.id)));
  }
  return projects;
}

async function updateProjectAnalytics(projectId, metrics) {
  await sql`
    UPDATE projects SET
      view_count = ${metrics.viewCount || 0},
      like_count = ${metrics.likeCount || 0},
      comment_count = ${metrics.commentCount || 0},
      share_count = ${metrics.shareCount || 0},
      analytics_updated_at = NOW(),
      updated_at = NOW()
    WHERE id = ${projectId}
  `;
}

async function getTikTokAuth() {
  const { rows } = await sql`SELECT * FROM tiktok_auth WHERE id = 'default'`;
  if (!rows.length) return null;
  const row = rows[0];
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    openId: row.open_id,
    expiresAt: row.expires_at,
  };
}

async function saveTikTokAuth({ accessToken, refreshToken, openId, expiresIn }) {
  const expiresAt = new Date(Date.now() + (expiresIn || 86400) * 1000).toISOString();
  await sql`
    INSERT INTO tiktok_auth (id, access_token, refresh_token, open_id, expires_at, updated_at)
    VALUES ('default', ${accessToken}, ${refreshToken}, ${openId || ''}, ${expiresAt}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      open_id = EXCLUDED.open_id,
      expires_at = EXCLUDED.expires_at,
      updated_at = NOW()
  `;
  return getTikTokAuth();
}

async function clearTikTokAuth() {
  await sql`DELETE FROM tiktok_auth WHERE id = 'default'`;
}

async function deleteProject(id) {
  const { rows: slides } = await sql`
    SELECT file_url FROM project_slides WHERE project_id = ${id}
  `;
  for (const s of slides) {
    try {
      await blobStore.del(s.file_url);
    } catch {
      /* ignore missing blob */
    }
  }
  const { rowCount } = await sql`DELETE FROM projects WHERE id = ${id}`;
  return rowCount > 0;
}

async function saveSlide(id, index, file, totalCount) {
  const project = await getProject(id);
  if (!project) throw new Error('Carrousel introuvable.');

  const ext = file.mimetype === 'image/jpeg' ? 'jpg' : 'png';
  const pathname = `projects/${id}/slide-${index + 1}.${ext}`;
  const blob = await blobStore.uploadBlob(pathname, file.buffer, {
    contentType: file.mimetype || 'image/jpeg',
  });

  const { rows: old } = await sql`
    SELECT file_url FROM project_slides WHERE project_id = ${id} AND slide_index = ${index}
  `;
  if (old[0]?.file_url && old[0].file_url !== blob.url) {
    try {
      await blobStore.del(old[0].file_url);
    } catch {
      /* ignore */
    }
  }

  await sql`
    INSERT INTO project_slides (project_id, slide_index, file_url)
    VALUES (${id}, ${index}, ${blob.pathname || blob.url})
    ON CONFLICT (project_id, slide_index)
    DO UPDATE SET file_url = EXCLUDED.file_url
  `;
  await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${id}`;

  if (!Number.isNaN(totalCount) && index === totalCount - 1) {
    const { rows: extras } = await sql`
      SELECT slide_index, file_url FROM project_slides
      WHERE project_id = ${id} AND slide_index >= ${totalCount}
    `;
    for (const row of extras) {
      try {
        await blobStore.del(row.file_url);
      } catch {
        /* ignore */
      }
    }
    await sql`DELETE FROM project_slides WHERE project_id = ${id} AND slide_index >= ${totalCount}`;
  }

  return { ok: true, index };
}

async function listBank() {
  const { rows } = await sql`SELECT id, file_url FROM bank_images ORDER BY created_at DESC`;
  return rows.map((r) => ({ filename: r.id, url: blobStore.toClientUrl(r.file_url) }));
}

async function addBankFiles(files) {
  const out = [];
  for (const f of files) {
    if (!f.buffer?.length) {
      throw new Error(`Fichier vide: ${f.originalname}`);
    }
    const id = `${Date.now()}-${f.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const blob = await blobStore.uploadBlob(`bank/${id}`, f.buffer, {
      contentType: f.mimetype,
    });
    await sql`INSERT INTO bank_images (id, file_url) VALUES (${id}, ${blob.pathname || blob.url})`;
    out.push({ filename: id, url: blobStore.toClientUrl(blob.url) });
  }
  return out;
}

async function deleteBankFile(filename) {
  const id = filename;
  const { rows } = await sql`SELECT file_url FROM bank_images WHERE id = ${id}`;
  if (!rows.length) return;
  try {
    await blobStore.del(rows[0].file_url);
  } catch {
    /* ignore */
  }
  await sql`DELETE FROM bank_images WHERE id = ${id}`;
}

async function listTitles() {
  const { rows } = await sql`SELECT * FROM titles ORDER BY created_at DESC`;
  return rows.map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at }));
}

async function addTitle(text) {
  const id = `title-${Date.now()}`;
  await sql`INSERT INTO titles (id, text) VALUES (${id}, ${text})`;
  return { id, text, createdAt: new Date().toISOString() };
}

async function deleteTitle(id) {
  const { rowCount } = await sql`DELETE FROM titles WHERE id = ${id}`;
  return rowCount > 0;
}

function storageHint() {
  const env = getEnvStatus();
  const missing = [];
  if (!env.postgres) missing.push('Postgres (Neon)');
  if (!env.blob) missing.push('Blob');
  if (!missing.length) return 'Données persistées (Postgres + Blob).';
  if (missing.length === 2) {
    return 'Données temporaires — connecte Postgres + Blob dans le dashboard Vercel, puis redeploie.';
  }
  return `Données temporaires — manque ${missing.join(' et ')}. Redeploie après connexion.`;
}

module.exports = {
  kind: 'postgres',
  PROJECT_STATUSES,
  ensurePostgresEnv,
  getEnvStatus,
  storageHint,
  isAvailable,
  init,
  listProjects,
  getProject,
  listPostedProjects,
  createProject,
  updateProject,
  updateProjectAnalytics,
  getTikTokAuth,
  saveTikTokAuth,
  clearTikTokAuth,
  deleteProject,
  saveSlide,
  listBank,
  addBankFiles,
  deleteBankFile,
  listTitles,
  addTitle,
  deleteTitle,
  async saveExportSlides() {
    throw new Error('Export ZIP se fait côté navigateur.');
  },
  getExportDir() {
    return null;
  },
};
