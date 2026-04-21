/* ── app.js ─ MediaConverter client ─────────────────────────────────────── */

const FORMATS = {
  video: ['mp4', 'avi', 'mov', 'mkv', 'webm'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'],
  image: ['jpg', 'png', 'gif', 'bmp', 'tiff', 'webp']
};

const EMOJIS = { video: '🎬', audio: '🎵', image: '🖼️' };

// ── DOM ───────────────────────────────────────────────────────────────────────
const dropZone         = document.getElementById('dropZone');
const fileInput        = document.getElementById('fileInput');
const convertPanel     = document.getElementById('convertPanel');
const progressWrap     = document.getElementById('progressWrap');
const resultWrap       = document.getElementById('resultWrap');
const errorWrap        = document.getElementById('errorWrap');
const fileEmoji        = document.getElementById('fileEmoji');
const fileNameEl       = document.getElementById('fileName');
const fileMetaEl       = document.getElementById('fileMeta');
const fmtGrid          = document.getElementById('fmtGrid');
const convertBtn       = document.getElementById('convertBtn');
const clearBtn         = document.getElementById('clearBtn');
const progressFill     = document.getElementById('progressFill');
const progressPct      = document.getElementById('progressPct');
const resultName       = document.getElementById('resultName');
const downloadBtn      = document.getElementById('downloadBtn');
const newBtn           = document.getElementById('newBtn');
const retryBtn         = document.getElementById('retryBtn');
const errorMsg         = document.getElementById('errorMsg');
const historyToggleBtn = document.getElementById('historyToggleBtn');
const historyCard      = document.getElementById('historyCard');
const historyBody      = document.getElementById('historyBody');
const historyRefreshBtn = document.getElementById('historyRefreshBtn');
const paramsToggleBtn  = document.getElementById('paramsToggleBtn');
const paramsPanel      = document.getElementById('paramsPanel');
const paramsVideo      = document.getElementById('paramsVideo');
const paramsAudio      = document.getElementById('paramsAudio');
const paramsImage      = document.getElementById('paramsImage');

// ── State ─────────────────────────────────────────────────────────────────────
let selectedFile   = null;
let selectedFormat = null;
let currentJobId   = null;
let pollTimer      = null;

// ══════════════════════════════════════════════════════════════════════════════
// FILE SELECTION
// ══════════════════════════════════════════════════════════════════════════════

function ext(filename)  { return filename.split('.').pop().toLowerCase(); }

function fileType(e)    {
  for (const [t, list] of Object.entries(FORMATS)) if (list.includes(e)) return t;
  return null;
}

function fmtBytes(b) {
  if (b < 1024)        return b + ' Б';
  if (b < 1048576)     return (b / 1024).toFixed(1) + ' КБ';
  return (b / 1048576).toFixed(1) + ' МБ';
}

function loadFile(file) {
  const e = ext(file.name);
  const t = fileType(e);
  if (!t)                         return showError('Неподдерживаемый тип файла: .' + e);
  if (file.size > 524288000)      return showError('Файл слишком большой. Максимум — 500 МБ.');

  selectedFile   = file;
  selectedFormat = null;

  fileEmoji.textContent = EMOJIS[t];
  fileNameEl.textContent = file.name;
  fileMetaEl.textContent = fmtBytes(file.size) + ' · ' + t.toUpperCase();

  fmtGrid.innerHTML = '';
  FORMATS[t].forEach(f => {
    if (f === e) return;
    const chip = document.createElement('button');
    chip.className   = 'fmt-chip';
    chip.textContent = f;
    chip.addEventListener('click', () => {
      fmtGrid.querySelectorAll('.fmt-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedFormat = f;
    });
    fmtGrid.appendChild(chip);
  });

  // show correct params group
  [paramsVideo, paramsAudio, paramsImage].forEach(g => g.classList.add('hidden'));
  ({ video: paramsVideo, audio: paramsAudio, image: paramsImage })[t]?.classList.remove('hidden');
  paramsPanel.classList.add('hidden');
  paramsToggleBtn.classList.remove('active');

  showSection('convert');
}

// ── drag & drop
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop',      e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0]; if (f) loadFile(f);
});
fileInput.addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFile(f); });

clearBtn.addEventListener('click', resetAll);

// ══════════════════════════════════════════════════════════════════════════════
// CONVERSION
// ══════════════════════════════════════════════════════════════════════════════

convertBtn.addEventListener('click', async () => {
  if (!selectedFile)   return;
  if (!selectedFormat) return alert('Выберите целевой формат.');

  showSection('progress');
  setProgress(0);

  const fd = new FormData();
  fd.append('file', selectedFile);
  fd.append('targetFormat', selectedFormat);
  fd.append('conversionParams', JSON.stringify(collectParams()));

  let res;
  try {
    res = await fetch('/api/convert', { method: 'POST', body: fd });
  } catch {
    return showError('Ошибка подключения к серверу.');
  }

  const data = await res.json();
  if (!res.ok) return showError(data.error || 'Ошибка сервера.');

  currentJobId = data.jobId;
  startPolling();
});

function startPolling() {
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${currentJobId}`);
      if (!res.ok) { stopPolling(); return showError('Не удалось получить статус задания.'); }
      const job = await res.json();

      setProgress(job.progress || 0);

      if (job.status === 'done') {
        stopPolling();
        setProgress(100);
        const outName = selectedFile.name.replace(/\.[^.]+$/, '') + '.' + selectedFormat;
        resultName.textContent = outName;
        downloadBtn.onclick    = () => { window.location.href = `/api/download/${currentJobId}`; };
        showSection('done');
      } else if (job.status === 'error') {
        stopPolling();
        showError(job.error || 'Конвертация завершилась ошибкой.');
      }
    } catch {
      stopPolling();
      showError('Потеряно соединение с сервером.');
    }
  }, 2000);
}

function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

function setProgress(pct) {
  progressFill.style.width = pct + '%';
  progressPct.textContent  = pct + '%';
}

// ── reset buttons
newBtn.addEventListener('click',   resetAll);
retryBtn.addEventListener('click', () => { selectedFile ? loadFile(selectedFile) : resetAll(); });

function resetAll() {
  stopPolling();
  selectedFile   = null;
  selectedFormat = null;
  currentJobId   = null;
  fileInput.value = '';
  paramsPanel.classList.add('hidden');
  paramsToggleBtn.classList.remove('active');
  showSection('drop');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION VISIBILITY
// ══════════════════════════════════════════════════════════════════════════════

function showSection(name) {
  const sections = { drop: dropZone, convert: convertPanel, progress: progressWrap, done: resultWrap, error: errorWrap };
  Object.values(sections).forEach(el => el.classList.add('hidden'));
  sections[name]?.classList.remove('hidden');
}

function showError(msg) {
  stopPolling();
  errorMsg.textContent = msg;
  showSection('error');
}

// ── Params toggle ────────────────────────────────────────────────────────────
paramsToggleBtn.addEventListener('click', () => {
  paramsPanel.classList.toggle('hidden');
  paramsToggleBtn.classList.toggle('active', !paramsPanel.classList.contains('hidden'));
});

document.getElementById('pQuality').addEventListener('input', e => {
  document.getElementById('pQualityVal').textContent = e.target.value;
});

function collectParams() {
  if (paramsPanel.classList.contains('hidden')) return {};
  const t = fileType(ext(selectedFile.name));
  const p = {};
  if (t === 'video') {
    const vc  = document.getElementById('pVideoCodec').value;
    const vb  = document.getElementById('pVideoBitrate').value;
    const w   = document.getElementById('pWidth').value;
    const h   = document.getElementById('pHeight').value;
    const fps = document.getElementById('pFps').value;
    const ab  = document.getElementById('pVideoAudioBitrate').value;
    if (vc)  p.video_codec    = vc;
    if (vb)  p.video_bitrate  = parseInt(vb);
    if (w)   p.width          = parseInt(w);
    if (h)   p.height         = parseInt(h);
    if (fps) p.fps            = parseInt(fps);
    if (ab)  p.audio_bitrate  = parseInt(ab);
  } else if (t === 'audio') {
    const ab = document.getElementById('pAudioBitrate').value;
    const af = document.getElementById('pAudioFreq').value;
    const ac = document.getElementById('pAudioChannels').value;
    if (ab) p.audio_bitrate   = parseInt(ab);
    if (af) p.audio_frequency = parseInt(af);
    if (ac) p.audio_channels  = parseInt(ac);
  } else if (t === 'image') {
    const w   = document.getElementById('pImgWidth').value;
    const h   = document.getElementById('pImgHeight').value;
    const fit = document.getElementById('pFit').value;
    p.quality = parseInt(document.getElementById('pQuality').value);
    if (w)   p.width  = parseInt(w);
    if (h)   p.height = parseInt(h);
    if (fit) p.fit    = fit;
  }
  return p;
}

// ══════════════════════════════════════════════════════════════════════════════
// HISTORY (Xano)
// ══════════════════════════════════════════════════════════════════════════════

historyToggleBtn.addEventListener('click', () => {
  const visible = !historyCard.classList.contains('hidden');
  historyCard.classList.toggle('hidden', visible);
  if (!visible) return;
  loadHistory();
});

historyRefreshBtn.addEventListener('click', loadHistory);

async function loadHistory() {
  historyBody.innerHTML = '<p class="history-empty">Загрузка…</p>';
  try {
    const res  = await fetch('/api/history');
    const data = await res.json();

    if (!res.ok) {
      historyBody.innerHTML = `<p class="history-empty" style="color:#ef4444">${data.error || 'Ошибка загрузки'}</p>`;
      return;
    }

    const rows = Array.isArray(data) ? data : (data.items || data.result || []);

    if (!rows.length) {
      historyBody.innerHTML = '<p class="history-empty">История пуста.</p>';
      return;
    }

    const table = document.createElement('table');
    table.className = 'history-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Файл</th>
          <th>Формат</th>
          <th>Дата</th>
          <th>Статус</th>
        </tr>
      </thead>`;

    const tbody = document.createElement('tbody');
    rows.slice().reverse().forEach(r => {
      const tr  = document.createElement('tr');
      const src = r.source_format || r.sourceFormat || '—';
      const tgt = r.target_format || r.targetFormat || '—';
      const dt  = r.converted_at  || r.created_at   || '';
      const ok  = r.status === 'success';
      tr.innerHTML = `
        <td title="${esc(r.original_filename || r.originalFilename || '')}">${truncate(r.original_filename || r.originalFilename || '—', 28)}</td>
        <td>${esc(src)} → ${esc(tgt)}</td>
        <td>${dt ? fmtDate(dt) : '—'}</td>
        <td class="${ok ? 'hist-status-ok' : 'hist-status-err'}">${ok ? '✓ Успешно' : '✗ Ошибка'}</td>`;
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    historyBody.innerHTML = '';
    historyBody.appendChild(table);
  } catch {
    historyBody.innerHTML = '<p class="history-empty" style="color:#ef4444">Не удалось связаться с Xano.</p>';
  }
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function truncate(s, n) { return s.length > n ? esc(s.slice(0, n)) + '…' : esc(s); }
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
  } catch { return iso; }
}

// ── Init: show drop zone
showSection('drop');
