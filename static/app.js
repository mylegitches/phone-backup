// State
let currentJobId = null;
let currentRunId = null;
let currentRecId = null;
let allPackages = [];
let currentGrantPkg = null;
let activeSSE = null;

// ============================================================ INIT ===

document.addEventListener('DOMContentLoaded', () => {
  // Tab nav
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Wizard step clicks in bar
  document.querySelectorAll('.wizard-step-item').forEach(item => {
    item.addEventListener('click', () => wizardGo(parseInt(item.dataset.step)));
  });

  // Load initial data
  initWizard();
  loadJobs();
  refreshDevices();

  // Populate job select in Run tab when switching to it
  // (handled by showTab)
});

// ============================================================ TABS ===

function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
  const section = document.getElementById('tab-' + name);
  const btn = document.querySelector(`.nav-tab[data-tab="${name}"]`);
  if (section) section.classList.add('active');
  if (btn) btn.classList.add('active');

  if (name === 'run') populateRunSelects();
  if (name === 'tools' || name === 'apps') populateToolDeviceSelects();
}

// ============================================================ DEVICES ===

async function refreshDevices() {
  const dot = document.getElementById('device-dot');
  const label = document.getElementById('device-label');
  try {
    const data = await api('/api/adb/devices');
    const authorized = data.devices?.filter(d => d.state === 'device') || [];
    const unauthorized = data.devices?.filter(d => d.state === 'unauthorized') || [];

    if (authorized.length > 0) {
      dot.className = 'device-dot connected';
      label.textContent = authorized.length === 1
        ? authorized[0].serial
        : `${authorized.length} devices`;
    } else if (unauthorized.length > 0) {
      dot.className = 'device-dot unauthorized';
      label.textContent = 'Tap Allow on phone';
    } else if (data.error) {
      dot.className = 'device-dot';
      label.textContent = 'ADB not found';
    } else {
      dot.className = 'device-dot';
      label.textContent = 'No device';
    }

    window._devices = data.devices || [];
    populateToolDeviceSelects();
  } catch (e) {
    dot.className = 'device-dot';
    label.textContent = 'Error';
  }
}

function populateSelect(selectId, devices) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- auto detect --</option>';
  (devices || []).forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.serial;
    opt.textContent = `${d.serial} (${d.state})`;
    if (d.state !== 'device') opt.disabled = true;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function populateToolDeviceSelects() {
  const devices = window._devices || [];
  ['tools-device-select', 'apps-device-select', 'run-device-select'].forEach(id => populateSelect(id, devices));
}

function getToolsSerial() {
  return document.getElementById('tools-device-select')?.value || '';
}

function fillCurrentSerial(inputId) {
  const devices = (window._devices || []).filter(d => d.state === 'device');
  if (devices.length > 0) {
    document.getElementById(inputId).value = devices[0].serial;
  } else {
    alert('No authorized device connected.');
  }
}

// ============================================================ WIZARD ===

let wizardStep = 0;

async function initWizard() {
  const info = await api('/api/platform');
  document.getElementById('platform-info-loading').style.display = 'none';
  document.getElementById('platform-info').style.display = 'block';

  const osBox = document.getElementById('os-detected-box');
  const osEmoji = { windows: '🪟', macos: '🍎', linux: '🐧' }[info.os] || '💻';
  osBox.innerHTML = `${osEmoji} Detected OS: <strong>${info.os.charAt(0).toUpperCase() + info.os.slice(1)}</strong>` +
    (info.arch ? ` (${info.arch})` : '') +
    (info.adb_found ? ` — ✅ ADB found at <code>${info.adb_path}</code>` : ' — ⚠️ ADB not detected yet');

  const stepsList = document.getElementById('install-steps-list');
  stepsList.innerHTML = '<ol>' + (info.install_steps || []).map(s => `<li>${s}</li>`).join('') + '</ol>';
  stepsList.style.marginBottom = '16px';
  stepsList.style.paddingLeft = '4px';

  const downloadBtn = document.getElementById('download-btn');
  if (info.download_url) downloadBtn.href = info.download_url;

  if (info.udev_note) {
    const udevEl = document.getElementById('udev-note');
    udevEl.textContent = '🐧 ' + info.udev_note;
    udevEl.style.display = 'block';
  }

  if (info.adb_found) {
    showResultBox('adb-check-result', true, `✅ ${info.adb_version}`);
  }
}

async function checkAdb() {
  const box = document.getElementById('adb-check-result');
  box.style.display = 'block';
  box.className = 'result-box';
  box.textContent = 'Checking...';
  const data = await api('/api/adb/check');
  showResultBox('adb-check-result', data.found, data.found ? `✅ ${data.version}` : `❌ ${data.error}`);
}

function wizardGo(n) {
  document.querySelectorAll('.wizard-step').forEach((el, i) => {
    el.classList.toggle('active', i === n);
  });
  document.querySelectorAll('.wizard-step-item').forEach((el, i) => {
    el.classList.toggle('active', i === n);
  });
  wizardStep = n;
}

function switchInnerTab(tabId, btn) {
  const parent = btn.closest('.wizard-step');
  parent.querySelectorAll('.inner-tab').forEach(t => t.classList.remove('active'));
  parent.querySelectorAll('.inner-tab-content').forEach(t => t.style.display = 'none');
  btn.classList.add('active');
  const content = document.getElementById(tabId);
  if (content) { content.style.display = 'block'; content.classList.add('active'); }
}

async function detectDevices() {
  const resultEl = document.getElementById('detect-result');
  resultEl.style.display = 'block';
  resultEl.className = 'result-box';
  resultEl.textContent = 'Scanning...';
  const data = await api('/api/adb/devices');
  if (data.error) {
    showResultBox('detect-result', false, '❌ ' + data.error);
    return;
  }
  if (!data.devices.length) {
    showResultBox('detect-result', false, '⚠️ No devices found. Make sure the phone is connected and USB Debugging is enabled.');
    return;
  }
  const lines = data.devices.map(d =>
    d.state === 'device' ? `✅ ${d.serial} — Connected`
    : d.state === 'unauthorized' ? `⚠️ ${d.serial} — Tap "Allow USB debugging" on your phone`
    : `❓ ${d.serial} — ${d.state}`
  );
  showResultBox('detect-result', data.devices.some(d => d.state === 'device'), lines.join('\n'));
  refreshDevices();
}

async function pairWifi() {
  const host = document.getElementById('wifi-ip').value.trim();
  const port = document.getElementById('wifi-pair-port').value.trim();
  const code = document.getElementById('wifi-code').value.trim();
  const data = await api('/api/adb/pair', 'POST', { host, port, code });
  showResultBox('pair-result', data.success, data.output || data.error);
  if (data.success) refreshDevices();
}

async function enableTcpip() {
  const serial = (window._devices || []).find(d => d.state === 'device')?.serial || '';
  const data = await api('/api/adb/tcpip', 'POST', { serial });
  showResultBox('legacy-result', data.success, data.output || data.error);
}

async function connectLegacyWifi() {
  const host = document.getElementById('legacy-ip').value.trim();
  const data = await api('/api/adb/connect', 'POST', { host, port: '5555' });
  showResultBox('legacy-result', data.success, data.output || data.error);
  if (data.success) refreshDevices();
}

async function verifyConnection() {
  const data = await api('/api/adb/devices');
  const resultEl = document.getElementById('verify-result');
  const successEl = document.getElementById('verify-success');
  resultEl.style.display = 'block';

  if (data.error || !data.devices?.length) {
    showResultBox('verify-result', false, '❌ No devices found. Go back to Step 4.');
    successEl.style.display = 'none';
    return;
  }
  const authorized = data.devices.filter(d => d.state === 'device');
  const lines = data.devices.map(d =>
    `${d.state === 'device' ? '✅' : '⚠️'} ${d.serial} — ${d.state}`
  );
  showResultBox('verify-result', authorized.length > 0, lines.join('\n'));
  successEl.style.display = authorized.length > 0 ? 'block' : 'none';
  refreshDevices();
}

// ============================================================ JOBS ===

const SOURCE_PRESETS = [
  { label: 'DCIM (Camera)', value: '/sdcard/DCIM' },
  { label: 'Pictures', value: '/sdcard/Pictures' },
  { label: 'Downloads', value: '/sdcard/Download' },
  { label: 'Music', value: '/sdcard/Music' },
  { label: 'Documents', value: '/sdcard/Documents' },
  { label: 'WhatsApp', value: '/sdcard/WhatsApp' },
  { label: 'Telegram', value: '/sdcard/Telegram' },
  { label: 'Screenshots', value: '/sdcard/Pictures/Screenshots' },
  { label: 'Entire Storage', value: '/sdcard/' },
  { label: 'Custom...', value: '__custom__' },
];

async function loadJobs() {
  const jobs = await api('/api/jobs');
  const listEl = document.getElementById('jobs-list');
  if (!jobs.length) {
    listEl.innerHTML = '<div class="muted" style="padding:16px;font-size:13px">No jobs yet. Click + New to create one.</div>';
    return;
  }
  listEl.innerHTML = '';
  jobs.forEach(job => {
    const item = document.createElement('div');
    item.className = 'job-item' + (job.id === currentJobId ? ' active' : '');
    item.innerHTML = `
      <div>
        <div class="job-item-name">${escHtml(job.name)}</div>
        <div class="job-item-meta">${job.method === 'pull' ? '📂 adb pull' : '💾 adb backup'} · ${job.method === 'pull' ? (job.mappings?.length || 0) + ' mapping(s)' : 'Full backup'}</div>
      </div>
    `;
    item.addEventListener('click', () => editJob(job));
    listEl.appendChild(item);
  });
}

function newJob() {
  currentJobId = null;
  document.getElementById('editor-empty').style.display = 'none';
  document.getElementById('job-form').style.display = 'block';
  document.getElementById('delete-job-btn').style.display = 'none';
  document.getElementById('job-id').value = '';
  document.getElementById('job-name').value = '';
  document.getElementById('job-serial').value = '';
  document.querySelector('input[name="method"][value="pull"]').checked = true;
  toggleMethod();
  document.getElementById('mapping-tbody').innerHTML = '';
  addMapping('/sdcard/DCIM', '');
  addMapping('/sdcard/Pictures', '');
  addMapping('/sdcard/Download', '');
  document.getElementById('flag-apk').checked = false;
  document.getElementById('flag-shared').checked = true;
  document.getElementById('flag-all').checked = true;
  document.getElementById('flag-system').checked = false;
  document.getElementById('backup-output').value = '';
}

function editJob(job) {
  currentJobId = job.id;
  document.getElementById('editor-empty').style.display = 'none';
  document.getElementById('job-form').style.display = 'block';
  document.getElementById('delete-job-btn').style.display = 'inline-flex';
  document.getElementById('job-id').value = job.id;
  document.getElementById('job-name').value = job.name;
  document.getElementById('job-serial').value = job.device_serial || '';

  const methodRadio = document.querySelector(`input[name="method"][value="${job.method}"]`);
  if (methodRadio) methodRadio.checked = true;
  toggleMethod();

  // Populate mappings
  document.getElementById('mapping-tbody').innerHTML = '';
  (job.mappings || []).forEach(m => addMapping(m.source, m.destination, m.enabled !== false));

  // Backup flags
  const flags = job.backup_flags || {};
  document.getElementById('flag-apk').checked = !!flags.apk;
  document.getElementById('flag-shared').checked = flags.shared !== false;
  document.getElementById('flag-all').checked = flags.all !== false;
  document.getElementById('flag-system').checked = !!flags.system;
  document.getElementById('backup-output').value = job.backup_output || '';

  // Highlight active in list
  document.querySelectorAll('.job-item').forEach(el => el.classList.remove('active'));
  const items = document.querySelectorAll('.job-item');
  const jobs = Array.from(document.querySelectorAll('.job-item'));
}

function toggleMethod() {
  const method = document.querySelector('input[name="method"]:checked')?.value;
  document.getElementById('pull-options').style.display = method === 'pull' ? 'block' : 'none';
  document.getElementById('backup-options').style.display = method === 'backup' ? 'block' : 'none';
}

function addMapping(source = '', destination = '', enabled = true) {
  const tbody = document.getElementById('mapping-tbody');
  const rowId = 'map-' + Date.now() + Math.random().toString(36).slice(2, 6);
  const tr = document.createElement('tr');
  tr.id = rowId;

  const sourceOptions = SOURCE_PRESETS.map(p =>
    `<option value="${p.value}" ${p.value === source ? 'selected' : ''}>${p.label}</option>`
  ).join('');

  tr.innerHTML = `
    <td>
      <select onchange="handleSourceChange(this, '${rowId}')">
        ${sourceOptions}
      </select>
      <input type="text" class="custom-source" placeholder="/sdcard/..." value="${escHtml(source)}"
        style="${SOURCE_PRESETS.some(p => p.value === source && p.value !== '__custom__') ? 'display:none' : ''}">
    </td>
    <td><input type="text" class="dest-input" placeholder="C:\\Backups\\..." value="${escHtml(destination)}"></td>
    <td><button type="button" class="btn btn-xs btn-outline btn-danger" onclick="document.getElementById('${rowId}').remove()">✕</button></td>
  `;
  tbody.appendChild(tr);
}

function handleSourceChange(sel, rowId) {
  const row = document.getElementById(rowId);
  const customInput = row.querySelector('.custom-source');
  if (sel.value === '__custom__') {
    customInput.style.display = 'block';
    customInput.focus();
  } else {
    customInput.style.display = 'none';
    customInput.value = sel.value;
  }
}

function collectMappings() {
  const rows = document.querySelectorAll('#mapping-tbody tr');
  return Array.from(rows).map(row => {
    const selVal = row.querySelector('select').value;
    const customVal = row.querySelector('.custom-source').value.trim();
    const source = selVal === '__custom__' ? customVal : selVal;
    const dest = row.querySelector('.dest-input').value.trim();
    return { id: row.id || ('m-' + Math.random().toString(36).slice(2)), source, destination: dest, enabled: true };
  }).filter(m => m.source);
}

async function saveJob(e) {
  e.preventDefault();
  const method = document.querySelector('input[name="method"]:checked')?.value || 'pull';
  const payload = {
    name: document.getElementById('job-name').value,
    device_serial: document.getElementById('job-serial').value,
    method,
    mappings: collectMappings(),
    backup_flags: {
      apk: document.getElementById('flag-apk').checked,
      shared: document.getElementById('flag-shared').checked,
      all: document.getElementById('flag-all').checked,
      system: document.getElementById('flag-system').checked,
    },
    backup_output: document.getElementById('backup-output').value,
  };
  const jobId = document.getElementById('job-id').value;
  const url = jobId ? `/api/jobs/${jobId}` : '/api/jobs';
  const method2 = jobId ? 'PUT' : 'POST';
  const saved = await api(url, method2, payload);
  currentJobId = saved.id;
  document.getElementById('job-id').value = saved.id;
  document.getElementById('delete-job-btn').style.display = 'inline-flex';
  loadJobs();
  flashMsg('Job saved!');
}

async function deleteCurrentJob() {
  if (!currentJobId) return;
  if (!confirm('Delete this job?')) return;
  await api(`/api/jobs/${currentJobId}`, 'DELETE');
  currentJobId = null;
  document.getElementById('job-form').style.display = 'none';
  document.getElementById('editor-empty').style.display = 'flex';
  loadJobs();
}

function runJobFromEditor() {
  const jobId = document.getElementById('job-id').value;
  if (!jobId) { alert('Save the job first.'); return; }
  showTab('run');
  setTimeout(() => {
    const sel = document.getElementById('run-job-select');
    if (sel) sel.value = jobId;
  }, 100);
}

// ============================================================ RUN ====

async function populateRunSelects() {
  const jobs = await api('/api/jobs');
  const sel = document.getElementById('run-job-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- choose a job --</option>';
  jobs.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = j.name;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
  populateToolDeviceSelects();
}

function terminalAppend(text, cls = '') {
  const term = document.getElementById('terminal');
  const placeholder = term.querySelector('.terminal-placeholder');
  if (placeholder) placeholder.remove();
  const line = document.createElement('span');
  line.className = 't-line' + (cls ? ' ' + cls : '');
  line.textContent = text;
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
}

function clearTerminal() {
  const term = document.getElementById('terminal');
  term.innerHTML = '<div class="terminal-placeholder">Output will appear here when a backup runs...</div>';
  document.getElementById('run-progress').innerHTML = '';
}

async function startBackup() {
  const jobId = document.getElementById('run-job-select').value;
  if (!jobId) { alert('Select a job first.'); return; }
  if (activeSSE) { activeSSE.close(); activeSSE = null; }

  clearTerminal();
  document.getElementById('run-btn').disabled = true;
  document.getElementById('cancel-btn').style.display = 'inline-flex';

  const data = await api(`/api/run/${jobId}`, 'POST', {});
  if (!data.run_id) {
    terminalAppend('❌ Failed to start job: ' + (data.error || 'unknown error'), 't-err');
    document.getElementById('run-btn').disabled = false;
    document.getElementById('cancel-btn').style.display = 'none';
    return;
  }

  currentRunId = data.run_id;
  const progressEl = document.getElementById('run-progress');
  progressEl.innerHTML = '<div class="progress-bars" id="progress-bars"></div>';

  const es = new EventSource(`/api/stream/${data.run_id}`);
  activeSSE = es;

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.done) {
      es.close(); activeSSE = null;
      document.getElementById('run-btn').disabled = false;
      document.getElementById('cancel-btn').style.display = 'none';
      terminalAppend('', '');
      terminalAppend('✅ Backup complete.', 't-ok');
      return;
    }
    if (msg.type === 'mapping_start') {
      terminalAppend(`▶ ${msg.source}  →  ${msg.dest}`, 't-head');
      addProgressBar(msg.id, msg.source);
    } else if (msg.type === 'line') {
      const text = msg.text || '';
      const isErr = /error|failed|cannot/i.test(text);
      terminalAppend(text, isErr ? 't-err' : '');
      const pct = parsePercent(text);
      if (pct !== null) updateProgressBar(msg.id, pct);
    } else if (msg.type === 'mapping_done') {
      finalizeProgressBar(msg.id, msg.success);
    } else if (msg.type === 'job_done') {
      terminalAppend(``, '');
      terminalAppend(`Job finished.`, 't-ok');
    }
  };

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) return;
    es.close(); activeSSE = null;
    terminalAppend('⚠️ Connection lost.', 't-err');
    document.getElementById('run-btn').disabled = false;
    document.getElementById('cancel-btn').style.display = 'none';
  };
}

function cancelBackup() {
  if (activeSSE) { activeSSE.close(); activeSSE = null; }
  terminalAppend('⛔ Cancelled.', 't-err');
  document.getElementById('run-btn').disabled = false;
  document.getElementById('cancel-btn').style.display = 'none';
}

function parsePercent(line) {
  const m = line.match(/\[\s*(\d+)%\]/);
  return m ? parseInt(m[1]) : null;
}

function addProgressBar(id, label) {
  const container = document.getElementById('progress-bars');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'progress-item';
  div.id = 'pb-' + id;
  div.innerHTML = `<div class="progress-item-label">${escHtml(label)}</div>
    <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:0%"></div></div>`;
  container.appendChild(div);
}

function updateProgressBar(id, pct) {
  const item = document.getElementById('pb-' + id);
  if (item) item.querySelector('.progress-bar-fill').style.width = pct + '%';
}

function finalizeProgressBar(id, success) {
  const item = document.getElementById('pb-' + id);
  if (item) {
    item.classList.add(success ? 'done' : 'error');
    item.querySelector('.progress-bar-fill').style.width = '100%';
  }
}

// ============================================================ TOOLS ==

async function toolScreenshot() {
  setResult('screenshot-result', '⏳ Capturing...', '');
  try {
    const serial = getToolsSerial();
    const resp = await fetch('/api/tools/screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      setResult('screenshot-result', '❌ ' + (err.error || 'Failed'), 'err');
      return;
    }
    const blob = await resp.blob();
    downloadBlob(blob, 'screenshot.png');
    setResult('screenshot-result', '✅ Screenshot downloaded', 'ok');
  } catch (e) {
    setResult('screenshot-result', '❌ ' + e.message, 'err');
  }
}

async function toolRecordStart() {
  const serial = getToolsSerial();
  const duration = parseInt(document.getElementById('rec-duration').value) || 30;
  const data = await api('/api/tools/screenrecord/start', 'POST', { serial, duration });
  if (data.rec_id) {
    currentRecId = data.rec_id;
    document.getElementById('rec-start-btn').disabled = true;
    document.getElementById('rec-stop-btn').disabled = false;
    setResult('rec-result', `⏺ Recording... (max ${data.max_seconds}s)`, 'ok');
  } else {
    setResult('rec-result', '❌ ' + (data.error || 'Failed to start'), 'err');
  }
}

async function toolRecordStop() {
  if (!currentRecId) return;
  setResult('rec-result', '⏳ Stopping and pulling video...', '');
  try {
    const resp = await fetch('/api/tools/screenrecord/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rec_id: currentRecId }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      setResult('rec-result', '❌ ' + (err.error || 'Failed'), 'err');
    } else {
      const blob = await resp.blob();
      downloadBlob(blob, 'screen_recording.mp4');
      setResult('rec-result', '✅ Video downloaded', 'ok');
    }
  } catch (e) {
    setResult('rec-result', '❌ ' + e.message, 'err');
  }
  currentRecId = null;
  document.getElementById('rec-start-btn').disabled = false;
  document.getElementById('rec-stop-btn').disabled = true;
}

async function toolInstallApk() {
  const fileInput = document.getElementById('apk-file');
  if (!fileInput.files.length) { setResult('install-result', '⚠️ Select an APK file first', 'err'); return; }
  setResult('install-result', '⏳ Installing...', '');
  const fd = new FormData();
  fd.append('apk', fileInput.files[0]);
  fd.append('serial', getToolsSerial());
  const resp = await fetch('/api/tools/install', { method: 'POST', body: fd });
  const data = await resp.json();
  setResult('install-result', data.success ? '✅ Installed successfully' : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

async function toolPushFile() {
  const fileInput = document.getElementById('push-file');
  const dest = document.getElementById('push-dest').value.trim() || '/sdcard/Download/';
  if (!fileInput.files.length) { setResult('push-result', '⚠️ Select a file first', 'err'); return; }
  setResult('push-result', '⏳ Pushing...', '');
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  fd.append('dest', dest);
  fd.append('serial', getToolsSerial());
  const resp = await fetch('/api/tools/push', { method: 'POST', body: fd });
  const data = await resp.json();
  setResult('push-result', data.success ? '✅ File pushed' : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

async function toolExtractApk() {
  const pkg = document.getElementById('extract-pkg').value.trim();
  if (!pkg) { setResult('extract-result', '⚠️ Enter a package name', 'err'); return; }
  setResult('extract-result', '⏳ Extracting...', '');
  try {
    const resp = await fetch('/api/tools/extract-apk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial: getToolsSerial(), package: pkg }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      setResult('extract-result', '❌ ' + err.error, 'err');
      return;
    }
    const blob = await resp.blob();
    downloadBlob(blob, pkg + '.apk');
    setResult('extract-result', '✅ APK downloaded', 'ok');
  } catch (e) {
    setResult('extract-result', '❌ ' + e.message, 'err');
  }
}

async function toolClipboard() {
  const text = document.getElementById('clipboard-text').value;
  if (!text) return;
  const data = await api('/api/tools/clipboard', 'POST', { serial: getToolsSerial(), text });
  setResult('clipboard-result', data.success ? '✅ Sent to phone clipboard' : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

async function toolInputText() {
  const text = document.getElementById('input-text-val').value;
  if (!text) return;
  const data = await api('/api/tools/input-text', 'POST', { serial: getToolsSerial(), text });
  setResult('input-text-result', data.success ? '✅ Typed' : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

async function toolKeyEvent(keycode) {
  const data = await api('/api/tools/keyevent', 'POST', { serial: getToolsSerial(), keycode });
  setResult('keyevent-result', data.success ? '✅' : '❌', data.success ? 'ok' : 'err');
}

async function toolReboot(mode) {
  if (!confirm(`Reboot device${mode ? ' into ' + mode : ''}?`)) return;
  const data = await api('/api/tools/reboot', 'POST', { serial: getToolsSerial(), mode });
  setResult('reboot-result', data.success ? '✅ Rebooting...' : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

async function toolBattery() {
  setResult('battery-result', '⏳ Fetching...', '');
  const serial = getToolsSerial();
  const data = await api('/api/tools/battery' + (serial ? `?serial=${encodeURIComponent(serial)}` : ''));
  if (!data.success) { setResult('battery-result', '❌ Failed', 'err'); return; }
  const p = data.parsed || {};
  const fields = [
    ['Level', p.level ? p.level + '%' : null],
    ['Status', { 1: 'Unknown', 2: 'Charging', 3: 'Discharging', 4: 'Not charging', 5: 'Full' }[p.status] || p.status],
    ['Health', { 1: 'Unknown', 2: 'Good', 3: 'Overheat', 4: 'Dead', 5: 'Over voltage', 7: 'Cold' }[p.health] || p.health],
    ['Temperature', p.temperature ? (parseInt(p.temperature) / 10).toFixed(1) + '°C' : null],
    ['Voltage', p.voltage ? (parseInt(p.voltage) / 1000).toFixed(2) + 'V' : null],
    ['AC charged', p['AC powered']],
    ['USB charged', p['USB powered']],
  ].filter(([, v]) => v != null);
  const html = fields.map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`).join('');
  const el = document.getElementById('battery-result');
  el.innerHTML = html;
  el.className = 'result-inline ok';
}

async function toolDeviceInfo() {
  setResult('deviceinfo-result', '⏳ Fetching...', '');
  const serial = getToolsSerial();
  const data = await api('/api/tools/deviceinfo' + (serial ? `?serial=${encodeURIComponent(serial)}` : ''));
  if (!data.success) { setResult('deviceinfo-result', '❌ Failed', 'err'); return; }
  const p = data.props || {};
  const labels = {
    'ro.product.manufacturer': 'Manufacturer',
    'ro.product.model': 'Model',
    'ro.build.version.release': 'Android',
    'ro.build.version.sdk': 'SDK',
    'ro.product.board': 'Board',
    'ro.serialno': 'Serial',
    'ro.product.locale': 'Locale',
    'gsm.network.type': 'Network',
  };
  const html = Object.entries(labels)
    .filter(([k]) => p[k])
    .map(([k, label]) => `<div><strong>${label}:</strong> ${escHtml(p[k])}</div>`)
    .join('');
  const el = document.getElementById('deviceinfo-result');
  el.innerHTML = html || '⚠️ No properties found';
  el.className = 'result-inline' + (html ? ' ok' : '');
}

async function toolStorage() {
  setResult('storage-result', '⏳ Fetching...', '');
  const serial = getToolsSerial();
  const data = await api('/api/tools/storage' + (serial ? `?serial=${encodeURIComponent(serial)}` : ''));
  const el = document.getElementById('storage-result');
  el.innerHTML = `<pre style="font-size:11px;white-space:pre-wrap">${escHtml(data.raw || 'No data')}</pre>`;
  el.className = 'result-inline' + (data.success ? '' : ' err');
}

async function toolDarkMode(enable) {
  const data = await api('/api/tools/darkmode', 'POST', { serial: getToolsSerial(), enable });
  setResult('darkmode-result', data.success ? '✅ Done' : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

async function toolFontScale() {
  const scale = document.getElementById('font-scale').value;
  const data = await api('/api/tools/fontscale', 'POST', { serial: getToolsSerial(), scale: parseFloat(scale) });
  setResult('fontscale-result', data.success ? `✅ Font scale set to ${scale}` : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

async function toolDensity() {
  const dpi = document.getElementById('density-val').value;
  if (!dpi) { setResult('density-result', '⚠️ Enter a DPI value', 'err'); return; }
  const data = await api('/api/tools/density', 'POST', { serial: getToolsSerial(), dpi: parseInt(dpi) });
  setResult('density-result', data.success ? `✅ Density set to ${dpi} dpi` : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

async function toolDensityReset() {
  const data = await api('/api/tools/density', 'POST', { serial: getToolsSerial(), dpi: 'reset' });
  setResult('density-result', data.success ? '✅ Density reset to default' : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

async function toolWipeData() {
  const pkg = document.getElementById('wipe-pkg').value.trim();
  if (!pkg) { setResult('wipe-result', '⚠️ Enter package name', 'err'); return; }
  if (!confirm(`Clear all data for ${pkg}? This cannot be undone.`)) return;
  const data = await api('/api/apps/action', 'POST', { serial: getToolsSerial(), package: pkg, action: 'clear' });
  setResult('wipe-result', data.success ? '✅ Data cleared' : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

// ============================================================ APPS ===

async function loadApps() {
  const serial = document.getElementById('apps-device-select').value;
  const filter = document.getElementById('apps-filter').value;
  document.getElementById('apps-loading').style.display = 'block';
  document.getElementById('apps-table-wrap').style.display = 'none';
  document.getElementById('apps-search').style.display = 'none';

  const data = await api('/api/apps' + `?filter=${filter}${serial ? '&serial=' + encodeURIComponent(serial) : ''}`);
  allPackages = data.packages || [];
  renderAppsTable(allPackages);
  document.getElementById('apps-loading').style.display = 'none';
  document.getElementById('apps-table-wrap').style.display = 'block';
  document.getElementById('apps-search').style.display = 'block';
}

function filterApps() {
  const q = document.getElementById('apps-search').value.toLowerCase();
  const filtered = allPackages.filter(p => p.toLowerCase().includes(q));
  renderAppsTable(filtered);
}

function renderAppsTable(packages) {
  const tbody = document.getElementById('apps-tbody');
  tbody.innerHTML = '';
  if (!packages.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="muted" style="padding:16px">No packages found.</td></tr>';
    return;
  }
  packages.forEach(pkg => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="pkg-name">${escHtml(pkg)}</td>
      <td>
        <div class="app-actions">
          <button class="btn btn-xs btn-outline" onclick="appAction('${escHtml(pkg)}','clear')">Clear Data</button>
          <button class="btn btn-xs btn-outline" onclick="appAction('${escHtml(pkg)}','disable')">Disable</button>
          <button class="btn btn-xs btn-outline" onclick="appAction('${escHtml(pkg)}','enable')">Enable</button>
          <button class="btn btn-xs btn-danger" onclick="appAction('${escHtml(pkg)}','uninstall')">Uninstall</button>
          <button class="btn btn-xs btn-outline" onclick="openGrantModal('${escHtml(pkg)}')">Grant Perm</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function appAction(pkg, action) {
  if (action === 'uninstall' && !confirm(`Uninstall ${pkg} for current user?`)) return;
  const serial = document.getElementById('apps-device-select').value;
  const data = await api('/api/apps/action', 'POST', { serial, package: pkg, action });
  flashMsg(data.success ? `✅ ${action}: ${pkg}` : `❌ ${data.output}`);
}

function openGrantModal(pkg) {
  currentGrantPkg = pkg;
  document.getElementById('grant-pkg-label').textContent = pkg;
  document.getElementById('grant-perm-input').value = '';
  document.getElementById('grant-result').textContent = '';
  document.getElementById('grant-modal').style.display = 'flex';
}

function closeGrantModal() {
  document.getElementById('grant-modal').style.display = 'none';
  currentGrantPkg = null;
}

async function submitGrant() {
  const perm = document.getElementById('grant-perm-input').value.trim();
  if (!perm) return;
  const serial = document.getElementById('apps-device-select').value;
  const data = await api('/api/apps/action', 'POST', { serial, package: currentGrantPkg, action: 'grant', permission: perm });
  setResult('grant-result', data.success ? '✅ Permission granted' : '❌ ' + data.output, data.success ? 'ok' : 'err');
}

// ============================================================ UTILS ==

async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body && method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  return resp.json().catch(() => ({}));
}

function showResultBox(id, ok, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.className = 'result-box ' + (ok ? 'ok' : 'err');
  el.textContent = text;
}

function setResult(id, text, type = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'result-inline' + (type ? ' ' + type : '');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function flashMsg(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1e293b;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.2)';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
