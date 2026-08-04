const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const archiver = require('archiver');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { scrapeCarousel } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

const PROXY_SERVER = process.env.HTTPS_PROXY || process.env.https_proxy;
const proxyAgent = PROXY_SERVER ? new HttpsProxyAgent(PROXY_SERVER) : undefined;

const ROOT = path.join(__dirname, '..');
const BANK_DIR = path.join(ROOT, 'uploads', 'bank');
const EXPORT_DIR = path.join(ROOT, 'uploads', 'exports');
const PROJECTS_DIR = path.join(ROOT, 'uploads', 'projects');
const TITLES_FILE = path.join(ROOT, 'uploads', 'titles.json');
const PROJECT_STATUSES = ['to_edit', 'wip', 'ready_to_post', 'posted'];

[BANK_DIR, EXPORT_DIR, PROJECTS_DIR].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
if (!fs.existsSync(TITLES_FILE)) fs.writeFileSync(TITLES_FILE, '[]');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/bank-files', express.static(BANK_DIR));
app.use('/project-files', express.static(PROJECTS_DIR));

// ---------- 1. Scrape a TikTok carousel link ----------
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/tiktok\.com/.test(url)) {
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

// ---------- 2. Proxy-download a single remote image (avoids hotlink/CORS issues) ----------
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
const bankStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BANK_DIR),
  filename: (req, file, cb) => {
    const safe = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, safe);
  },
});
const bankUpload = multer({ storage: bankStorage, limits: { fileSize: 15 * 1024 * 1024 } });

app.post('/api/bank/upload', bankUpload.array('images', 30), (req, res) => {
  const files = (req.files || []).map((f) => ({ filename: f.filename, url: `/bank-files/${f.filename}` }));
  res.json({ files });
});

app.get('/api/bank', (req, res) => {
  const files = fs.readdirSync(BANK_DIR).filter((f) => !f.startsWith('.'));
  res.json({ files: files.map((f) => ({ filename: f, url: `/bank-files/${f}` })) });
});

app.delete('/api/bank/:filename', (req, res) => {
  const p = path.join(BANK_DIR, path.basename(req.params.filename));
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

// ---------- 4. Export edited slides (client sends PNG data URLs) ----------
app.post('/api/export', (req, res) => {
  const { postName, slides } = req.body || {};
  if (!Array.isArray(slides) || !slides.length) {
    return res.status(400).json({ error: 'Aucune slide à exporter.' });
  }
  const safeName = (postName || `post-${Date.now()}`).replace(/[^a-zA-Z0-9\-_]/g, '_');
  const dir = path.join(EXPORT_DIR, safeName);
  fs.mkdirSync(dir, { recursive: true });

  slides.forEach((dataUrl, idx) => {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(dir, `slide-${idx + 1}.png`), Buffer.from(base64, 'base64'));
  });

  res.json({ ok: true, folder: safeName, downloadZip: `/api/export/${safeName}.zip` });
});

app.get('/api/export/:name.zip', (req, res) => {
  const dir = path.join(EXPORT_DIR, path.basename(req.params.name));
  if (!fs.existsSync(dir)) return res.status(404).send('not found');
  res.attachment(`${path.basename(req.params.name)}.zip`);
  const archive = archiver('zip');
  archive.directory(dir, false);
  archive.pipe(res);
  archive.finalize();
});

// ---------- 5. Saved carousel projects ----------
function projectDir(id) {
  return path.join(PROJECTS_DIR, path.basename(id));
}

function readProjectMeta(id) {
  const metaPath = path.join(projectDir(id), 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

function writeProjectSlides(id, slides) {
  const slidesDir = path.join(projectDir(id), 'slides');
  fs.mkdirSync(slidesDir, { recursive: true });
  const existing = fs.readdirSync(slidesDir).filter((f) => f.endsWith('.png'));
  existing.forEach((f) => fs.unlinkSync(path.join(slidesDir, f)));
  slides.forEach((dataUrl, idx) => {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(
      path.join(slidesDir, `slide-${idx + 1}.png`),
      Buffer.from(base64, 'base64')
    );
  });
}

function projectToListItem(id) {
  const meta = readProjectMeta(id);
  if (!meta) return null;
  const slidesDir = path.join(projectDir(id), 'slides');
  const slideCount = fs.existsSync(slidesDir)
    ? fs.readdirSync(slidesDir).filter((f) => f.endsWith('.png')).length
    : 0;
  return { ...meta, slideCount };
}

app.get('/api/projects', (req, res) => {
  const ids = fs.readdirSync(PROJECTS_DIR).filter((f) => {
    if (f.startsWith('.')) return false;
    return fs.existsSync(path.join(PROJECTS_DIR, f, 'meta.json'));
  });
  const projects = ids
    .map(projectToListItem)
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ projects });
});

app.get('/api/projects/:id', (req, res) => {
  const id = path.basename(req.params.id);
  const meta = readProjectMeta(id);
  if (!meta) return res.status(404).json({ error: 'Carrousel introuvable.' });
  const slidesDir = path.join(projectDir(id), 'slides');
  const slideFiles = fs.existsSync(slidesDir)
    ? fs.readdirSync(slidesDir).filter((f) => f.endsWith('.png')).sort()
    : [];
  const slides = slideFiles.map((filename, index) => ({
    index,
    url: `/project-files/${id}/slides/${filename}`,
  }));
  res.json({ ...meta, slides });
});

app.post('/api/projects', (req, res) => {
  const { name, status, caption, sourceUrl, slides } = req.body || {};
  if (!Array.isArray(slides) || !slides.length) {
    return res.status(400).json({ error: 'Aucune slide à enregistrer.' });
  }
  if (status && !PROJECT_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide.' });
  }
  const id = `project-${Date.now()}`;
  const now = new Date().toISOString();
  const safeName = (name || `carrousel-${Date.now()}`).replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim();
  const meta = {
    id,
    name: safeName,
    status: status || 'to_edit',
    caption: caption || '',
    sourceUrl: sourceUrl || '',
    createdAt: now,
    updatedAt: now,
  };
  fs.mkdirSync(projectDir(id), { recursive: true });
  fs.writeFileSync(path.join(projectDir(id), 'meta.json'), JSON.stringify(meta, null, 2));
  writeProjectSlides(id, slides);
  res.json({ ok: true, project: projectToListItem(id) });
});

app.put('/api/projects/:id', (req, res) => {
  const id = path.basename(req.params.id);
  const meta = readProjectMeta(id);
  if (!meta) return res.status(404).json({ error: 'Carrousel introuvable.' });
  const { name, status, caption, sourceUrl, slides } = req.body || {};
  if (status && !PROJECT_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide.' });
  }
  if (name) meta.name = name.replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim();
  if (status) meta.status = status;
  if (caption !== undefined) meta.caption = caption;
  if (sourceUrl !== undefined) meta.sourceUrl = sourceUrl;
  meta.updatedAt = new Date().toISOString();
  if (Array.isArray(slides) && slides.length) writeProjectSlides(id, slides);
  fs.writeFileSync(path.join(projectDir(id), 'meta.json'), JSON.stringify(meta, null, 2));
  res.json({ ok: true, project: projectToListItem(id) });
});

app.delete('/api/projects/:id', (req, res) => {
  const id = path.basename(req.params.id);
  const dir = projectDir(id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Carrousel introuvable.' });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// ---------- 6. Title ideas ----------
function readTitles() {
  try {
    return JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeTitles(titles) {
  fs.writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
}

app.get('/api/titles', (req, res) => {
  const titles = readTitles().sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ titles });
});

app.post('/api/titles', (req, res) => {
  const { text } = req.body || {};
  const trimmed = (text || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Le titre ne peut pas être vide.' });
  const titles = readTitles();
  const item = { id: `title-${Date.now()}`, text: trimmed, createdAt: new Date().toISOString() };
  titles.unshift(item);
  writeTitles(titles);
  res.json({ ok: true, title: item });
});

app.delete('/api/titles/:id', (req, res) => {
  const id = path.basename(req.params.id);
  const titles = readTitles().filter((t) => t.id !== id);
  if (titles.length === readTitles().length) {
    return res.status(404).json({ error: 'Titre introuvable.' });
  }
  writeTitles(titles);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`TikTok Carousel Tool running on http://localhost:${PORT}`);
});
