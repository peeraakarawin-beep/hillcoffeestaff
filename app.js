'use strict';
/* ============================================================
   Employee Time Attendance — app.js
   Photo-based check-in/out with timestamp watermark
   Vanilla JS + localStorage only, no dependencies
   ============================================================ */

// ---- STORAGE KEYS ----
const KEY_EMP  = 'att_employees';
const KEY_REC  = 'att_records';

// ---- STATE ----
let employees = [];
let records   = [];
let stream    = null;        // MediaStream
let currentPage = 'scan';
let pendingCapture = null;   // { dataUrl, type, empId, ts }
let historyDays = 7;
let historyFrom = '';
let historyTo   = '';

// ---- STORAGE ----
function loadAll() {
  try { employees = JSON.parse(localStorage.getItem(KEY_EMP)) || []; } catch { employees = []; }
  try { records   = JSON.parse(localStorage.getItem(KEY_REC)) || []; } catch { records = []; }
}
function saveEmp() { localStorage.setItem(KEY_EMP, JSON.stringify(employees)); }
function saveRec() { localStorage.setItem(KEY_REC, JSON.stringify(records)); }

// ---- UTILS ----
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}
function pad(n) { return String(n).padStart(2,'0'); }
function tsToTime(ts) {
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function tsToDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}
function thaiDate(dateStr) {
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
    'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const [y, m, day] = dateStr.split('-').map(Number);
  return `${day} ${months[m-1]} ${y+543}`;
}
function thaiDateFull(d) {
  const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
    'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const now = d || new Date();
  return `วัน${days[now.getDay()]}ที่ ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()+543}`;
}
function getInitials(name) {
  if (!name) return '?';
  const p = name.trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[1][0]) : name[0];
}
function diffHours(inTs, outTs) {
  const ms = outTs - inTs;
  if (ms <= 0) return '-';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}ชม. ${pad(m)}น.`;
}

// ---- CLOCK ----
function startClock() {
  function tick() {
    const now = new Date();
    const timeStr = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    const shortTime = pad(now.getHours()) + ':' + pad(now.getMinutes());
    const el = document.getElementById('clock-time');
    const dateEl = document.getElementById('clock-date');
    const hClock = document.getElementById('header-clock');
    const hDate = document.getElementById('header-date');
    if (el) el.textContent = timeStr;
    if (dateEl) dateEl.textContent = thaiDateFull(now);
    if (hClock) hClock.textContent = shortTime;
    if (hDate) hDate.textContent = thaiDateFull(now);
  }
  tick();
  setInterval(tick, 1000);
}

// ---- TOAST ----
function showToast(msg, type = 'info', dur = 3000) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  t.innerHTML = `<span>${icons[type]||''}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toastOut .3s ease forwards';
    setTimeout(() => t.remove(), 300);
  }, dur);
}

// ---- CAMERA ----
async function startCamera() {
  const video = document.getElementById('camera-video');
  const statusDot = document.querySelector('.cam-status-dot');
  const statusText = document.getElementById('cam-status-text');
  if (statusText) statusText.textContent = 'กำลังเปิดกล้อง...';

  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    if (statusDot) statusDot.className = 'cam-status-dot ready';
    if (statusText) statusText.textContent = 'กล้องพร้อมใช้งาน — กดปุ่มเพื่อถ่ายรูปลงเวลา';
    document.getElementById('btn-checkin').disabled = false;
    document.getElementById('btn-checkout').disabled = false;
  } catch (err) {
    if (statusText) statusText.textContent = 'ไม่สามารถเปิดกล้องได้ — กรุณาอนุญาตการใช้กล้อง';
    showToast('ไม่สามารถเปิดกล้องได้: ' + err.message, 'error', 5000);
  }
}
function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

// ---- PHOTO CAPTURE WITH TIMESTAMP STAMP ----
function captureWithStamp(empName, type) {
  const video = document.getElementById('camera-video');
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');

  // Mirror (flip horizontally to match preview)
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  const now = new Date();
  const dateStr = `${now.getDate()} ${['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'][now.getMonth()]} ${now.getFullYear()+543}`;
  const timeStr = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  const typeLabel = type === 'in' ? '🟢 เข้างาน' : '🔴 ออกงาน';

  // ---- Stamp bar at bottom ----
  const barH = Math.round(canvas.height * 0.14);
  const barY = canvas.height - barH;

  // Semi-transparent dark gradient bar
  const grad = ctx.createLinearGradient(0, barY, 0, canvas.height);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.3, 'rgba(0,0,0,0.75)');
  grad.addColorStop(1, 'rgba(0,0,0,0.88)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, barY - Math.round(barH * 0.5), canvas.width, barH + Math.round(barH * 0.5));

  const baseFontSize = Math.round(canvas.height / 24);
  const smFontSize   = Math.round(canvas.height / 30);

  // Type badge (top-left corner)
  const badgeH = Math.round(canvas.height / 14);
  const badgePad = Math.round(canvas.width / 40);
  ctx.fillStyle = type === 'in' ? 'rgba(22,163,74,0.9)' : 'rgba(220,38,38,0.9)';
  const badgeW = Math.round(canvas.width * 0.26);
  roundRect(ctx, badgePad, badgePad, badgeW, badgeH, 6);
  ctx.fill();

  ctx.fillStyle = 'white';
  ctx.font = `600 ${smFontSize}px Prompt, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(type === 'in' ? '● เข้างาน' : '● ออกงาน', badgePad + 10, badgePad + badgeH / 2);

  // Employee name (bottom bar, left)
  const textY1 = barY + Math.round(barH * 0.18);
  const textY2 = barY + Math.round(barH * 0.6);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  ctx.font = `600 ${baseFontSize}px Prompt, sans-serif`;
  ctx.fillStyle = 'white';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 4;
  ctx.fillText(empName, 14, textY1);

  ctx.font = `400 ${smFontSize}px Prompt, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(dateStr, 14, textY2);

  // Time (bottom bar, right) — large
  const timeFontSize = Math.round(canvas.height / 16);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${timeFontSize}px Prompt, sans-serif`;
  ctx.fillStyle = 'white';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 6;
  ctx.fillText(timeStr, canvas.width - 14, barY + barH * 0.5);

  ctx.shadowBlur = 0;

  return { dataUrl: canvas.toDataURL('image/jpeg', 0.88), ts: now.getTime() };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ---- SCAN ACTIONS ----
function handleScan(type) {
  const sel = document.getElementById('scan-emp-select');
  const empId = sel.value;
  if (!empId) { showToast('กรุณาเลือกพนักงานก่อน', 'warning'); return; }

  const video = document.getElementById('camera-video');
  if (!video.srcObject) { showToast('กล้องยังไม่พร้อม', 'error'); return; }

  const emp = employees.find(e => e.id === empId);
  if (!emp) { showToast('ไม่พบข้อมูลพนักงาน', 'error'); return; }

  const { dataUrl, ts } = captureWithStamp(emp.name, type);

  pendingCapture = { dataUrl, type, empId, empName: emp.name, ts };
  openPreviewModal(emp, type, dataUrl, ts);
}

function openPreviewModal(emp, type, dataUrl, ts) {
  const modal = document.getElementById('modal-preview');
  const title = document.getElementById('preview-title');
  const empInfo = document.getElementById('preview-emp-info');
  const img = document.getElementById('preview-img');
  const tsEl = document.getElementById('preview-timestamp');

  title.textContent = type === 'in' ? '📸 ยืนยันเข้างาน' : '📸 ยืนยันออกงาน';
  empInfo.textContent = `${emp.name}${emp.position ? ' · ' + emp.position : ''}`;
  img.src = dataUrl;
  const d = new Date(ts);
  tsEl.textContent = `${thaiDateFull(d)}  ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} น.`;

  modal.classList.remove('hidden');
}

function confirmSave() {
  if (!pendingCapture) return;
  const { dataUrl, type, empId, empName, ts } = pendingCapture;

  const rec = {
    id: uid(),
    empId,
    empName,
    type,            // 'in' | 'out'
    ts,              // milliseconds
    date: tsToDate(ts),
    photo: dataUrl
  };
  records.push(rec);
  saveRec();

  document.getElementById('modal-preview').classList.add('hidden');
  pendingCapture = null;

  const typeLabel = type === 'in' ? 'เข้างาน' : 'ออกงาน';
  showScanResult(`✅ บันทึก${typeLabel}สำเร็จ — ${empName}  ${tsToTime(ts)}`, 'success');
  renderTodayLog();
  showToast(`บันทึก${typeLabel}สำเร็จ — ${empName}`, 'success');
}

function showScanResult(msg, cls) {
  const el = document.getElementById('scan-result');
  el.textContent = msg;
  el.className = `scan-result ${cls}`;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 5000);
}

// ---- EMPLOYEE SELECT ----
function populateEmpSelect() {
  const sel = document.getElementById('scan-emp-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— เลือกพนักงาน —</option>';
  employees.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = `${e.name}${e.empCode ? ' (' + e.empCode + ')' : ''}`;
    sel.appendChild(opt);
  });
  sel.value = prev || '';
}

// ---- TODAY LOG ----
function renderTodayLog() {
  const wrap = document.getElementById('today-log');
  const today = todayStr();
  const todays = records.filter(r => r.date === today)
    .sort((a,b) => b.ts - a.ts);

  if (!todays.length) {
    wrap.innerHTML = '<div class="empty-state">ยังไม่มีการลงเวลาวันนี้</div>';
    return;
  }
  wrap.innerHTML = todays.map(r => `
    <div class="log-item" onclick="viewPhoto('${r.id}')">
      <img src="${r.photo}" class="log-thumb" alt="" />
      <div class="log-info">
        <div class="log-name">${r.empName}</div>
        <div class="log-time">${tsToTime(r.ts)}</div>
      </div>
      <span class="log-badge ${r.type}">${r.type === 'in' ? 'เข้างาน' : 'ออกงาน'}</span>
    </div>
  `).join('');
}

// ---- VIEW PHOTO ----
function viewPhoto(recId) {
  const r = records.find(x => x.id === recId);
  if (!r) return;
  const modal = document.getElementById('modal-view-photo');
  document.getElementById('view-photo-title').textContent =
    `${r.empName} — ${r.type === 'in' ? 'เข้างาน' : 'ออกงาน'}`;
  document.getElementById('view-photo-img').src = r.photo;
  const d = new Date(r.ts);
  document.getElementById('view-photo-info').textContent =
    `${thaiDateFull(d)}  ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} น.`;
  modal.classList.remove('hidden');
}
window.viewPhoto = viewPhoto;

// ---- EMPLOYEES PAGE ----
function renderEmployees(filter = '') {
  const wrap = document.getElementById('emp-list');
  const q = filter.toLowerCase();
  const list = employees.filter(e =>
    e.name.toLowerCase().includes(q) ||
    (e.position||'').toLowerCase().includes(q) ||
    (e.empCode||'').toLowerCase().includes(q)
  );
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:40px 0;text-align:center;color:var(--text-light)">ไม่มีข้อมูลพนักงาน<br><small>กดปุ่ม + เพิ่มพนักงาน</small></div>';
    return;
  }
  wrap.innerHTML = list.map(e => `
    <div class="emp-card">
      <div class="emp-avatar">${getInitials(e.name)}</div>
      <div class="emp-info">
        <div class="emp-name">${e.name}</div>
        <div class="emp-meta">${[e.position, e.dept, e.empCode].filter(Boolean).join(' · ') || '—'}</div>
      </div>
      <div class="emp-actions">
        <button class="icon-btn" title="แก้ไข" onclick="editEmp('${e.id}')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="icon-btn danger" title="ลบ" onclick="deleteEmp('${e.id}')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}
window.editEmp = function(id) {
  const e = employees.find(x => x.id === id);
  if (!e) return;
  document.getElementById('emp-id').value = e.id;
  document.getElementById('emp-name').value = e.name;
  document.getElementById('emp-position').value = e.position || '';
  document.getElementById('emp-code').value = e.empCode || '';
  document.getElementById('emp-dept').value = e.dept || '';
  document.getElementById('modal-emp-title').textContent = 'แก้ไขพนักงาน';
  document.getElementById('modal-emp').classList.remove('hidden');
};
window.deleteEmp = function(id) {
  const e = employees.find(x => x.id === id);
  if (!e) return;
  if (!confirm(`ลบพนักงาน "${e.name}" ใช่หรือไม่?\n(ประวัติการลงเวลาจะยังคงอยู่)`)) return;
  employees = employees.filter(x => x.id !== id);
  saveEmp();
  renderEmployees(document.getElementById('emp-search').value);
  populateEmpSelect();
  showToast('ลบพนักงานแล้ว', 'info');
};

function saveEmployee() {
  const id  = document.getElementById('emp-id').value;
  const name = document.getElementById('emp-name').value.trim();
  if (!name) { showToast('กรุณากรอกชื่อพนักงาน', 'warning'); return; }
  const data = {
    id: id || uid(),
    name,
    position: document.getElementById('emp-position').value.trim(),
    empCode: document.getElementById('emp-code').value.trim(),
    dept: document.getElementById('emp-dept').value.trim(),
    createdAt: id ? (employees.find(e => e.id===id)?.createdAt || Date.now()) : Date.now()
  };
  if (id) {
    employees = employees.map(e => e.id === id ? data : e);
  } else {
    employees.push(data);
  }
  saveEmp();
  document.getElementById('modal-emp').classList.add('hidden');
  renderEmployees(document.getElementById('emp-search').value);
  populateEmpSelect();
  showToast(id ? 'แก้ไขข้อมูลแล้ว' : 'เพิ่มพนักงานแล้ว', 'success');
}

// ---- HISTORY PAGE ----
function renderHistory() {
  let from, to;
  const today = new Date(); today.setHours(23,59,59,999);
  if (historyDays > 0) {
    to = today.getTime();
    const f = new Date(); f.setDate(f.getDate() - (historyDays - 1)); f.setHours(0,0,0,0);
    from = f.getTime();
  } else {
    if (!historyFrom || !historyTo) {
      document.getElementById('history-table-wrap').innerHTML =
        '<div class="empty-state" style="padding:20px">กรุณาเลือกช่วงวันที่</div>';
      return;
    }
    from = new Date(historyFrom + 'T00:00:00').getTime();
    to   = new Date(historyTo   + 'T23:59:59').getTime();
  }

  const filtered = records.filter(r => r.ts >= from && r.ts <= to);

  // Stats
  const empSet = new Set(filtered.map(r => r.empId));
  const daySet = new Set(filtered.map(r => r.date));
  let totalMs = 0;
  // pair in/out per emp per day
  employees.forEach(emp => {
    const empRecs = filtered.filter(r => r.empId === emp.id);
    const days = [...new Set(empRecs.map(r => r.date))];
    days.forEach(d => {
      const ins  = empRecs.filter(r => r.date === d && r.type === 'in').sort((a,b) => a.ts-b.ts);
      const outs = empRecs.filter(r => r.date === d && r.type === 'out').sort((a,b) => a.ts-b.ts);
      if (ins.length && outs.length) {
        totalMs += Math.max(0, outs[outs.length-1].ts - ins[0].ts);
      }
    });
  });
  const totalH = Math.floor(totalMs / 3600000);
  const totalM = Math.floor((totalMs % 3600000) / 60000);

  document.getElementById('stats-row').innerHTML = `
    <div class="stat-card"><div class="stat-num">${empSet.size}</div><div class="stat-label">พนักงาน</div></div>
    <div class="stat-card"><div class="stat-num">${daySet.size}</div><div class="stat-label">วันที่มีบันทึก</div></div>
    <div class="stat-card"><div class="stat-num">${totalH}<small style="font-size:14px">ชม.</small></div><div class="stat-label">ชม.ทำงานรวม</div></div>
  `;

  // Build table rows: group by emp then date
  const rows = [];
  const sortedEmps = [...employees].sort((a,b) => a.name.localeCompare(b.name,'th'));

  sortedEmps.forEach(emp => {
    const empRecs = filtered.filter(r => r.empId === emp.id);
    if (!empRecs.length) return;
    const days = [...new Set(empRecs.map(r => r.date))].sort();
    days.forEach(d => {
      const dayRecs = empRecs.filter(r => r.date === d);
      const ins  = dayRecs.filter(r => r.type === 'in').sort((a,b) => a.ts-b.ts);
      const outs = dayRecs.filter(r => r.type === 'out').sort((a,b) => a.ts-b.ts);
      const inRec  = ins[0];
      const outRec = outs[outs.length-1];
      const hrs = (inRec && outRec) ? diffHours(inRec.ts, outRec.ts) : '—';
      rows.push({ emp, date: d, inRec, outRec, hrs });
    });
  });

  if (!rows.length) {
    document.getElementById('history-table-wrap').innerHTML =
      '<div class="empty-state" style="padding:30px">ไม่มีข้อมูลในช่วงที่เลือก</div>';
    return;
  }

  document.getElementById('history-table-wrap').innerHTML = `
    <table class="att-table">
      <thead>
        <tr>
          <th>พนักงาน</th>
          <th>วันที่</th>
          <th>เข้างาน</th>
          <th>ออกงาน</th>
          <th>ชม.</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${r.emp.name}</td>
            <td style="white-space:nowrap">${thaiDate(r.date)}</td>
            <td class="time-in">
              ${r.inRec
                ? `${tsToTime(r.inRec.ts)}<br><img src="${r.inRec.photo}" class="photo-thumb" onclick="viewPhoto('${r.inRec.id}')" title="ดูรูป" />`
                : '—'}
            </td>
            <td class="time-out">
              ${r.outRec
                ? `${tsToTime(r.outRec.ts)}<br><img src="${r.outRec.photo}" class="photo-thumb" onclick="viewPhoto('${r.outRec.id}')" title="ดูรูป" />`
                : '—'}
            </td>
            <td class="hours-cell">${r.hrs}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// ---- EXPORT CSV ----
function exportCSV() {
  const BOM = '\uFEFF';
  const header = ['ชื่อพนักงาน','รหัสพนักงาน','ตำแหน่ง','วันที่','เวลาเข้างาน','เวลาออกงาน','ชม.ทำงาน'];
  const lines = [header.join(',')];

  const empMap = {};
  employees.forEach(e => empMap[e.id] = e);

  // group
  const grouped = {};
  records.forEach(r => {
    const key = r.empId + '_' + r.date;
    if (!grouped[key]) grouped[key] = { empId: r.empId, date: r.date, ins: [], outs: [] };
    if (r.type === 'in') grouped[key].ins.push(r);
    else grouped[key].outs.push(r);
  });

  Object.values(grouped).sort((a,b) => a.date.localeCompare(b.date)).forEach(g => {
    const emp = empMap[g.empId] || { name: g.empId, empCode:'', position:'' };
    const ins  = g.ins.sort((a,b)=>a.ts-b.ts);
    const outs = g.outs.sort((a,b)=>a.ts-b.ts);
    const inTime  = ins[0]  ? tsToTime(ins[0].ts)  : '';
    const outTime = outs[outs.length-1] ? tsToTime(outs[outs.length-1].ts) : '';
    const hrs = (ins[0] && outs.length) ? diffHours(ins[0].ts, outs[outs.length-1].ts) : '';
    lines.push([
      `"${emp.name}"`, `"${emp.empCode||''}"`, `"${emp.position||''}"`,
      `"${thaiDate(g.date)}"`, inTime, outTime, `"${hrs}"`
    ].join(','));
  });

  const blob = new Blob([BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `attendance_${todayStr()}.csv`;
  a.click();
  showToast('Export CSV สำเร็จ', 'success');
}

// ---- NAVIGATION ----
function goPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelector(`.nav-btn[data-page="${page}"]`).classList.add('active');
  currentPage = page;

  if (page === 'scan') {
    startCamera();
    renderTodayLog();
    populateEmpSelect();
  } else {
    stopCamera();
    if (page === 'employees') renderEmployees(document.getElementById('emp-search').value);
    if (page === 'history')   renderHistory();
  }
}

// ---- INIT ----
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  startClock();
  startCamera();
  populateEmpSelect();
  renderTodayLog();

  // Nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => goPage(btn.dataset.page));
  });

  // Scan buttons
  document.getElementById('btn-checkin').addEventListener('click', () => handleScan('in'));
  document.getElementById('btn-checkout').addEventListener('click', () => handleScan('out'));

  // Preview modal
  document.getElementById('modal-preview-close').addEventListener('click', () => {
    document.getElementById('modal-preview').classList.add('hidden');
    pendingCapture = null;
  });
  document.getElementById('btn-retake').addEventListener('click', () => {
    document.getElementById('modal-preview').classList.add('hidden');
    pendingCapture = null;
  });
  document.getElementById('btn-confirm-save').addEventListener('click', confirmSave);

  // View photo modal
  document.getElementById('modal-view-photo-close').addEventListener('click', () => {
    document.getElementById('modal-view-photo').classList.add('hidden');
  });

  // Add employee
  document.getElementById('btn-add-emp').addEventListener('click', () => {
    document.getElementById('emp-id').value = '';
    document.getElementById('emp-name').value = '';
    document.getElementById('emp-position').value = '';
    document.getElementById('emp-code').value = '';
    document.getElementById('emp-dept').value = '';
    document.getElementById('modal-emp-title').textContent = 'เพิ่มพนักงาน';
    document.getElementById('modal-emp').classList.remove('hidden');
  });
  document.getElementById('modal-emp-close').addEventListener('click', () =>
    document.getElementById('modal-emp').classList.add('hidden'));
  document.getElementById('modal-emp-cancel').addEventListener('click', () =>
    document.getElementById('modal-emp').classList.add('hidden'));
  document.getElementById('modal-emp-save').addEventListener('click', saveEmployee);

  // Employee search
  document.getElementById('emp-search').addEventListener('input', e =>
    renderEmployees(e.target.value));

  // History filter chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      historyDays = parseInt(chip.dataset.days, 10);
      const rangeWrap = document.getElementById('date-range-wrap');
      if (historyDays === 0) {
        rangeWrap.classList.remove('hidden');
      } else {
        rangeWrap.classList.add('hidden');
        renderHistory();
      }
    });
  });

  document.getElementById('btn-apply-range').addEventListener('click', () => {
    historyFrom = document.getElementById('range-from').value;
    historyTo   = document.getElementById('range-to').value;
    if (!historyFrom || !historyTo) { showToast('กรุณาเลือกช่วงวันที่', 'warning'); return; }
    renderHistory();
  });

  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);

  // Backdrop close
  document.querySelectorAll('.modal-backdrop').forEach(bd => {
    bd.addEventListener('click', e => {
      if (e.target === bd) {
        bd.classList.add('hidden');
        if (bd.id === 'modal-preview') pendingCapture = null;
      }
    });
  });
});
