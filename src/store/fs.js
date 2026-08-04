const fs = require('fs');
const path = require('path');
const { PROJECT_STATUSES } = require('./constants');

function createFsStore({ dataRoot }) {
  const BANK_DIR = path.join(dataRoot, 'uploads', 'bank');
  const EXPORT_DIR = path.join(dataRoot, 'uploads', 'exports');
  const PROJECTS_DIR = path.join(dataRoot, 'uploads', 'projects');
  const TITLES_FILE = path.join(dataRoot, 'uploads', 'titles.json');

  [BANK_DIR, EXPORT_DIR, PROJECTS_DIR].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  if (!fs.existsSync(TITLES_FILE)) fs.writeFileSync(TITLES_FILE, '[]');

  function projectDir(id) {
    return path.join(PROJECTS_DIR, path.basename(id));
  }

  function listSlideFiles(slidesDir) {
    if (!fs.existsSync(slidesDir)) return [];
    return fs
      .readdirSync(slidesDir)
      .filter((f) => /^slide-\d+\.(png|jpe?g)$/i.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)?.[0], 10) - parseInt(b.match(/\d+/)?.[0], 10));
  }

  function readProjectMeta(id) {
    const metaPath = path.join(projectDir(id), 'meta.json');
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  }

  function trimProjectSlides(id, totalCount) {
    const slidesDir = path.join(projectDir(id), 'slides');
    if (!fs.existsSync(slidesDir)) return;
    listSlideFiles(slidesDir).forEach((f) => {
      const num = parseInt(f.match(/\d+/)?.[0], 10);
      if (num > totalCount) fs.unlinkSync(path.join(slidesDir, f));
    });
  }

  return {
    kind: 'filesystem',
    BANK_DIR,
    EXPORT_DIR,
    PROJECTS_DIR,
    PROJECT_STATUSES,

    isAvailable: () => true,

    async init() {},

    async listProjects() {
      const ids = fs.readdirSync(PROJECTS_DIR).filter((f) => {
        if (f.startsWith('.')) return false;
        return fs.existsSync(path.join(PROJECTS_DIR, f, 'meta.json'));
      });
      return ids
        .map((id) => {
          const meta = readProjectMeta(id);
          if (!meta) return null;
          const slideCount = listSlideFiles(path.join(projectDir(id), 'slides')).length;
          return { ...meta, slideCount };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    },

    async getProject(id) {
      const meta = readProjectMeta(id);
      if (!meta) return null;
      const slideFiles = listSlideFiles(path.join(projectDir(id), 'slides'));
      const slides = slideFiles.map((filename, index) => ({
        index,
        url: `/project-files/${id}/slides/${filename}`,
      }));
      return { ...meta, slides };
    },

    async createProject({ name, status, caption, sourceUrl, slideCount }) {
      const id = `project-${Date.now()}`;
      const now = new Date().toISOString();
      const meta = {
        id,
        name: (name || `carrousel-${Date.now()}`).replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim(),
        status: status || 'to_edit',
        caption: caption || '',
        sourceUrl: sourceUrl || '',
        createdAt: now,
        updatedAt: now,
      };
      fs.mkdirSync(path.join(projectDir(id), 'slides'), { recursive: true });
      fs.writeFileSync(path.join(projectDir(id), 'meta.json'), JSON.stringify(meta, null, 2));
      return { ...meta, slideCount: slideCount || 0 };
    },

    async updateProject(id, { name, status, caption, sourceUrl }) {
      const meta = readProjectMeta(id);
      if (!meta) return null;
      if (name) meta.name = name.replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim();
      if (status) meta.status = status;
      if (caption !== undefined) meta.caption = caption;
      if (sourceUrl !== undefined) meta.sourceUrl = sourceUrl;
      meta.updatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(projectDir(id), 'meta.json'), JSON.stringify(meta, null, 2));
      const slideCount = listSlideFiles(path.join(projectDir(id), 'slides')).length;
      return { ...meta, slideCount };
    },

    async deleteProject(id) {
      const dir = projectDir(id);
      if (!fs.existsSync(dir)) return false;
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    },

    async saveSlide(id, index, file, totalCount) {
      const meta = readProjectMeta(id);
      if (!meta) throw new Error('Carrousel introuvable.');
      const slidesDir = path.join(projectDir(id), 'slides');
      fs.mkdirSync(slidesDir, { recursive: true });
      const ext = file.mimetype === 'image/jpeg' ? '.jpg' : '.png';
      const dest = path.join(slidesDir, `slide-${index + 1}${ext}`);
      fs.writeFileSync(dest, file.buffer);
      meta.updatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(projectDir(id), 'meta.json'), JSON.stringify(meta, null, 2));
      if (!Number.isNaN(totalCount) && index === totalCount - 1) {
        trimProjectSlides(id, totalCount);
      }
      return { ok: true, index };
    },

    async listBank() {
      return fs.readdirSync(BANK_DIR).filter((f) => !f.startsWith('.')).map((filename) => ({
        filename,
        url: `/bank-files/${filename}`,
      }));
    },

    async addBankFiles(files) {
      return files.map((f) => {
        const safe = Date.now() + '-' + f.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        fs.writeFileSync(path.join(BANK_DIR, safe), f.buffer);
        return { filename: safe, url: `/bank-files/${safe}` };
      });
    },

    async deleteBankFile(filename) {
      const p = path.join(BANK_DIR, path.basename(filename));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },

    async listTitles() {
      try {
        return JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')).sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );
      } catch {
        return [];
      }
    },

    async addTitle(text) {
      const titles = JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8'));
      const item = { id: `title-${Date.now()}`, text, createdAt: new Date().toISOString() };
      titles.unshift(item);
      fs.writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
      return item;
    },

    async deleteTitle(id) {
      const titles = JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8'));
      const next = titles.filter((t) => t.id !== id);
      if (next.length === titles.length) return false;
      fs.writeFileSync(TITLES_FILE, JSON.stringify(next, null, 2));
      return true;
    },

    async saveExportSlides(safeName, slides) {
      const dir = path.join(EXPORT_DIR, safeName);
      fs.mkdirSync(dir, { recursive: true });
      slides.forEach((dataUrl, idx) => {
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(path.join(dir, `slide-${idx + 1}.png`), Buffer.from(base64, 'base64'));
      });
      return dir;
    },

    getExportDir(name) {
      return path.join(EXPORT_DIR, path.basename(name));
    },
  };
}

module.exports = { createFsStore };
