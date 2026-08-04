const { sql } = require('@vercel/postgres');
const { put, del } = require('@vercel/blob');
const { PROJECT_STATUSES } = require('./constants');

let ready = false;

function isAvailable() {
  return !!(process.env.POSTGRES_URL && process.env.BLOB_READ_WRITE_TOKEN);
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
  ready = true;
}

function rowToProject(row, slideCount) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    caption: row.caption || '',
    sourceUrl: row.source_url || '',
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
  project.slides = slideRows.map((s) => ({ index: s.slide_index, url: s.file_url }));
  return project;
}

async function createProject({ name, status, caption, sourceUrl, slideCount }) {
  const id = `project-${Date.now()}`;
  const safeName = (name || `carrousel-${Date.now()}`).replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim();
  await sql`
    INSERT INTO projects (id, name, status, caption, source_url)
    VALUES (${id}, ${safeName}, ${status || 'to_edit'}, ${caption || ''}, ${sourceUrl || ''})
  `;
  return { ...(await getProject(id)), slideCount: slideCount || 0 };
}

async function updateProject(id, { name, status, caption, sourceUrl }) {
  const existing = await getProject(id);
  if (!existing) return null;
  const safeName = name ? name.replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim() : existing.name;
  await sql`
    UPDATE projects SET
      name = ${safeName},
      status = ${status || existing.status},
      caption = ${caption !== undefined ? caption : existing.caption},
      source_url = ${sourceUrl !== undefined ? sourceUrl : existing.sourceUrl},
      updated_at = NOW()
    WHERE id = ${id}
  `;
  return getProject(id);
}

async function deleteProject(id) {
  const { rows: slides } = await sql`
    SELECT file_url FROM project_slides WHERE project_id = ${id}
  `;
  for (const s of slides) {
    try {
      await del(s.file_url);
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
  const blob = await put(pathname, file.buffer, {
    access: 'public',
    contentType: file.mimetype || 'image/jpeg',
    addRandomSuffix: false,
  });

  const { rows: old } = await sql`
    SELECT file_url FROM project_slides WHERE project_id = ${id} AND slide_index = ${index}
  `;
  if (old[0]?.file_url && old[0].file_url !== blob.url) {
    try {
      await del(old[0].file_url);
    } catch {
      /* ignore */
    }
  }

  await sql`
    INSERT INTO project_slides (project_id, slide_index, file_url)
    VALUES (${id}, ${index}, ${blob.url})
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
        await del(row.file_url);
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
  return rows.map((r) => ({ filename: r.id, url: r.file_url }));
}

async function addBankFiles(files) {
  const out = [];
  for (const f of files) {
    const id = `${Date.now()}-${f.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const blob = await put(`bank/${id}`, f.buffer, {
      access: 'public',
      contentType: f.mimetype,
    });
    await sql`INSERT INTO bank_images (id, file_url) VALUES (${id}, ${blob.url})`;
    out.push({ filename: id, url: blob.url });
  }
  return out;
}

async function deleteBankFile(filename) {
  const id = filename;
  const { rows } = await sql`SELECT file_url FROM bank_images WHERE id = ${id}`;
  if (!rows.length) return;
  try {
    await del(rows[0].file_url);
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

module.exports = {
  kind: 'postgres',
  PROJECT_STATUSES,
  isAvailable,
  init,
  listProjects,
  getProject,
  createProject,
  updateProject,
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
