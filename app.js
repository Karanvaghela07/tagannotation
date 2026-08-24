// ============================================
// CVAT Tag Annotation Tracker - App Logic
// ============================================

// ---- Firebase Configuration ----
const firebaseConfig = {
  apiKey: "AIzaSyAg7JOT9Y7OYhl3z_vTd87ZccqtvY3c6XQ",
  authDomain: "tagannotation.firebaseapp.com",
  databaseURL: "https://tagannotation-default-rtdb.firebaseio.com",
  projectId: "tagannotation",
  storageBucket: "tagannotation.firebasestorage.app",
  messagingSenderId: "247592661737",
  appId: "1:247592661737:web:018557d96fae75783eb678",
  measurementId: "G-7CFKTXE8FV"
};

// ---- App State ----
let db = null;
let entriesRef = null;
let allEntries = [];
let processedEntries = [];
let isFirebaseConnected = false;
let framesChart = null;
let annotationsChart = null;

// ---- Initialize Firebase ----
function initFirebase() {
  try {
    if (typeof firebase === 'undefined') {
      console.warn('Firebase SDK script not loaded yet.');
      setConnectionStatus(false);
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    db = firebase.database();
    entriesRef = db.ref('annotations');

    // Listen for real-time updates
    entriesRef.on('value', (snapshot) => {
      const data = snapshot.val();
      allEntries = [];
      if (data) {
        Object.keys(data).forEach(key => {
          allEntries.push({ id: key, ...data[key] });
        });
        allEntries.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
      }
      processEntries();
      renderDataTable();
      renderDashboard();
      renderRecentEntries();
      updateTotalStats();
    }, (error) => {
      console.error('Firebase read error:', error);
      showToast('Database read error. Check Firebase rules.', 'error');
      setConnectionStatus(false);
    });

    setConnectionStatus(true);
    showToast('Connected to Firebase!', 'success');
  } catch (error) {
    console.error('Firebase init error:', error);
    setConnectionStatus(false);
    showToast('Failed to connect to Firebase.', 'error');
  }
}

// ---- Connection Status ----
function setConnectionStatus(connected) {
  isFirebaseConnected = connected;
  const badge = document.getElementById('connectionStatus');
  if (!badge) return;
  if (connected) {
    badge.className = 'status-badge connected';
    badge.innerHTML = '<span class="status-dot"></span> Connected';
  } else {
    badge.className = 'status-badge disconnected';
    badge.innerHTML = '<span class="status-dot"></span> Disconnected';
  }
}

// ---- Position Key Extraction ----
// Folder name format: XXXXX_AA_BB_X -> position key = "AA_BB"
function extractPositionKey(folderName) {
  const parts = String(folderName).split('_');
  if (parts.length >= 4) {
    return parts[1] + '_' + parts[2];
  }
  return folderName;
}

// ---- Process Entries: Assign continuous series # and position video # ----
function processEntries() {
  const positionCounters = {};
  processedEntries = allEntries.map((entry, index) => {
    const positionKey = extractPositionKey(entry.folderName);

    if (positionCounters[positionKey] === undefined) {
      positionCounters[positionKey] = 0;
    }
    const positionVideoNum = positionCounters[positionKey];
    positionCounters[positionKey]++;

    return {
      ...entry,
      seriesNum: index + 1,
      positionKey,
      positionVideoNum
    };
  });
}

// ---- Add Entry ----
async function addEntry() {
  const folderInput = document.getElementById('folderName');
  const framesInput = document.getElementById('totalFrames');
  const annotInput = document.getElementById('totalAnnotations');

  const folderName = folderInput.value.trim();
  const totalFrames = parseInt(framesInput.value, 10);
  const totalAnnotations = parseInt(annotInput.value, 10);

  // Validation
  let hasError = false;

  if (!folderName) {
    showFieldError('folderName', 'Folder name is required');
    hasError = true;
  } else {
    clearFieldError('folderName');
  }

  if (isNaN(totalFrames) || totalFrames <= 0) {
    showFieldError('totalFrames', 'Enter a valid positive number of frames');
    hasError = true;
  } else {
    clearFieldError('totalFrames');
  }

  if (isNaN(totalAnnotations) || totalAnnotations < 0) {
    showFieldError('totalAnnotations', 'Enter a valid non-negative annotation count');
    hasError = true;
  } else {
    clearFieldError('totalAnnotations');
  }

  if (hasError) return;

  if (!isFirebaseConnected || !entriesRef) {
    showToast('Not connected to Firebase!', 'error');
    return;
  }

  const btn = document.getElementById('addBtn');
  btn.classList.add('loading');
  btn.innerHTML = '<div class="spinner"></div> Adding...';

  try {
    const newEntry = {
      folderName,
      totalFrames,
      totalAnnotations,
      dateAdded: Date.now()
    };

    await entriesRef.push(newEntry);

    // Reset form
    folderInput.value = '';
    framesInput.value = '';
    annotInput.value = '';

    showToast(`Added "${folderName}" successfully!`, 'success');
  } catch (error) {
    console.error('Add error:', error);
    showToast('Failed to add entry. Check database rules.', 'error');
  } finally {
    btn.classList.remove('loading');
    btn.innerHTML = '✨ Add Entry';
  }
}

// ---- Delete Single Entry ----
function confirmDelete(id, folderName) {
  const overlay = document.getElementById('modalOverlay');
  const message = document.getElementById('modalMessage');
  message.textContent = `Are you sure you want to delete "${folderName}"? This action cannot be undone.`;
  overlay.classList.add('active');

  document.getElementById('modalConfirmBtn').onclick = async () => {
    overlay.classList.remove('active');
    try {
      await db.ref('annotations/' + id).remove();
      showToast(`Deleted "${folderName}"`, 'info');
    } catch (error) {
      console.error('Delete error:', error);
      showToast('Failed to delete. Try again.', 'error');
    }
  };
}

// ---- Delete All Entries ----
function confirmDeleteAll() {
  if (processedEntries.length === 0) {
    showToast('No entries to delete', 'info');
    return;
  }

  const overlay = document.getElementById('modalOverlay');
  const message = document.getElementById('modalMessage');
  message.textContent = `Are you sure you want to delete ALL ${processedEntries.length} entries? This cannot be undone.`;
  overlay.classList.add('active');

  document.getElementById('modalConfirmBtn').onclick = async () => {
    overlay.classList.remove('active');
    try {
      await db.ref('annotations').set(null);
      showToast('All entries deleted', 'info');
    } catch (error) {
      console.error('Delete all error:', error);
      showToast('Failed to delete all. Try again.', 'error');
    }
  };
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

// ---- Field Validation Helpers ----
function showFieldError(fieldId, message) {
  const input = document.getElementById(fieldId);
  if (!input) return;
  const error = input.parentElement.querySelector('.form-error');
  input.classList.add('error');
  if (error) {
    error.textContent = message;
    error.classList.add('visible');
  }
}

function clearFieldError(fieldId) {
  const input = document.getElementById(fieldId);
  if (!input) return;
  const error = input.parentElement.querySelector('.form-error');
  input.classList.remove('error');
  if (error) {
    error.classList.remove('visible');
  }
}

// ---- Render Data Table ----
function renderDataTable() {
  const tbody = document.getElementById('dataTableBody');
  if (!tbody) return;

  const searchTerm = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();

  const filtered = processedEntries.filter(e =>
    e.folderName.toLowerCase().includes(searchTerm)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="empty-state">
            <div class="empty-state-icon">📋</div>
            <div class="empty-state-text">${searchTerm ? 'No matching entries found' : 'No entries yet'}</div>
            <div class="empty-state-sub">${searchTerm ? 'Try a different search term' : 'Go to Home to add your first video entry'}</div>
          </div>
        </td>
      </tr>
    `;
    const countEl = document.getElementById('entryCount');
    if (countEl) countEl.textContent = '0 entries';
    return;
  }

  let totalFrames = 0;
  let totalAnnotations = 0;

  let html = filtered.map(entry => {
    totalFrames += (entry.totalFrames || 0);
    totalAnnotations += (entry.totalAnnotations || 0);
    const date = entry.dateAdded
      ? new Date(entry.dateAdded).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : '-';

    return `
      <tr>
        <td><span class="series-num">#${entry.seriesNum}</span></td>
        <td><span class="video-num">${entry.positionVideoNum}</span></td>
        <td><span class="folder-name">${entry.folderName}</span></td>
        <td><span class="num-frames">${(entry.totalFrames || 0).toLocaleString()}</span></td>
        <td><span class="num-annot">${(entry.totalAnnotations || 0).toLocaleString()}</span></td>
        <td><span class="date-cell">${date}</span></td>
        <td>
          <button class="btn-icon" onclick="confirmDelete('${entry.id}', '${String(entry.folderName).replace(/'/g, "\\'")}')" title="Delete">
            🗑
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Summary row (7 columns total)
  html += `
    <tr class="table-summary">
      <td colspan="3"><strong>TOTALS</strong></td>
      <td><strong>${totalFrames.toLocaleString()}</strong></td>
      <td><strong>${totalAnnotations.toLocaleString()}</strong></td>
      <td colspan="2"></td>
    </tr>
  `;

  tbody.innerHTML = html;
  const countEl = document.getElementById('entryCount');
  if (countEl) {
    countEl.textContent = `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`;
  }
}

// ---- Render Recent Entries (Home Page) ----
function renderRecentEntries() {
  const container = document.getElementById('recentEntries');
  if (!container) return;

  const recent = processedEntries.slice(-5).reverse();

  if (recent.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 30px 10px;">
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-text">No entries yet</div>
        <div class="empty-state-sub">Add your first entry above!</div>
      </div>
    `;
    return;
  }

  container.innerHTML = recent.map(entry => `
    <div class="recent-item">
      <div class="recent-item-left">
        <div class="recent-item-num">${entry.seriesNum}</div>
        <div>
          <div class="recent-item-name">${entry.folderName}</div>
          <div class="recent-item-meta">Position: ${entry.positionKey} · Video #${entry.positionVideoNum}</div>
        </div>
      </div>
      <div class="recent-item-right">
        <span class="recent-frames">${(entry.totalFrames || 0).toLocaleString()} fr</span>
        <span class="recent-annot">${(entry.totalAnnotations || 0).toLocaleString()} ann</span>
      </div>
    </div>
  `).join('');
}

// ---- Update Total Stats (Home Mini Stats) ----
function updateTotalStats() {
  const totalVideos = processedEntries.length;
  const totalFrames = processedEntries.reduce((sum, e) => sum + (e.totalFrames || 0), 0);
  const totalAnnotations = processedEntries.reduce((sum, e) => sum + (e.totalAnnotations || 0), 0);

  const vEl = document.getElementById('homeTotalVideos');
  const fEl = document.getElementById('homeTotalFrames');
  const aEl = document.getElementById('homeTotalAnnotations');

  if (vEl) vEl.textContent = totalVideos;
  if (fEl) fEl.textContent = totalFrames.toLocaleString();
  if (aEl) aEl.textContent = totalAnnotations.toLocaleString();
}

// ---- Render Dashboard ----
function renderDashboard() {
  const totalVideos = processedEntries.length;
  const totalFrames = processedEntries.reduce((sum, e) => sum + (e.totalFrames || 0), 0);
  const totalAnnotations = processedEntries.reduce((sum, e) => sum + (e.totalAnnotations || 0), 0);
  const avgFrames = totalVideos > 0 ? Math.round(totalFrames / totalVideos) : 0;

  const dvEl = document.getElementById('dashTotalVideos');
  const dfEl = document.getElementById('dashTotalFrames');
  const daEl = document.getElementById('dashTotalAnnotations');
  const davgEl = document.getElementById('dashAvgFrames');

  if (dvEl) dvEl.textContent = totalVideos;
  if (dfEl) dfEl.textContent = totalFrames.toLocaleString();
  if (daEl) daEl.textContent = totalAnnotations.toLocaleString();
  if (davgEl) davgEl.textContent = avgFrames.toLocaleString();

  renderPositionBreakdown();
  renderCharts();
}

function renderPositionBreakdown() {
  const tbody = document.getElementById('positionBreakdown');
  if (!tbody) return;

  const positionMap = {};
  processedEntries.forEach(entry => {
    if (!positionMap[entry.positionKey]) {
      positionMap[entry.positionKey] = { videos: 0, frames: 0, annotations: 0 };
    }
    positionMap[entry.positionKey].videos++;
    positionMap[entry.positionKey].frames += (entry.totalFrames || 0);
    positionMap[entry.positionKey].annotations += (entry.totalAnnotations || 0);
  });

  const positions = Object.keys(positionMap);

  if (positions.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align:center; color: var(--text-muted); padding: 30px;">
          No data to display
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = positions.map(key => `
    <tr>
      <td><span class="position-badge">${key}</span></td>
      <td><strong>${positionMap[key].videos}</strong></td>
      <td>${positionMap[key].frames.toLocaleString()}</td>
      <td>${positionMap[key].annotations.toLocaleString()}</td>
    </tr>
  `).join('');
}

function renderCharts() {
  if (typeof Chart === 'undefined') return;

  const positionMap = {};
  processedEntries.forEach(entry => {
    if (!positionMap[entry.positionKey]) {
      positionMap[entry.positionKey] = { frames: 0, annotations: 0 };
    }
    positionMap[entry.positionKey].frames += (entry.totalFrames || 0);
    positionMap[entry.positionKey].annotations += (entry.totalAnnotations || 0);
  });

  const labels = Object.keys(positionMap);
  const framesData = labels.map(k => positionMap[k].frames);
  const annotData = labels.map(k => positionMap[k].annotations);

  const chartColors = [
    'rgba(124, 58, 237, 0.85)',
    'rgba(6, 182, 212, 0.85)',
    'rgba(244, 63, 94, 0.85)',
    'rgba(245, 158, 11, 0.85)',
    'rgba(16, 185, 129, 0.85)',
    'rgba(167, 139, 250, 0.85)',
    'rgba(103, 232, 249, 0.85)',
    'rgba(253, 164, 175, 0.85)'
  ];
  const chartBorders = chartColors.map(c => c.replace('0.85', '1'));

  // Frames Chart
  const framesCanvas = document.getElementById('framesChart');
  if (framesCanvas) {
    const framesCtx = framesCanvas.getContext('2d');
    if (framesChart) framesChart.destroy();
    framesChart = new Chart(framesCtx, {
      type: 'doughnut',
      data: {
        labels: labels.length > 0 ? labels : ['No Data'],
        datasets: [{
          data: framesData.length > 0 ? framesData : [1],
          backgroundColor: framesData.length > 0 ? chartColors.slice(0, labels.length) : ['rgba(30,30,50,0.5)'],
          borderColor: framesData.length > 0 ? chartBorders.slice(0, labels.length) : ['rgba(60,60,90,0.8)'],
          borderWidth: 2,
          hoverOffset: 10
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '65%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#8b8ba8',
              font: { family: 'Inter', size: 12, weight: '500' },
              padding: 18,
              usePointStyle: true,
              pointStyleWidth: 8
            }
          }
        }
      }
    });
  }

  // Annotations Bar Chart
  const annotCanvas = document.getElementById('annotationsChart');
  if (annotCanvas) {
    const annotCtx = annotCanvas.getContext('2d');
    if (annotationsChart) annotationsChart.destroy();
    annotationsChart = new Chart(annotCtx, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['No Data'],
        datasets: [{
          label: 'Annotations',
          data: annotData.length > 0 ? annotData : [0],
          backgroundColor: annotData.length > 0 ? chartColors.slice(0, labels.length) : ['rgba(30,30,50,0.5)'],
          borderColor: annotData.length > 0 ? chartBorders.slice(0, labels.length) : ['rgba(60,60,90,0.8)'],
          borderWidth: 0,
          borderRadius: 8,
          borderSkipped: false,
          barThickness: 36
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        scales: {
          x: {
            ticks: { color: '#8b8ba8', font: { family: 'Inter', size: 11, weight: '500' } },
            grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false }
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#8b8ba8', font: { family: 'Inter', size: 11, weight: '500' } },
            grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false }
          }
        },
        plugins: {
          legend: { display: false }
        }
      }
    });
  }
}

// ---- Toast Notifications ----
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-dot"></span> ${message}`;

  const duration = 3000;
  toast.style.animationDuration = '0.4s, 0.4s';
  toast.style.animationDelay = `0s, ${duration / 1000}s`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, duration + 400);
}

// ---- Navigation ----
function navigateTo(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const targetPage = document.getElementById(pageId);
  if (targetPage) targetPage.classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${pageId}"]`)?.classList.add('active');

  const titles = {
    'homePage':      'Home',
    'dataPage':      'Data',
    'dashboardPage': 'Dashboard'
  };
  const pageTitleEl = document.getElementById('pageTitle');
  if (pageTitleEl) pageTitleEl.textContent = titles[pageId] || 'Home';

  closeSidebar();

  if (pageId === 'dashboardPage') {
    setTimeout(() => renderCharts(), 120);
  }
}

// ---- Mobile Sidebar Drawer ----
function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  const isOpen = sidebar.classList.toggle('open');
  overlay.classList.toggle('active', isOpen);
  document.body.classList.toggle('sidebar-open', isOpen);
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

function closeSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  sidebar.classList.remove('open');
  overlay.classList.remove('active');
  document.body.classList.remove('sidebar-open');
  document.body.style.overflow = '';
}

// ---- Export CSV ----
function exportCSV() {
  if (processedEntries.length === 0) {
    showToast('No data to export', 'info');
    return;
  }

  const headers = ['Series #', 'Video #', 'Folder Name', 'Total Frames', 'Total Annotations', 'Date Added'];
  const rows = processedEntries.map(e => [
    e.seriesNum,
    e.positionVideoNum,
    `"${e.folderName}"`,
    e.totalFrames,
    e.totalAnnotations,
    e.dateAdded ? new Date(e.dateAdded).toLocaleDateString() : ''
  ]);

  const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `cvat_annotation_data_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  showToast('CSV exported successfully!', 'success');
}

// ---- Search Handler ----
function handleSearch() {
  renderDataTable();
}

// ---- Initialize ----
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();

  document.getElementById('totalAnnotations')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addEntry();
  });

  // Bulletproof touch handling for nav items on mobile
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('touchend', function(e) {
      e.preventDefault();
      const pageId = this.getAttribute('data-page');
      if (pageId) navigateTo(pageId);
    }, { passive: false });
  });
});
