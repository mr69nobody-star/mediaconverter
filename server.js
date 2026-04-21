require('dotenv').config();
const express    = require('express');
const multer     = require('multer');
const { randomUUID } = require('crypto');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const axios      = require('axios');
const FormData   = require('form-data');

const app  = express();
const PORT = process.env.PORT || 3000;

const CC_API       = 'https://api.cloudconvert.com/v2';
const HISTORY_FILE = path.join(__dirname, 'history.json');

// ── Directories ────────────────────────────────────────────────────────────────
const UPLOADS_DIR   = path.join(__dirname, 'uploads');
const CONVERTED_DIR = path.join(__dirname, 'converted');
[UPLOADS_DIR, CONVERTED_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer ─────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp4|avi|mov|mkv|webm|mp3|wav|ogg|flac|aac|m4a|jpg|jpeg|png|gif|bmp|tiff|svg)$/i;
    ok.test(path.extname(file.originalname)) ? cb(null, true) : cb(new Error('Неподдерживаемый формат'));
  }
});

// ── Formats ────────────────────────────────────────────────────────────────────
const FORMATS = {
  video: ['mp4', 'avi', 'mov', 'mkv', 'webm'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'],
  image: ['jpg', 'png', 'gif', 'bmp', 'tiff', 'svg', 'webp']
};

function getType(ext) {
  const e = ext.replace('.', '').toLowerCase();
  for (const [t, list] of Object.entries(FORMATS)) if (list.includes(e)) return t;
  return null;
}

// ── Jobs store ─────────────────────────────────────────────────────────────────
const jobs = {};

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/convert
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

  const { targetFormat } = req.body;
  if (!targetFormat) { cleanup(req.file.path); return res.status(400).json({ error: 'Не указан целевой формат' }); }

  const srcExt  = path.extname(req.file.originalname).toLowerCase();
  const srcType = getType(srcExt);
  const tgtType = getType(`.${targetFormat}`);

  if (!srcType || !tgtType) { cleanup(req.file.path); return res.status(400).json({ error: 'Неподдерживаемый формат' }); }
  if ((srcType === 'image') !== (tgtType === 'image')) {
    cleanup(req.file.path);
    return res.status(400).json({ error: 'Нельзя конвертировать между разными типами медиа' });
  }

  const jobId = randomUUID();
  const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
  const safeBase = baseName.replace(/[^\w\-. ]/g, '_') || 'file';
  const shortId  = jobId.split('-')[0]; // 8-char prefix to avoid collisions
  jobs[jobId] = {
    status: 'processing', progress: 0,
    outputFilename: `${safeBase}_${shortId}.${targetFormat}`,
    originalFilename: req.file.originalname,
    targetFormat, error: null, createdAt: Date.now()
  };

  res.json({ jobId });

  // async conversion
  try {
    await convertWithCloudConvert(req.file.path, req.file.originalname, targetFormat, jobId);
    jobs[jobId].status   = 'done';
    jobs[jobId].progress = 100;
    console.log(`[OK] Job ${jobId} done → ${jobs[jobId].outputFilename}`);
    saveHistory({ status: 'success', originalFilename: req.file.originalname,
      sourceFormat: srcExt.replace('.', ''), targetFormat, fileSizeBytes: req.file.size });
  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].error  = err.message;
    console.error(`[ERR] Job ${jobId} failed: ${err.message}`);
    saveHistory({ status: 'error', originalFilename: req.file.originalname,
      sourceFormat: srcExt.replace('.', ''), targetFormat, fileSizeBytes: req.file.size, error: err.message });
  } finally {
    cleanup(req.file.path);
  }
});

// ── GET /api/status/:id ────────────────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  res.json(job);
});

// ── GET /api/download/:id ──────────────────────────────────────────────────────
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Файл не готов' });
  const fp = path.join(CONVERTED_DIR, job.outputFilename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Файл не найден' });
  res.download(fp, job.outputFilename, err => {
    if (!err) setTimeout(() => { cleanup(fp); delete jobs[req.params.jobId]; }, 60000);
  });
});

// ── GET /api/formats ───────────────────────────────────────────────────────────
app.get('/api/formats', (req, res) => res.json(FORMATS));

// ── GET /api/history ──────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  try {
    const data = fs.existsSync(HISTORY_FILE)
      ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
      : [];
    res.json(data);
  } catch {
    res.json([]);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CloudConvert
// ══════════════════════════════════════════════════════════════════════════════
async function convertWithCloudConvert(inputPath, originalFilename, targetFormat, jobId) {
  const headers = { Authorization: `Bearer ${process.env.CLOUDCONVERT_API_KEY}` };

  console.log(`[CC] Creating job: ${originalFilename} → ${targetFormat}`);
  let jobData;
  try {
    const resp = await axios.post(`${CC_API}/jobs`, {
      tasks: {
        'upload':  { operation: 'import/upload' },
        'convert': { operation: 'convert',    input: ['upload'], output_format: targetFormat },
        'export':  { operation: 'export/url', input: ['convert'] }
      }
    }, { headers });
    jobData = resp.data;
  } catch (err) {
    const detail = err.response?.data?.message || JSON.stringify(err.response?.data) || err.message;
    throw new Error(`CloudConvert job creation failed (${err.response?.status}): ${detail}`);
  }

  const ccJob      = jobData.data;
  console.log(`[CC] Job created: ${ccJob.id}`);
  const uploadTask = ccJob.tasks.find(t => t.name === 'upload');
  if (!uploadTask?.result?.form) throw new Error('CloudConvert: не получена форма загрузки');

  // 2. Upload file
  const { url: uploadUrl, parameters } = uploadTask.result.form;
  const fd = new FormData();
  Object.entries(parameters).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', fs.createReadStream(inputPath), originalFilename);
  await axios.post(uploadUrl, fd, { headers: fd.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity });
  console.log(`[CC] Upload done, polling...`);

  // 3. Poll (max 10 min)
  let exportTask = null;
  for (let i = 0; i < 300; i++) {
    await sleep(2000);
    const { data: sd } = await axios.get(`${CC_API}/jobs/${ccJob.id}`, { headers });
    const cur = sd.data;
    const cv  = cur.tasks.find(t => t.name === 'convert');
    if (cv?.percent != null) jobs[jobId].progress = Math.min(Math.round(cv.percent), 99);
    if (cur.status === 'finished') { exportTask = cur.tasks.find(t => t.name === 'export'); break; }
    if (cur.status === 'error') {
      const errTask = cur.tasks.find(t => t.status === 'error');
      throw new Error(errTask?.message || 'Ошибка конвертации в CloudConvert');
    }
  }
  if (!exportTask) throw new Error('Превышено время ожидания конвертации (10 мин)');

  // 4. Download result (pre-signed S3 URL — NO auth header!)
  console.log(`[CC] Conversion finished, downloading from: ${exportTask.result.files[0].url}`);
  const fileUrl    = exportTask.result.files[0].url;
  const outputPath = path.join(CONVERTED_DIR, jobs[jobId].outputFilename);
  const resp       = await axios.get(fileUrl, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outputPath);
    resp.data.pipe(w);
    w.on('finish', () => { console.log(`[CC] File saved: ${outputPath}`); resolve(); });
    w.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// History — save to JSON file
// ══════════════════════════════════════════════════════════════════════════════
function saveHistory(payload) {
  try {
    const history = fs.existsSync(HISTORY_FILE)
      ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
      : [];
    history.unshift({ ...payload, converted_at: new Date().toISOString() });
    if (history.length > 200) history.splice(200);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[History] save error:', err.message);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function cleanup(fp) { try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {} }
function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }

// ── Hourly cleanup ─────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of Object.entries(jobs)) {
    if (now - job.createdAt > 3600000) {
      cleanup(path.join(CONVERTED_DIR, job.outputFilename));
      delete jobs[id];
    }
  }
}, 3600000);

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nMediaConverter → http://localhost:${PORT}`);
  console.log(`CloudConvert : ${process.env.CLOUDCONVERT_API_KEY ? '✓' : '✗ ключ не задан'}`);
  console.log(`History      : ${HISTORY_FILE}\n`);
});
