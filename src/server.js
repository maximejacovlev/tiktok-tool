const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const archiver = require('archiver');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { scrapeCarousel } = require('./scraper');
const { getStore } = require('./store');
const blobStore = require('./store/blob');

const app = express();
const PORT = process.env.PORT || 3000;

const PROXY_SERVER = process.env.HTTPS_PROXY || process.env.https_proxy;
const proxyAgent = PROXY_SERVER ? new HttpsProxyAgent(PROXY_SERVER) : undefined;

const IS_VERCEL = !!process.env.VERCEL;
const APP_ROOT = path.join(__dirname, '..');

app.use(express.json({ limit: IS_VERCEL ? '4mb' : '50mb' }));
app.use(express.static(path.join(APP_ROOT, 'public')));

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const slideUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
});

async function withStore(res, fn) {
  try {
    const store = await getStore();
    return await fn(store);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Erreur serveur.' });
    return null;
  }
}

// Static files for local filesystem storage only
app.use(async (req, res, next) => {
  const store = await getStore();
  if (store.kind === 'filesystem') {
    if (req.path.startsWith('/bank-files/')) {
      return express.static(store.BANK_DIR)(req, res, next);
    }
    if (req.path.startsWith('/project-files/')) {
      return express.static(store.PROJECTS_DIR)(req, res, next);
    }
  }
  next();
});

// ---------- Blob proxy (private stores) ----------
async function serveBlob(req, res) {
  const pathname = req.blobPathname;
  const queryUrl = req.query.url && String(req.query.url);
  const target = pathname || queryUrl;

  if (!target) return res.status(400).send('missing blob');

  try {
    const result = await blobStore.readBlobBuffer(target);
    if (!result) return res.status(404).send('not found');
    res.set('Content-Type', result.contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(result.buffer);
  } catch (err) {
    console.error('Blob proxy error:', err.message || err);
    res.status(404).send('not found');
  }
}

app.get('/api/blob', serveBlob);
app.get(/^\/api\/blob\/(.+)$/, (req, res) => {
  req.blobPathname = decodeURIComponent(req.params[0]);
  return serveBlob(req, res);
});

// ---------- Storage status ----------
app.get('/api/storage', async (req, res) => {
  const store = await getStore();
  const postgresStore = require('./store/postgres');
  const env = postgresStore.getEnvStatus();
  res.json({
    kind: store.kind,
    persistent: store.kind === 'postgres',
    env: IS_VERCEL ? { postgres: env.postgres, blob: env.blob } : undefined,
    hint:
      store.kind === 'postgres'
        ? 'Données persistées (Postgres + Blob).'
        : IS_VERCEL
          ? postgresStore.storageHint()
          : 'Données locales dans uploads/.',
  });
});

// ---------- 1. Scrape ----------
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/tiktok\.com/i.test(url)) {
    return res.status(400).json({ error: 'Merci de fournir un lien TikTok valide.' });
  }
  try {
    const result = await scrapeCarousel(url);
    res.json(result);
  } catch (err) {
    console.error('Scrape error for URL:', url, '-', err.message);
    res.status(500).json({ error: err.message || 'Erreur pendant le scraping.' });
  }
});

// ---------- 2. Proxy image ----------
app.get('/api/image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('missing url');
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://www.tiktok.com/',
      },
      agent: proxyAgent,
    });
    if (!r.ok) return res.status(502).send('upstream fetch failed');
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    r.body.pipe(res);
  } catch (err) {
    console.error('Proxy image error:', err);
    res.status(500).send('proxy error');
  }
});

// ---------- 3. Image bank ----------
app.post('/api/bank/upload', memoryUpload.array('images', 30), async (req, res) => {
  await withStore(res, async (store) => {
    const files = await store.addBankFiles(req.files || []);
    res.json({ files });
  });
});

app.get('/api/bank', async (req, res) => {
  await withStore(res, async (store) => {
    res.json({ files: await store.listBank() });
  });
});

app.delete('/api/bank/:filename', async (req, res) => {
  await withStore(res, async (store) => {
    await store.deleteBankFile(req.params.filename);
    res.json({ ok: true });
  });
});

// ---------- 4. Export (local filesystem fallback) ----------
app.post('/api/export', async (req, res) => {
  const { postName, slides } = req.body || {};
  if (!Array.isArray(slides) || !slides.length) {
    return res.status(400).json({ error: 'Aucune slide à exporter.' });
  }
  await withStore(res, async (store) => {
    if (store.kind !== 'filesystem') {
      return res.status(400).json({ error: 'Utilise le bouton Télécharger ZIP (export navigateur).' });
    }
    const safeName = (postName || `post-${Date.now()}`).replace(/[^a-zA-Z0-9\-_]/g, '_');
    await store.saveExportSlides(safeName, slides);
    res.json({ ok: true, folder: safeName, downloadZip: `/api/export/${safeName}.zip` });
  });
});

app.get('/api/export/:name.zip', async (req, res) => {
  await withStore(res, async (store) => {
    const dir = store.getExportDir(req.params.name);
    if (!dir || !fs.existsSync(dir)) return res.status(404).send('not found');
    res.attachment(`${path.basename(req.params.name)}.zip`);
    const archive = archiver('zip');
    archive.directory(dir, false);
    archive.pipe(res);
    archive.finalize();
  });
});

// ---------- 5. Projects ----------
app.get('/api/projects', async (req, res) => {
  await withStore(res, async (store) => {
    res.json({ projects: await store.listProjects() });
  });
});

app.get('/api/projects/:id', async (req, res) => {
  await withStore(res, async (store) => {
    const project = await store.getProject(path.basename(req.params.id));
    if (!project) return res.status(404).json({ error: 'Carrousel introuvable.' });
    res.json(project);
  });
});

app.post('/api/projects', async (req, res) => {
  const { name, status, caption, sourceUrl, slideCount } = req.body || {};
  if (!slideCount) {
    return res.status(400).json({ error: 'Aucune slide à enregistrer.' });
  }
  await withStore(res, async (store) => {
    if (status && !store.PROJECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide.' });
    }
    const project = await store.createProject({ name, status, caption, sourceUrl, slideCount });
    res.json({ ok: true, project });
  });
});

app.put('/api/projects/:id/slides/:index', slideUpload.single('slide'), async (req, res) => {
  const id = path.basename(req.params.id);
  const index = parseInt(req.params.index, 10);
  const totalCount = parseInt(req.query.totalCount, 10);
  if (!req.file) return res.status(400).json({ error: 'Slide manquante.' });
  if (Number.isNaN(index) || index < 0) {
    return res.status(400).json({ error: 'Index de slide invalide.' });
  }
  await withStore(res, async (store) => {
    const result = await store.saveSlide(id, index, req.file, totalCount);
    res.json(result);
  });
});

app.put('/api/projects/:id', async (req, res) => {
  const id = path.basename(req.params.id);
  const { name, status, caption, sourceUrl } = req.body || {};
  await withStore(res, async (store) => {
    if (status && !store.PROJECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide.' });
    }
    const project = await store.updateProject(id, { name, status, caption, sourceUrl });
    if (!project) return res.status(404).json({ error: 'Carrousel introuvable.' });
    res.json({ ok: true, project });
  });
});

app.delete('/api/projects/:id', async (req, res) => {
  const id = path.basename(req.params.id);
  await withStore(res, async (store) => {
    const ok = await store.deleteProject(id);
    if (!ok) return res.status(404).json({ error: 'Carrousel introuvable.' });
    res.json({ ok: true });
  });
});

// ---------- 6. Titles ----------
app.get('/api/titles', async (req, res) => {
  await withStore(res, async (store) => {
    res.json({ titles: await store.listTitles() });
  });
});

app.post('/api/titles', async (req, res) => {
  const trimmed = (req.body?.text || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Le titre ne peut pas être vide.' });
  await withStore(res, async (store) => {
    const title = await store.addTitle(trimmed);
    res.json({ ok: true, title });
  });
});

app.delete('/api/titles/:id', async (req, res) => {
  const id = path.basename(req.params.id);
  await withStore(res, async (store) => {
    const ok = await store.deleteTitle(id);
    if (!ok) return res.status(404).json({ error: 'Titre introuvable.' });
    res.json({ ok: true });
  });
});

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(APP_ROOT, 'public', 'index.html'), (err) => {
    if (err) next(err);
  });
});

module.exports = app;

if (require.main === module) {
  getStore().then(() => {
    app.listen(PORT, () => {
      console.log(`TikTok Carousel Tool running on http://localhost:${PORT}`);
    });
  });
}
