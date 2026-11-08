/* ============================================================
   Employee Time Attendance System — app.js
   Vanilla JS, face-api.js, localStorage
   ============================================================ */

'use strict';

// ============================================================
// CONSTANTS & CONFIG
// ============================================================
const MODELS_URL = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights';
const THRESHOLD = 0.45;       // Face recognition distance threshold
const COOLDOWN_MS = 60000;    // 1 minute cooldown between scans
const CAPTURE_COUNT = 5;      // Number of captures for registration

const STORAGE_KEYS = {
  employees: 'att_employees',
  records: 'att_records',
  settings: 'att_settings',
};

// ============================================================
// STATE
// ============================================================
let modelsLoaded = false;
let scanStream = null;         // MediaStream for scan tab
let regStream = null;          // MediaStream for face registration
let currentPage = 'scan';
let registeringEmpId = null;
let captureCount = 0;
let capturedDescriptors = [];
let scanCooldowns = {};        // empId → timestamp of last scan
let dateRangeDays = 7;
let scanProcessing = false;

// ============================================================
// STORAGE HELPERS
// ============================================================
function loadData(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch { return []; }
}
function saveData(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}
function getEmployees() { return loadData(STORAGE_KEYS.employees); }
function getRecords() { return loadData(STORAGE_KEYS.records); }
function saveEmployees(data) { saveData(STORAGE_KEYS.employees, data); }
function saveRecords(data) { saveData(STORAGE_KEYS.records, data); }

// ============================================================
// UTILITY HELPERS
// ============================================================
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function formatTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0');
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('th-TH', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

function thaiDateTime(date) {
  const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
    'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const d = date || new Date();
  const buddhistYear = d.getFullYear() + 543;
  return `วัน${days[d.getDay()]}ที่ ${d.getDate()} ${months[d.getMonth()]} ${buddhistYear}`;
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return parts[0][0] + parts[1][0];
  return name[0];
}

// ============================================================
// CLOCK
// ============================================================
function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const timeStr = `${hh}:${mm}:${ss}`;
  const shortTime = `${hh}:${mm}`;

  const clockEl = document.getElementById('clock-time');
  const clockDateEl = document.getElementById('clock-date');
  const headerTime = document.getElementById('current-time-header');

  if (clockEl) clockEl.textContent = timeStr;
  if (clockDateEl) clockDateEl.textContent = thaiDateTime(now);
  if (headerTime) headerTime.textContent = shortTime;
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(msg, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:#10b981;flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:#ef4444;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:#f59e0b;flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:#3b82f6;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };

  toast.innerHTML = `${icons[type] || icons.info}<span>${msg}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================================================
// MODAL HELPERS
// ============================================================
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.body.style.overflow = '';
}
function closeModalOnBackdrop(event, id) {
  if (event.target === event.currentTarget) closeModal(id);
}

// ============================================================
// PAGE NAVIGATION
// ============================================================
function switchPage(pageName, navBtn) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));

  // Show target page
  document.getElementById('page-' + pageName).classList.add('active');
  if (navBtn) navBtn.classList.add('active');

  currentPage = pageName;

  if (pageName === 'scan') {
    startScanCamera();
    renderTodayRecords();
  } else {
    stopScanCamera();
    if (pageName === 'employees') renderEmployeeList();
    if (pageName === 'reports') {
      renderReport();
      populateReportEmpFilter();
    }
  }
}

// ============================================================
// CAMERA MANAGEMENT
// ============================================================
async function startScanCamera() {
  const video = document.getElementById('scan-video');
  if (scanStream) {
    video.srcObject = scanStream;
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    video.srcObject = scanStream;
    setScanStatus('กล้องพร้อมใช้งาน', 'active');
  } catch (err) {
    console.error('Camera error:', err);
    setScanStatus('ไม่สามารถเข้าถึงกล้องได้', 'error');
    showToast('ไม่สามารถเข้าถึงกล้องได้ กรุณาอนุญาตการใช้งานกล้อง', 'error');
  }
}

function stopScanCamera() {
  if (scanStream) {
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  }
}

async function startRegCamera() {
  const video = document.getElementById('reg-video');
  try {
    regStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    video.srcObject = regStream;
  } catch (err) {
    console.error('Reg camera error:', err);
    showToast('ไม่สามารถเข้าถึงกล้องได้', 'error');
    closeModal('modal-face-reg');
  }
}

function stopRegCamera() {
  if (regStream) {
    regStream.getTracks().forEach(t => t.stop());
    regStream = null;
  }
}

function setScanStatus(text, state) {
  const dot = document.querySelector('#camera-status .status-dot');
  const textEl = document.getElementById('camera-status-text');
  if (dot) {
    dot.className = 'status-dot ' + state;
  }
  if (textEl) textEl.textContent = text;
}

// ============================================================
// FACE API LOADING
// ============================================================
async function loadFaceModels() {
  setLoadingStatus('กำลังโหลด Face Recognition Models...', 20);

  try {
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL),
    ]);
    modelsLoaded = true;
    setLoadingStatus('โหลด Models สำเร็จ!', 100);
    return true;
  } catch (err) {
    console.error('Model load error:', err);
    setLoadingStatus('โหลด Models ไม่สำเร็จ — กรุณาเชื่อมต่ออินเทอร์เน็ต', 0);
    document.getElementById('loading-hint').textContent =
      'ระบบต้องการอินเทอร์เน็ตเพื่อโหลด Face AI Models ครั้งแรก';
    return false;
  }
}

function setLoadingStatus(text, progress) {
  const statusEl = document.getElementById('loading-status');
  const barEl = document.getElementById('loading-bar-fill');
  if (statusEl) statusEl.textContent = text;
  if (barEl) barEl.style.width = progress + '%';
}

// ============================================================
// FACE RECOGNITION — SCAN
// ============================================================
async function handleScan(type) {
  if (!modelsLoaded) {
    showToast('กำลังโหลด Face Models กรุณารอสักครู่...', 'warning');
    return;
  }
  if (scanProcessing) return;

  const employees = getEmployees().filter(e => e.descriptor && e.descriptor.length > 0);
  if (employees.length === 0) {
    showToast('ยังไม่มีพนักงานที่ลงทะเบียนใบหน้า', 'warning');
    return;
  }

  const video = document.getElementById('scan-video');
  const canvas = document.getElementById('scan-canvas');
  const wrapper = document.querySelector('.camera-section .camera-wrapper');

  if (!video.srcObject) {
    showToast('กรุณาเปิดกล้องก่อน', 'warning');
    return;
  }

  scanProcessing = true;
  wrapper.classList.add('scanning');
  setScanStatus('กำลังสแกนใบหน้า...', 'scanning');

  // Disable buttons
  document.getElementById('btn-scan-in').disabled = true;
  document.getElementById('btn-scan-out').disabled = true;

  try {
    const displaySize = { width: video.videoWidth, height: video.videoHeight };
    if (displaySize.width === 0) {
      showToast('กล้องยังไม่พร้อม กรุณารอสักครู่', 'warning');
      return;
    }

    faceapi.matchDimensions(canvas, displaySize);

    const detectionResult = await faceapi
      .detectSingleFace(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detectionResult) {
      showToast('ไม่พบใบหน้าในกรอบ กรุณาจัดวางใบหน้าให้อยู่ในกรอบ', 'warning');
      setScanStatus('ไม่พบใบหน้า', 'idle');
      return;
    }

    // Draw detection
    const resized = faceapi.resizeResults(detectionResult, displaySize);
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    faceapi.draw.drawFaceLandmarks(canvas, resized);

    // Compare against all employees
    const descriptor = detectionResult.descriptor;
    let bestMatch = null;
    let bestDistance = Infinity;

    for (const emp of employees) {
      const empDescriptor = new Float32Array(emp.descriptor);
      const distance = faceapi.euclideanDistance(descriptor, empDescriptor);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = emp;
      }
    }

    if (bestDistance <= THRESHOLD && bestMatch) {
      // Check cooldown
      const now = Date.now();
      const lastScan = scanCooldowns[bestMatch.id + '_' + type];
      if (lastScan && now - lastScan < COOLDOWN_MS) {
        const waitSec = Math.ceil((COOLDOWN_MS - (now - lastScan)) / 1000);
        showToast(`${bestMatch.name} ได้สแกน${type === 'in' ? 'เข้า' : 'ออก'}แล้ว กรุณารออีก ${waitSec} วินาที`, 'warning');
        setScanStatus('ต้องรอก่อนสแกนอีกครั้ง', 'idle');
        return;
      }

      // Record scan
      const record = {
        id: uid(),
        empId: bestMatch.id,
        empName: bestMatch.name,
        empPosition: bestMatch.position || '',
        empPhoto: bestMatch.photoData || null,
        type: type,
        timestamp: new Date().toISOString(),
        date: todayStr(),
      };

      const records = getRecords();
      records.push(record);
      saveRecords(records);
      scanCooldowns[bestMatch.id + '_' + type] = now;

      // Show success overlay
      showFaceResultOverlay(
        bestMatch,
        type === 'in' ? '✓ เข้างานสำเร็จ' : '✓ ออกงานสำเร็จ',
        formatTime(now),
        type
      );

      showToast(
        `${bestMatch.name} ${type === 'in' ? 'เข้างาน' : 'ออกงาน'} ${formatTime(now)}`,
        'success', 4000
      );
      setScanStatus(`สแกน${type === 'in' ? 'เข้า' : 'ออก'}งาน: ${bestMatch.name}`, 'active');
      renderTodayRecords();

    } else {
      showToast(`ไม่พบใบหน้าที่ตรงกัน (ระยะห่าง: ${bestDistance.toFixed(2)})`, 'error');
      setScanStatus('ไม่พบใบหน้าที่ตรงกัน', 'idle');
    }

  } catch (err) {
    console.error('Scan error:', err);
    showToast('เกิดข้อผิดพลาดในการสแกน: ' + err.message, 'error');
    setScanStatus('เกิดข้อผิดพลาด', 'error');
  } finally {
    scanProcessing = false;
    wrapper.classList.remove('scanning');
    document.getElementById('btn-scan-in').disabled = false;
    document.getElementById('btn-scan-out').disabled = false;
    setTimeout(() => {
      const canvas = document.getElementById('scan-canvas');
      if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      hideFaceResultOverlay();
      if (currentPage === 'scan') setScanStatus('กล้องพร้อมใช้งาน', 'active');
    }, 3000);
  }
}

function showFaceResultOverlay(emp, status, time, type) {
  const overlay = document.getElementById('face-result-overlay');
  overlay.className = `face-result-overlay ${type === 'in' ? 'success' : ''}`;
  overlay.innerHTML = `
    <div style="font-size:2.5rem;">${type === 'in' ? '✅' : '🚪'}</div>
    <div class="face-result-name">${emp.name}</div>
    <div class="face-result-time">${time}</div>
    <div class="face-result-status">${status}</div>
  `;
  overlay.classList.remove('hidden');
}

function hideFaceResultOverlay() {
  const overlay = document.getElementById('face-result-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// ============================================================
// FACE REGISTRATION
// ============================================================
function openFaceRegModal(empId) {
  const employees = getEmployees();
  const emp = employees.find(e => e.id === empId);
  if (!emp) return;

  registeringEmpId = empId;
  captureCount = 0;
  capturedDescriptors = [];

  // Reset UI
  for (let i = 0; i < 5; i++) {
    const dot = document.getElementById('dot-' + i);
    if (dot) dot.className = 'capture-dot';
  }
  document.getElementById('reg-status-text').textContent =
    'จัดวางใบหน้าในกรอบ แล้วกดปุ่มจับภาพ';
  document.getElementById('btn-capture').innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
    </svg>
    จับภาพ (0/5)
  `;
  document.getElementById('btn-capture').disabled = false;

  // Fill employee info
  document.getElementById('face-reg-emp-info').innerHTML = `
    <div class="emp-avatar" style="width:40px;height:40px;font-size:1rem;">
      ${emp.photoData
        ? `<img src="${emp.photoData}" alt="${emp.name}" />`
        : `<span>${getInitials(emp.name)}</span>`}
    </div>
    <div>
      <div class="emp-name">${emp.name}</div>
      <div style="font-size:0.75rem;color:var(--text-secondary);">${emp.position || ''} · ${emp.empNo || ''}</div>
    </div>
  `;

  openModal('modal-face-reg');
  startRegCamera();
}

async function captureForRegistration() {
  if (!modelsLoaded) {
    showToast('Face Models ยังโหลดไม่เสร็จ', 'warning');
    return;
  }
  if (captureCount >= CAPTURE_COUNT) return;

  const video = document.getElementById('reg-video');
  const dot = document.getElementById('dot-' + captureCount);

  if (dot) dot.className = 'capture-dot capturing';
  document.getElementById('reg-status-text').textContent = 'กำลังจับภาพ...';
  document.getElementById('btn-capture').disabled = true;

  try {
    const result = await faceapi
      .detectSingleFace(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!result) {
      if (dot) dot.className = 'capture-dot';
      document.getElementById('reg-status-text').textContent = 'ไม่พบใบหน้า กรุณาลองใหม่';
      showToast('ไม่พบใบหน้าในกรอบ', 'warning');
      document.getElementById('btn-capture').disabled = false;
      return;
    }

    capturedDescriptors.push(Array.from(result.descriptor));
    if (dot) dot.className = 'capture-dot captured';
    captureCount++;

    // Capture photo for display on first capture
    if (captureCount === 1) {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = video.videoWidth;
      tempCanvas.height = video.videoHeight;
      const ctx = tempCanvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      // Store temporarily
      window._regPhotoData = tempCanvas.toDataURL('image/jpeg', 0.7);
    }

    if (captureCount < CAPTURE_COUNT) {
      document.getElementById('reg-status-text').textContent =
        `จับภาพที่ ${captureCount} สำเร็จ กรุณาขยับหน้าเล็กน้อยแล้วจับภาพต่อไป`;
      document.getElementById('btn-capture').innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
        </svg>
        จับภาพ (${captureCount}/5)
      `;
      document.getElementById('btn-capture').disabled = false;
    } else {
      // All captures done — compute average descriptor
      document.getElementById('reg-status-text').textContent = 'กำลังประมวลผล...';
      await finishRegistration();
    }

  } catch (err) {
    console.error('Capture error:', err);
    showToast('เกิดข้อผิดพลาดในการจับภาพ', 'error');
    if (dot) dot.className = 'capture-dot';
    document.getElementById('btn-capture').disabled = false;
  }
}

async function finishRegistration() {
  // Average all descriptors
  const len = capturedDescriptors[0].length;
  const avgDescriptor = new Array(len).fill(0);
  for (const desc of capturedDescriptors) {
    for (let i = 0; i < len; i++) avgDescriptor[i] += desc[i];
  }
  for (let i = 0; i < len; i++) avgDescriptor[i] /= capturedDescriptors.length;

  // Save to employee
  const employees = getEmployees();
  const idx = employees.findIndex(e => e.id === registeringEmpId);
  if (idx !== -1) {
    employees[idx].descriptor = avgDescriptor;
    if (window._regPhotoData) {
      employees[idx].photoData = window._regPhotoData;
      window._regPhotoData = null;
    }
    saveEmployees(employees);
  }

  document.getElementById('reg-status-text').textContent = '✅ ลงทะเบียนใบหน้าสำเร็จ!';
  showToast('ลงทะเบียนใบหน้าสำเร็จ!', 'success');

  setTimeout(() => {
    closeFaceRegModal();
    renderEmployeeList();
  }, 1200);
}

function closeFaceRegModal() {
  stopRegCamera();
  registeringEmpId = null;
  captureCount = 0;
  capturedDescriptors = [];
  window._regPhotoData = null;
  closeModal('modal-face-reg');
}

// ============================================================
// EMPLOYEE MANAGEMENT
// ============================================================
function openAddEmployeeModal() {
  document.getElementById('modal-emp-title').textContent = 'เพิ่มพนักงาน';
  document.getElementById('emp-id').value = '';
  document.getElementById('emp-no').value = '';
  document.getElementById('emp-name').value = '';
  document.getElementById('emp-position').value = '';
  openModal('modal-employee');
}

function openEditEmployeeModal(empId) {
  const emp = getEmployees().find(e => e.id === empId);
  if (!emp) return;
  document.getElementById('modal-emp-title').textContent = 'แก้ไขข้อมูลพนักงาน';
  document.getElementById('emp-id').value = emp.id;
  document.getElementById('emp-no').value = emp.empNo || '';
  document.getElementById('emp-name').value = emp.name || '';
  document.getElementById('emp-position').value = emp.position || '';
  openModal('modal-employee');
}

function saveEmployee() {
  const id = document.getElementById('emp-id').value;
  const empNo = document.getElementById('emp-no').value.trim();
  const name = document.getElementById('emp-name').value.trim();
  const position = document.getElementById('emp-position').value.trim();

  if (!name) { showToast('กรุณากรอกชื่อพนักงาน', 'error'); return; }
  if (!empNo) { showToast('กรุณากรอกเลขพนักงาน', 'error'); return; }

  const employees = getEmployees();

  if (id) {
    // Edit
    const idx = employees.findIndex(e => e.id === id);
    if (idx !== -1) {
      employees[idx] = { ...employees[idx], empNo, name, position };
      saveEmployees(employees);
      showToast('แก้ไขข้อมูลพนักงานสำเร็จ', 'success');
    }
  } else {
    // Add
    const existing = employees.find(e => e.empNo === empNo);
    if (existing) { showToast('เลขพนักงานนี้มีอยู่แล้ว', 'error'); return; }
    employees.push({
      id: uid(), empNo, name, position,
      descriptor: [],
      photoData: null,
      createdAt: new Date().toISOString(),
    });
    saveEmployees(employees);
    showToast('เพิ่มพนักงานสำเร็จ', 'success');
  }

  closeModal('modal-employee');
  renderEmployeeList();
}

function confirmDeleteEmployee(empId) {
  const emp = getEmployees().find(e => e.id === empId);
  if (!emp) return;
  document.getElementById('confirm-message').textContent =
    `คุณต้องการลบ "${emp.name}" ออกจากระบบหรือไม่? ข้อมูลทั้งหมดจะถูกลบถาวร`;
  document.getElementById('btn-confirm-action').onclick = () => deleteEmployee(empId);
  openModal('modal-confirm');
}

function deleteEmployee(empId) {
  const employees = getEmployees().filter(e => e.id !== empId);
  saveEmployees(employees);

  // Also delete records
  const records = getRecords().filter(r => r.empId !== empId);
  saveRecords(records);

  closeModal('modal-confirm');
  renderEmployeeList();
  showToast('ลบพนักงานสำเร็จ', 'success');
}

// ============================================================
// RENDER EMPLOYEE LIST
// ============================================================
function renderEmployeeList() {
  const container = document.getElementById('employee-list');
  const search = document.getElementById('emp-search').value.toLowerCase();
  let employees = getEmployees();

  if (search) {
    employees = employees.filter(e =>
      e.name.toLowerCase().includes(search) ||
      (e.empNo || '').toLowerCase().includes(search) ||
      (e.position || '').toLowerCase().includes(search)
    );
  }

  if (employees.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <p>${search ? 'ไม่พบพนักงานที่ค้นหา' : 'ยังไม่มีพนักงาน'}</p>
        ${!search ? '<button class="btn btn-primary btn-sm" onclick="openAddEmployeeModal()">เพิ่มพนักงานคนแรก</button>' : ''}
      </div>`;
    return;
  }

  container.innerHTML = employees.map(emp => {
    const hasDescriptor = emp.descriptor && emp.descriptor.length > 0;
    return `
    <div class="employee-card">
      <div class="emp-avatar">
        ${emp.photoData
          ? `<img src="${emp.photoData}" alt="${emp.name}" />`
          : `<span>${getInitials(emp.name)}</span>`}
      </div>
      <div class="emp-info">
        <div class="emp-name">${emp.name}</div>
        <div class="emp-meta">${emp.position || 'ไม่ระบุตำแหน่ง'} · ${emp.empNo || ''}</div>
        <span class="emp-face-badge ${hasDescriptor ? 'registered' : 'not-registered'}">
          ${hasDescriptor ? '✓ ลงทะเบียนแล้ว' : '✗ ยังไม่ลงทะเบียนหน้า'}
        </span>
      </div>
      <div class="emp-actions">
        <button class="btn-face-reg" onclick="openFaceRegModal('${emp.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          ${hasDescriptor ? 'อัปเดตหน้า' : 'ลงทะเบียนหน้า'}
        </button>
        <button class="btn-edit-emp" onclick="openEditEmployeeModal('${emp.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          แก้ไข
        </button>
        <button class="btn-delete-emp" onclick="confirmDeleteEmployee('${emp.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
          ลบ
        </button>
      </div>
    </div>`;
  }).join('');
}

// ============================================================
// RENDER TODAY RECORDS
// ============================================================
function renderTodayRecords() {
  const container = document.getElementById('today-list');
  const countEl = document.getElementById('today-count');
  const today = todayStr();
  const records = getRecords()
    .filter(r => r.date === today)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  countEl.textContent = records.length + ' รายการ';

  if (records.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <p>ยังไม่มีการบันทึกวันนี้</p>
      </div>`;
    return;
  }

  container.innerHTML = records.map(r => `
    <div class="record-item">
      <div class="record-avatar">
        ${r.empPhoto
          ? `<img src="${r.empPhoto}" alt="${r.empName}" />`
          : `<span>${getInitials(r.empName)}</span>`}
      </div>
      <div class="record-info">
        <div class="record-name">${r.empName}</div>
        <div class="record-time">${formatTime(r.timestamp)} · ${r.empPosition || ''}</div>
      </div>
      <span class="record-type ${r.type}">${r.type === 'in' ? 'เข้างาน' : 'ออกงาน'}</span>
    </div>
  `).join('');
}

// ============================================================
// REPORTS
// ============================================================
function setDateRange(days, btn) {
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const customRange = document.getElementById('custom-date-range');
  if (days === 'custom') {
    customRange.classList.remove('hidden');
    dateRangeDays = 'custom';
    // Set defaults if empty
    const now = new Date();
    const from = document.getElementById('date-from');
    const to = document.getElementById('date-to');
    if (!to.value) to.value = now.toISOString().slice(0, 10);
    if (!from.value) {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      from.value = d.toISOString().slice(0, 10);
    }
  } else {
    customRange.classList.add('hidden');
    dateRangeDays = days;
  }
  renderReport();
}

function getDateRangeBounds() {
  if (dateRangeDays === 'custom') {
    const from = document.getElementById('date-from').value;
    const to = document.getElementById('date-to').value;
    return { from: from || todayStr(), to: to || todayStr() };
  }
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (dateRangeDays - 1));
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

function populateReportEmpFilter() {
  const sel = document.getElementById('report-emp-filter');
  const current = sel.value;
  sel.innerHTML = '<option value="">พนักงานทั้งหมด</option>';
  getEmployees().forEach(emp => {
    const opt = document.createElement('option');
    opt.value = emp.id;
    opt.textContent = emp.name;
    if (emp.id === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderReport() {
  const { from, to } = getDateRangeBounds();
  const empFilter = document.getElementById('report-emp-filter').value;

  let records = getRecords().filter(r => r.date >= from && r.date <= to);
  if (empFilter) records = records.filter(r => r.empId === empFilter);

  // Build daily summary per employee
  const summary = {}; // date+empId → { in, out }
  for (const r of records) {
    const key = r.date + '__' + r.empId;
    if (!summary[key]) {
      summary[key] = {
        empId: r.empId, empName: r.empName, date: r.date,
        inTime: null, outTime: null
      };
    }
    if (r.type === 'in') {
      if (!summary[key].inTime || r.timestamp < summary[key].inTime)
        summary[key].inTime = r.timestamp;
    } else {
      if (!summary[key].outTime || r.timestamp > summary[key].outTime)
        summary[key].outTime = r.timestamp;
    }
  }

  const rows = Object.values(summary).sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.empName.localeCompare(b.empName);
  });

  // Stats
  const empSet = new Set(rows.map(r => r.empId));
  const daySet = new Set(rows.map(r => r.date));
  let totalHours = 0;
  for (const r of rows) {
    if (r.inTime && r.outTime) {
      totalHours += (new Date(r.outTime) - new Date(r.inTime)) / 3600000;
    }
  }

  document.getElementById('stat-employees').textContent = empSet.size;
  document.getElementById('stat-days').textContent = daySet.size;
  document.getElementById('stat-hours').textContent = totalHours.toFixed(1);

  // Render table
  const tbody = document.getElementById('report-tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">ไม่มีข้อมูลในช่วงวันที่เลือก</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const hours = (r.inTime && r.outTime)
      ? ((new Date(r.outTime) - new Date(r.inTime)) / 3600000).toFixed(1)
      : '-';
    return `
      <tr>
        <td><strong>${r.empName}</strong></td>
        <td>${formatDate(r.date)}</td>
        <td class="in-badge">${r.inTime ? formatTime(r.inTime) : '-'}</td>
        <td class="out-badge">${r.outTime ? formatTime(r.outTime) : '-'}</td>
        <td>${hours !== '-' ? `<span class="hours-badge">${hours} ชม.</span>` : '-'}</td>
      </tr>`;
  }).join('');
}

// ============================================================
// CSV EXPORT
// ============================================================
function exportCSV() {
  const { from, to } = getDateRangeBounds();
  const empFilter = document.getElementById('report-emp-filter').value;

  let records = getRecords().filter(r => r.date >= from && r.date <= to);
  if (empFilter) records = records.filter(r => r.empId === empFilter);

  const summary = {};
  for (const r of records) {
    const key = r.date + '__' + r.empId;
    if (!summary[key]) {
      summary[key] = { empId: r.empId, empName: r.empName, date: r.date, inTime: null, outTime: null };
    }
    if (r.type === 'in') {
      if (!summary[key].inTime || r.timestamp < summary[key].inTime)
        summary[key].inTime = r.timestamp;
    } else {
      if (!summary[key].outTime || r.timestamp > summary[key].outTime)
        summary[key].outTime = r.timestamp;
    }
  }

  const rows = Object.values(summary).sort((a, b) => a.date.localeCompare(b.date));
  const csvLines = ['\uFEFFชื่อพนักงาน,วันที่,เวลาเข้างาน,เวลาออกงาน,ชั่วโมงทำงาน'];

  for (const r of rows) {
    const hours = (r.inTime && r.outTime)
      ? ((new Date(r.outTime) - new Date(r.inTime)) / 3600000).toFixed(2)
      : '';
    csvLines.push([
      `"${r.empName}"`,
      r.date,
      r.inTime ? formatTime(r.inTime) : '',
      r.outTime ? formatTime(r.outTime) : '',
      hours,
    ].join(','));
  }

  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `attendance_${from}_${to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('ส่งออก CSV สำเร็จ', 'success');
}

// ============================================================
// INIT
// ============================================================
async function init() {
  // Start clock
  updateClock();
  setInterval(updateClock, 1000);

  // Show loading progress
  setLoadingStatus('กำลังเตรียมระบบ...', 10);
  await sleep(300);
  setLoadingStatus('กำลังโหลด Face Recognition Models...', 30);

  // Load face-api models
  const loaded = await loadFaceModels();

  if (!loaded) {
    // Still show app but warn user
    setLoadingStatus('โหลด Models ไม่สำเร็จ — บางฟีเจอร์อาจไม่ทำงาน', 100);
    document.getElementById('loading-hint').textContent =
      'ต้องการอินเทอร์เน็ตเพื่อโหลด AI Models กรุณาเชื่อมต่อแล้วรีโหลดหน้า';
    await sleep(2500);
  } else {
    setLoadingStatus('เสร็จสิ้น!', 100);
    await sleep(600);
  }

  // Show app
  const loadingScreen = document.getElementById('loading-screen');
  const app = document.getElementById('app');
  loadingScreen.classList.add('fade-out');
  setTimeout(() => {
    loadingScreen.style.display = 'none';
    app.classList.remove('hidden');
    // Start scan camera on first load
    startScanCamera();
    renderTodayRecords();
  }, 500);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// ENTRY POINT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // Check for face-api
  if (typeof faceapi === 'undefined') {
    document.getElementById('loading-status').textContent =
      'ไม่สามารถโหลด face-api.js ได้ กรุณาเชื่อมต่ออินเทอร์เน็ต';
    document.getElementById('loading-hint').textContent =
      'โหลดหน้าใหม่เมื่อมีการเชื่อมต่ออินเทอร์เน็ต';
    document.getElementById('loading-bar-fill').style.background = '#ef4444';
    return;
  }
  init();
});
