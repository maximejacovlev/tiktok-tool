// ---------------- State ----------------
let slides = [];          // [{ id, source, remoteUrl?, proxyUrl?, bankUrl?, renderedDataUrl?, overlays? }]
let bank = [];
let nextSlideId = 1;

let currentProject = {
  id: null,
  name: '',
  status: 'to_edit',
  caption: '',
  sourceUrl: '',
  postedUrl: '',
};

let editorState = null;

const STATUS_LABELS = {
  to_edit: 'À éditer',
  wip: 'WIP',
  ready_to_post: 'Prêt à poster',
  posted: 'Publié',
};

// ---------------- Helpers ----------------
const $ = (sel) => document.querySelector(sel);

function proxied(url) {
  return `/api/image?url=${encodeURIComponent(url)}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function getSlideDisplayUrl(slide) {
  if (slide.renderedDataUrl) return slide.renderedDataUrl;
  if (slide.source === 'bank') return slide.bankUrl;
  return slide.proxyUrl;
}

function reindexSlides() {
  slides.forEach((s, i) => { s.index = i; });
}

function newSlideId() {
  return nextSlideId++;
}

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (/request entity too large/i.test(text)) {
      throw new Error('Requête trop volumineuse (limite Vercel ~4 Mo). Réessaie avec moins de slides ou des images plus légères.');
    }
    throw new Error(text.slice(0, 150) || `Erreur serveur (${res.status})`);
  }
}

function setupDropZone(el, onDrop) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const raw = e.dataTransfer.getData('application/x-bank-image');
    if (!raw) return;
    const { url } = JSON.parse(raw);
    await onDrop(url);
  });
}

function moveSlide(slideId, direction) {
  const idx = slides.findIndex((s) => s.id === slideId);
  if (idx === -1) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= slides.length) return;
  const [item] = slides.splice(idx, 1);
  slides.splice(newIdx, 0, item);
  reindexSlides();
  renderSlides();
}

// ---------------- Projects ----------------
async function refreshProjects() {
  const res = await fetch('/api/projects');
  const data = await res.json();
  renderProjectsList(data.projects || []);
}

const STATUS_ORDER = ['to_edit', 'wip', 'ready_to_post', 'posted'];

function renderProjectsStats(projects) {
  const el = $('#projects-stats');
  if (!el) return;

  if (!projects.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }

  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  projects.forEach((p) => {
    if (counts[p.status] !== undefined) counts[p.status]++;
  });

  el.innerHTML = '';
  STATUS_ORDER.forEach((status) => {
    const line = document.createElement('div');
    line.className = `projects-stat status-${status}`;
    line.textContent = `${STATUS_LABELS[status]} — ${counts[status]}`;
    el.appendChild(line);
  });
  el.classList.remove('hidden');
}

function syncPostedUrlRow() {
  const row = $('#posted-url-row');
  const status = $('#project-status')?.value || currentProject.status;
  if (!row) return;
  row.classList.toggle('hidden', status !== 'posted');
}

function getPostedUrlFromForm() {
  if ($('#project-status')?.value !== 'posted') return '';
  return ($('#project-posted-url')?.value || '').trim();
}

function renderProjectsList(projects) {
  renderProjectsStats(projects);
  const list = $('#projects-list');
  const empty = $('#projects-empty');
  list.innerHTML = '';

  if (!projects.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  projects.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'project-row' + (currentProject.id === p.id ? ' active' : '');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;

    const badge = document.createElement('span');
    badge.className = `status-badge ${p.status}`;
    badge.textContent = STATUS_LABELS[p.status] || p.status;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${p.slideCount} slide(s) · ${new Date(p.updatedAt).toLocaleDateString('fr-FR')}`;

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const delBtn = document.createElement('button');
    delBtn.className = 'small danger';
    delBtn.textContent = 'Supprimer';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Supprimer « ${p.name} » ?`)) return;
      await fetch(`/api/projects/${p.id}`, { method: 'DELETE' });
      if (currentProject.id === p.id) resetWorkSession();
      refreshProjects();
    });
    actions.appendChild(delBtn);

    row.addEventListener('click', () => loadProject(p.id));
    row.append(name, badge, meta, actions);
    list.appendChild(row);
  });
}

async function loadProject(id) {
  const res = await fetch(`/api/projects/${id}`);
  const data = await res.json();
  if (!res.ok) {
    $('#save-status').textContent = data.error || 'Erreur de chargement.';
    return;
  }

  currentProject = {
    id: data.id,
    name: data.name,
    status: data.status,
    caption: data.caption || '',
    sourceUrl: data.sourceUrl || '',
    postedUrl: data.postedUrl || '',
  };

  slides = data.slides.map((s) => ({
    id: newSlideId(),
    source: 'saved',
    savedUrl: s.url,
    renderedDataUrl: s.url,
    overlays: [],
    index: s.index,
  }));
  reindexSlides();

  $('#project-name').value = currentProject.name;
  $('#project-status').value = currentProject.status;
  $('#project-posted-url').value = currentProject.postedUrl || '';
  syncPostedUrlRow();
  $('#step-slides').classList.remove('hidden');
  renderSlides();
  $('#save-status').textContent = `Carrousel « ${data.name} » chargé (${slides.length} slides).`;
  refreshProjects();
}

function resetWorkSession() {
  slides = [];
  currentProject = { id: null, name: '', status: 'to_edit', caption: '', sourceUrl: '', postedUrl: '' };
  $('#project-name').value = '';
  $('#project-status').value = 'to_edit';
  $('#project-posted-url').value = '';
  syncPostedUrlRow();
  $('#step-slides').classList.add('hidden');
  $('#save-status').textContent = '';
}

async function collectSlideDataUrls() {
  const out = [];
  for (const s of slides) {
    out.push(await compressSlideDataUrl(getSlideDisplayUrl(s)));
  }
  return out;
}

async function compressSlideDataUrl(src) {
  const blob = await compressSlideBlob(src);
  return blobToDataUrl(blob);
}

async function compressSlideBlob(src, maxBytes = 3 * 1024 * 1024) {
  const img = await loadImage(src);
  const maxSide = 1080;
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (Math.max(w, h) > maxSide) {
    if (w >= h) {
      h = Math.round((h * maxSide) / w);
      w = maxSide;
    } else {
      w = Math.round((w * maxSide) / h);
      h = maxSide;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);

  for (const quality of [0.88, 0.78, 0.68, 0.58]) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (blob.size <= maxBytes) return blob;
  }
  return canvasToBlob(canvas, 'image/jpeg', 0.5);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

$('#btn-save-project').addEventListener('click', async () => {
  const statusEl = $('#save-status');
  if (!slides.length) {
    statusEl.textContent = 'Ajoute des slides avant d\'enregistrer.';
    return;
  }

  statusEl.textContent = 'Enregistrement...';
  $('#btn-save-project').disabled = true;

  try {
    const slideDataUrls = await collectSlideDataUrls();
    const postedUrl = getPostedUrlFromForm();
    const status = $('#project-status').value;
    if (status === 'posted' && postedUrl && !/\/(video|photo)\/\d+/.test(postedUrl)) {
      statusEl.textContent = 'Lien TikTok invalide (attendu: …/video/… ou …/photo/…).';
      $('#btn-save-project').disabled = false;
      return;
    }
    const meta = {
      name: $('#project-name').value.trim() || `carrousel-${Date.now()}`,
      status,
      caption: currentProject.caption,
      sourceUrl: currentProject.sourceUrl,
      postedUrl,
      slideCount: slides.length,
    };

    let projectId = currentProject.id;

    if (!projectId) {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || 'Erreur enregistrement');
      projectId = data.project.id;
      currentProject.id = projectId;
    } else {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || 'Erreur enregistrement');
    }

    for (let i = 0; i < slides.length; i++) {
      statusEl.textContent = `Enregistrement slide ${i + 1}/${slides.length}...`;
      const blob = await compressSlideBlob(getSlideDisplayUrl(slides[i]));
      const form = new FormData();
      form.append('slide', blob, `slide-${i + 1}.jpg`);
      const res = await fetch(
        `/api/projects/${projectId}/slides/${i}?totalCount=${slides.length}`,
        { method: 'PUT', body: form }
      );
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || `Erreur slide ${i + 1}`);
    }

    currentProject.name = meta.name;
    currentProject.status = meta.status;
    currentProject.postedUrl = postedUrl;

    statusEl.textContent = `Carrousel enregistré (${slides.length} slides) — statut : ${STATUS_LABELS[meta.status]}.`;
    refreshProjects();
  } catch (err) {
    statusEl.textContent = 'Erreur: ' + err.message;
  } finally {
    $('#btn-save-project').disabled = false;
  }
});

$('#project-status').addEventListener('change', () => {
  currentProject.status = $('#project-status').value;
  syncPostedUrlRow();
});

$('#project-posted-url').addEventListener('input', () => {
  currentProject.postedUrl = $('#project-posted-url').value.trim();
});

// ---------------- Scrape ----------------
$('#btn-scrape').addEventListener('click', async () => {
  const url = $('#tiktok-url').value.trim();
  const statusEl = $('#scrape-status');
  if (!url) { statusEl.textContent = 'Colle un lien TikTok d\'abord.'; return; }

  statusEl.textContent = 'Extraction en cours (ça peut prendre 10-20s)...';
  $('#btn-scrape').disabled = true;

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await parseJsonResponse(res);
    if (!res.ok) throw new Error(data.error || 'Erreur inconnue');

    currentProject = {
      id: null,
      name: $('#project-name').value.trim() || `tiktok-${Date.now()}`,
      status: $('#project-status').value || 'to_edit',
      caption: data.caption || '',
      sourceUrl: url,
    };
    if (!$('#project-name').value.trim()) {
      $('#project-name').value = currentProject.name;
    }

    slides = data.images.map((i) => ({
      id: newSlideId(),
      source: 'tiktok',
      index: i.index,
      remoteUrl: i.url,
      proxyUrl: proxied(i.url),
      renderedDataUrl: null,
      overlays: [],
    }));
    reindexSlides();
    renderSlides();

    statusEl.textContent = `${slides.length} slide(s) extraite(s). ${data.caption ? 'Légende: ' + data.caption : ''}`;
    $('#step-slides').classList.remove('hidden');
  } catch (err) {
    statusEl.textContent = 'Erreur: ' + err.message;
  } finally {
    $('#btn-scrape').disabled = false;
  }
});

// ---------------- Slides grid ----------------
let slidesGridDropSetup = false;

function renderSlides() {
  const grid = $('#slides-grid');
  grid.innerHTML = '';

  slides.forEach((s, displayIndex) => {
    const card = document.createElement('div');
    card.className = 'slide-card';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumb-wrap';

    const badge = document.createElement('span');
    badge.className = 'slide-badge';
    badge.textContent = s.source === 'bank' ? 'Banque' : s.source === 'saved' ? 'Enregistré' : 'TikTok';

    const num = document.createElement('span');
    num.className = 'slide-num';
    num.textContent = displayIndex + 1;

    const img = document.createElement('img');
    img.src = getSlideDisplayUrl(s);
    img.alt = `Slide ${displayIndex + 1}`;

    thumbWrap.append(badge, num, img);

    const reorderRow = document.createElement('div');
    reorderRow.className = 'reorder-row';

    const leftBtn = document.createElement('button');
    leftBtn.className = 'secondary icon-btn';
    leftBtn.textContent = '←';
    leftBtn.title = 'Déplacer à gauche';
    leftBtn.disabled = displayIndex === 0;
    leftBtn.addEventListener('click', () => moveSlide(s.id, -1));

    const rightBtn = document.createElement('button');
    rightBtn.className = 'secondary icon-btn';
    rightBtn.textContent = '→';
    rightBtn.title = 'Déplacer à droite';
    rightBtn.disabled = displayIndex === slides.length - 1;
    rightBtn.addEventListener('click', () => moveSlide(s.id, 1));

    reorderRow.append(leftBtn, rightBtn);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Éditer';
    editBtn.addEventListener('click', () => openEditor(s.id));

    const dlBtn = document.createElement('button');
    dlBtn.textContent = 'PNG';
    dlBtn.className = 'secondary';
    dlBtn.addEventListener('click', () => downloadSlide(s));

    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.className = 'secondary';
    delBtn.addEventListener('click', () => {
      slides = slides.filter((x) => x.id !== s.id);
      reindexSlides();
      renderSlides();
    });

    actions.append(editBtn, dlBtn, delBtn);
    card.append(thumbWrap, reorderRow, actions);

    setupDropZone(card, async (bankUrl) => {
      await addBankSlide(bankUrl, displayIndex + 1);
    });

    grid.appendChild(card);
  });

  if (!slidesGridDropSetup) {
    setupDropZone(grid, async (bankUrl) => {
      await addBankSlide(bankUrl);
    });
    slidesGridDropSetup = true;
  }
}

async function addBankSlide(bankUrl, insertAt = slides.length) {
  const slide = {
    id: newSlideId(),
    source: 'bank',
    bankUrl,
    renderedDataUrl: null,
    overlays: [],
  };
  slides.splice(insertAt, 0, slide);
  reindexSlides();
  renderSlides();
  $('#step-slides').classList.remove('hidden');
}

async function downloadSlide(s) {
  const dataUrl = s.renderedDataUrl?.startsWith('data:')
    ? s.renderedDataUrl
    : await urlToPngDataUrl(getSlideDisplayUrl(s));
  triggerDownload(dataUrl, `slide-${s.index + 1}.png`);
}

async function urlToPngDataUrl(url) {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas.toDataURL('image/png');
}

function triggerDownload(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------- Export ZIP (client-side, avoids Vercel body limit) ----------------
$('#btn-export-zip').addEventListener('click', async () => {
  const statusEl = $('#save-status');
  if (!slides.length) { statusEl.textContent = 'Aucune slide à exporter.'; return; }
  if (typeof JSZip === 'undefined') {
    statusEl.textContent = 'JSZip non chargé — rafraîchis la page.';
    return;
  }

  statusEl.textContent = 'Préparation du ZIP...';
  $('#btn-export-zip').disabled = true;

  try {
    const postName = $('#project-name').value.trim() || `post-${Date.now()}`;
    const zip = new JSZip();
    for (let i = 0; i < slides.length; i++) {
      statusEl.textContent = `Compression slide ${i + 1}/${slides.length}...`;
      const pngBlob = await urlToPngBlob(getSlideDisplayUrl(slides[i]));
      zip.file(`slide-${i + 1}.png`, pngBlob);
    }
    statusEl.textContent = 'Génération du ZIP...';
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    triggerDownload(url, `${postName}.zip`);
    URL.revokeObjectURL(url);
    statusEl.textContent = `ZIP téléchargé (${slides.length} slides).`;
  } catch (err) {
    statusEl.textContent = 'Erreur: ' + err.message;
  } finally {
    $('#btn-export-zip').disabled = false;
  }
});

async function urlToPngBlob(url) {
  const dataUrl = await urlToPngDataUrl(url);
  const res = await fetch(dataUrl);
  return res.blob();
}

// ---------------- Image bank ----------------
async function refreshBank() {
  const res = await fetch('/api/bank');
  const data = await res.json();
  bank = data.files;
  renderBankGrid($('#bank-grid'), { deletable: true, draggable: true });
  if (editorState) renderBankGrid($('#editor-bank-grid'), { clickable: true });
}

function renderBankGrid(container, opts = {}) {
  container.innerHTML = '';
  bank.forEach((b) => {
    const wrap = document.createElement('div');
    wrap.className = 'bank-thumb';

    const img = document.createElement('img');
    img.src = b.url;
    img.draggable = false;
    wrap.appendChild(img);

    if (opts.draggable) {
      wrap.draggable = true;
      wrap.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-bank-image', JSON.stringify({ url: b.url, filename: b.filename }));
        e.dataTransfer.effectAllowed = 'copy';
      });
    }

    if (opts.clickable) {
      wrap.addEventListener('click', () => addOverlayToEditor(b.url));
    }

    if (opts.deletable) {
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/bank/${b.filename}`, { method: 'DELETE' });
        refreshBank();
      });
      wrap.appendChild(del);
    }

    container.appendChild(wrap);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function compressFileForUpload(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await compressSlideBlob(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

$('#bank-file-input').addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files.length) return;

  for (const f of files) {
    try {
      const blob = await compressFileForUpload(f);
      const data = await blobToBase64(blob);
      const baseName = f.name.replace(/\.[^.]+$/, '') || 'image';
      const res = await fetch('/api/bank/upload-json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: `${baseName}.jpg`,
          mimeType: 'image/jpeg',
          data,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) alert(payload.error || `Upload échoué pour ${f.name}.`);
    } catch (err) {
      alert(`Upload échoué pour ${f.name}: ${err.message}`);
    }
  }

  e.target.value = '';
  refreshBank();
});

// ---------------- Editor ----------------
async function openEditor(slideId) {
  const slide = slides.find((s) => s.id === slideId);
  if (!slide) return;

  const baseImg = await loadImage(getSlideDisplayUrl(slide));
  const overlays = (slide.overlays || []).map((o) => ({ ...o }));

  editorState = {
    slideId,
    baseImg,
    overlays,
    overlayImgs: {},
    selected: null,
    dragMode: null,
    dragStart: null,
  };

  const canvas = $('#editor-canvas');
  canvas.width = baseImg.naturalWidth;
  canvas.height = baseImg.naturalHeight;
  editorState.canvas = canvas;
  editorState.ctx = canvas.getContext('2d');

  for (const o of overlays) {
    editorState.overlayImgs[o.src] = await loadImage(o.src);
  }

  $('#editor-slide-index').textContent = slide.index + 1;
  $('#editor-modal').classList.remove('hidden');
  renderBankGrid($('#editor-bank-grid'), { clickable: true });
  drawEditor();
}

$('#editor-close').addEventListener('click', () => {
  $('#editor-modal').classList.add('hidden');
  editorState = null;
});

function drawEditor() {
  if (!editorState) return;
  const { ctx, canvas, baseImg, overlays, selected } = editorState;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseImg, 0, 0, canvas.width, canvas.height);

  overlays.forEach((o) => {
    const img = editorState.overlayImgs[o.src];
    if (!img) return;
    ctx.drawImage(img, o.x, o.y, o.w, o.h);
    if (o === selected) {
      ctx.strokeStyle = '#5b8cff';
      ctx.lineWidth = 3;
      ctx.strokeRect(o.x, o.y, o.w, o.h);
      ctx.fillStyle = '#5b8cff';
      ctx.fillRect(o.x + o.w - 12, o.y + o.h - 12, 12, 12);
    }
  });
}

async function addOverlayToEditor(url) {
  if (!editorState) return;
  if (!editorState.overlayImgs[url]) {
    editorState.overlayImgs[url] = await loadImage(url);
  }
  const img = editorState.overlayImgs[url];
  const cw = editorState.canvas.width;
  const ch = editorState.canvas.height;
  const w = Math.min(cw * 0.4, img.naturalWidth);
  const h = w * (img.naturalHeight / img.naturalWidth);
  const overlay = { src: url, x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  editorState.overlays.push(overlay);
  editorState.selected = overlay;
  drawEditor();
}

function canvasCoords(e) {
  const canvas = editorState.canvas;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

$('#editor-canvas').addEventListener('mousedown', (e) => {
  if (!editorState) return;
  const { x, y } = canvasCoords(e);
  const overlays = editorState.overlays;
  for (let i = overlays.length - 1; i >= 0; i--) {
    const o = overlays[i];
    const onHandle =
      x >= o.x + o.w - 14 && x <= o.x + o.w && y >= o.y + o.h - 14 && y <= o.y + o.h;
    const inside = x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h;
    if (onHandle) {
      editorState.selected = o;
      editorState.dragMode = 'resize';
      editorState.dragStart = { x, y, ow: o.w, oh: o.h };
      drawEditor();
      return;
    }
    if (inside) {
      editorState.selected = o;
      editorState.dragMode = 'move';
      editorState.dragStart = { x, y, ox: o.x, oy: o.y };
      drawEditor();
      return;
    }
  }
  editorState.selected = null;
  editorState.dragMode = null;
  drawEditor();
});

window.addEventListener('mousemove', (e) => {
  if (!editorState || !editorState.dragMode || !editorState.selected) return;
  const { x, y } = canvasCoords(e);
  const o = editorState.selected;
  const start = editorState.dragStart;
  if (editorState.dragMode === 'move') {
    o.x = start.ox + (x - start.x);
    o.y = start.oy + (y - start.y);
  } else if (editorState.dragMode === 'resize') {
    const ratio = start.oh / start.ow;
    o.w = Math.max(20, start.ow + (x - start.x));
    o.h = o.w * ratio;
  }
  drawEditor();
});

window.addEventListener('mouseup', () => {
  if (editorState) {
    editorState.dragMode = null;
    editorState.dragStart = null;
  }
});

$('#btn-remove-overlay').addEventListener('click', () => {
  if (!editorState || !editorState.selected) return;
  editorState.overlays = editorState.overlays.filter((o) => o !== editorState.selected);
  editorState.selected = null;
  drawEditor();
});

$('#btn-save-slide').addEventListener('click', () => {
  if (!editorState) return;
  const slide = slides.find((s) => s.id === editorState.slideId);
  if (!slide) return;

  const renderedDataUrl = editorState.canvas.toDataURL('image/png');
  slide.overlays = editorState.overlays.map((o) => ({ ...o }));
  slide.renderedDataUrl = renderedDataUrl;

  $('#editor-modal').classList.add('hidden');
  editorState = null;
  renderSlides();
});

// ---------------- Title ideas ----------------
async function refreshTitles() {
  const res = await fetch('/api/titles');
  const data = await res.json();
  renderTitlesList(data.titles || []);
}

function renderTitlesList(titles) {
  const list = $('#titles-list');
  const empty = $('#titles-empty');
  list.innerHTML = '';

  if (!titles.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  titles.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'title-row';

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = t.text;

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Supprimer';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/titles/${t.id}`, { method: 'DELETE' });
      refreshTitles();
    });

    row.addEventListener('click', () => {
      $('#project-name').value = t.text;
      if (currentProject) currentProject.name = t.text;
    });

    row.append(text, del);
    list.appendChild(row);
  });
}

$('#btn-add-title').addEventListener('click', async () => {
  const input = $('#title-input');
  const text = input.value.trim();
  if (!text) return;
  const res = await fetch('/api/titles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (res.ok) {
    input.value = '';
    refreshTitles();
  }
});

$('#title-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-add-title').click();
});

// ---------------- Navigation ----------------
function showView(view) {
  const workspace = $('#view-workspace');
  const analytics = $('#view-analytics');
  const navWorkspace = $('#nav-workspace');
  const navAnalytics = $('#nav-analytics');
  if (view === 'analytics') {
    workspace?.classList.add('hidden');
    analytics?.classList.remove('hidden');
    navWorkspace?.classList.remove('active');
    navAnalytics?.classList.add('active');
    refreshAnalytics();
  } else {
    workspace?.classList.remove('hidden');
    analytics?.classList.add('hidden');
    navWorkspace?.classList.add('active');
    navAnalytics?.classList.remove('active');
  }
}

$('#nav-workspace')?.addEventListener('click', () => showView('workspace'));
$('#nav-analytics')?.addEventListener('click', () => showView('analytics'));

// ---------------- Analytics ----------------
let analyticsChart = null;
let analyticsProjects = [];
const analyticsSelected = new Set();

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function renderAnalyticsList() {
  const list = $('#analytics-list');
  const empty = $('#analytics-empty');
  if (!list) return;

  list.innerHTML = '';
  if (!analyticsProjects.length) {
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  analyticsProjects.forEach((p) => {
    const row = document.createElement('label');
    row.className = 'analytics-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = analyticsSelected.has(p.id);
    cb.addEventListener('change', () => {
      if (cb.checked) analyticsSelected.add(p.id);
      else analyticsSelected.delete(p.id);
      renderAnalyticsChart();
    });

    const info = document.createElement('div');
    info.className = 'analytics-row-info';

    const title = document.createElement('strong');
    title.textContent = p.name;

    const stats = document.createElement('span');
    stats.className = 'meta';
    const updated = p.analyticsUpdatedAt
      ? ` · MAJ ${new Date(p.analyticsUpdatedAt).toLocaleString('fr-FR')}`
      : '';
    stats.textContent = `${formatCount(p.viewCount)} vues · ${formatCount(p.likeCount)} likes · ${formatCount(p.commentCount)} com. · ${formatCount(p.shareCount)} partages${updated}`;

    info.append(title, stats);

    if (p.postedUrl) {
      const link = document.createElement('a');
      link.href = p.postedUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'analytics-link';
      link.textContent = 'Voir sur TikTok';
      info.appendChild(link);
    } else {
      const warn = document.createElement('span');
      warn.className = 'meta warn';
      warn.textContent = 'Lien TikTok manquant';
      info.appendChild(warn);
    }

    row.append(cb, info);
    list.appendChild(row);
  });
}

function renderAnalyticsChart() {
  const canvas = $('#analytics-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const selected = analyticsProjects.filter((p) => analyticsSelected.has(p.id));
  const labels = selected.map((p) => p.name);
  const views = selected.map((p) => p.viewCount || 0);
  const likes = selected.map((p) => p.likeCount || 0);
  const comments = selected.map((p) => p.commentCount || 0);

  if (analyticsChart) analyticsChart.destroy();

  if (!selected.length) {
    analyticsChart = null;
    return;
  }

  analyticsChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Vues', data: views, backgroundColor: 'rgba(91, 140, 255, 0.7)' },
        { label: 'Likes', data: likes, backgroundColor: 'rgba(51, 196, 129, 0.7)' },
        { label: 'Commentaires', data: comments, backgroundColor: 'rgba(240, 173, 78, 0.7)' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#c8cdd8' } } },
      scales: {
        x: { ticks: { color: '#9aa2b1' }, grid: { color: 'rgba(255,255,255,0.06)' } },
        y: { ticks: { color: '#9aa2b1' }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true },
      },
    },
  });
}

async function refreshAnalytics() {
  const statusEl = $('#analytics-status');
  try {
    const res = await fetch('/api/analytics');
    const data = await res.json();
    analyticsProjects = data.projects || [];

    const ids = new Set(analyticsProjects.map((p) => p.id));
    [...analyticsSelected].forEach((id) => {
      if (!ids.has(id)) analyticsSelected.delete(id);
    });
    if (!analyticsSelected.size) {
      analyticsProjects.forEach((p) => analyticsSelected.add(p.id));
    }

    const btnConnect = $('#btn-tiktok-connect');
    if (btnConnect) {
      if (!data.tiktok?.configured) {
        btnConnect.textContent = 'API TikTok non configurée';
        btnConnect.disabled = true;
      } else if (data.tiktok?.connected) {
        btnConnect.textContent = 'TikTok connecté ✓';
        btnConnect.disabled = false;
      } else {
        btnConnect.textContent = 'Connecter TikTok';
        btnConnect.disabled = false;
      }
    }

    if (statusEl) {
      statusEl.textContent = data.tiktok?.connected
        ? `${analyticsProjects.length} carrousel(s) publié(s).`
        : `${analyticsProjects.length} carrousel(s) publié(s). Connecte TikTok pour récupérer les stats automatiquement.`;
    }

    renderAnalyticsList();
    renderAnalyticsChart();
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Erreur: ' + err.message;
  }
}

$('#btn-tiktok-connect')?.addEventListener('click', () => {
  window.location.href = '/api/tiktok/auth';
});

$('#btn-analytics-refresh')?.addEventListener('click', async () => {
  const statusEl = $('#analytics-status');
  statusEl.textContent = 'Actualisation des stats TikTok...';
  $('#btn-analytics-refresh').disabled = true;
  try {
    const res = await fetch('/api/analytics/refresh', { method: 'POST' });
    const data = await parseJsonResponse(res);
    if (!res.ok) throw new Error(data.error || 'Échec refresh');
    analyticsProjects = data.projects || [];
    if (data.message) statusEl.textContent = data.message;
    else statusEl.textContent = `${data.updated || 0} carrousel(s) mis à jour.`;
    renderAnalyticsList();
    renderAnalyticsChart();
  } catch (err) {
    statusEl.textContent = 'Erreur: ' + err.message;
  } finally {
    $('#btn-analytics-refresh').disabled = false;
  }
});

function handleTikTokOAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  const tiktok = params.get('tiktok');
  if (!tiktok) return;
  if (tiktok === 'connected') showView('analytics');
  if (tiktok === 'error') {
    const el = $('#analytics-status');
    if (el) el.textContent = 'Connexion TikTok échouée. Vérifie la config OAuth.';
    showView('analytics');
  }
  window.history.replaceState({}, '', window.location.pathname);
}

// ---------------- Storage status ----------------
async function refreshStorageStatus() {
  const el = $('#storage-status');
  if (!el) return;
  try {
    const res = await fetch('/api/storage');
    const data = await res.json();
    el.textContent = data.hint || '';
    el.classList.toggle('persistent', !!data.persistent);
    el.classList.toggle('ephemeral', !data.persistent);
  } catch {
    el.textContent = '';
  }
}

// ---------------- Init ----------------
handleTikTokOAuthReturn();
syncPostedUrlRow();
refreshStorageStatus();
refreshBank();
refreshProjects();
refreshTitles();
