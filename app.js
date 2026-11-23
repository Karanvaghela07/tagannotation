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
let projectsRef = null;
let allEntries = [];
let processedEntries = [];
let isFirebaseConnected = false;
let framesChart = null;
let annotationsChart = null;
let editingEntryId = null;
let dashboardNotesPage = 1;
const dashboardNotesPerPage = 10;
let dataSortOrder = 'desc'; // 'desc' = latest first, 'asc' = oldest first

// ---- Project State ----
let activeProjectId = null;
let activeProjectName = null;
let allProjects = {}; // { id: { name, createdAt } }
let entriesListener = null; // current Firebase listener unsubscribe ref

// ============================================
// FIREBASE INIT
// ============================================
function initFirebase() {
  try {
    if (typeof firebase === 'undefined') {
      console.warn('Firebase SDK not loaded.');
      setConnectionStatus(false);
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    db = firebase.database();
    projectsRef = db.ref('projects_meta');

    // Listen to project list in real time
    projectsRef.on('value', (snapshot) => {
      const data = snapshot.val() || {};
      allProjects = data;
      renderSidebarProjects();

      // On first load: if no active project, pick the first or seed default
      if (!activeProjectId) {
        const ids = Object.keys(data);
        if (ids.length > 0) {
          switchProject(ids[0], data[ids[0]].name);
        } else {
          // Seed the default "Tag Annotation" project
          seedDefaultProject();
        }
      }
    });

    setConnectionStatus(true);
    showToast('Connected to Firebase!', 'success');
  } catch (err) {
    console.error('Firebase init error:', err);
    setConnectionStatus(false);
    showToast('Failed to connect to Firebase.', 'error');
  }
}

async function seedDefaultProject() {
  try {
    const ref = projectsRef.push();
    await ref.set({ name: 'Tag Annotation', createdAt: Date.now() });
    // Migrate existing annotations into this project
    const existing = await db.ref('annotations').once('value');
    if (existing.val()) {
      await db.ref(`projects/${ref.key}/annotations`).set(existing.val());
    }
  } catch (err) {
    console.error('Seed default project error:', err);
  }
}

// ============================================
// PROJECT SWITCHING
// ============================================
function switchProject(projectId, projectName) {
  if (activeProjectId === projectId) return;

  // Detach previous listener
  if (entriesListener && activeProjectId) {
    db.ref(`projects/${activeProjectId}/annotations`).off('value', entriesListener);
    entriesListener = null;
  }

  activeProjectId = projectId;
  activeProjectName = projectName;

  // Reset state
  allEntries = [];
  processedEntries = [];
  editingEntryId = null;
  cancelEditEntry();

  entriesRef = db.ref(`projects/${projectId}/annotations`);

  // Subscribe
  entriesListener = entriesRef.on('value', (snapshot) => {
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
    showToast('Database read error.', 'error');
    setConnectionStatus(false);
  });

  renderSidebarProjects();
  updateProjectUI();
  navigateTo('homePage');
  showToast(`Switched to "${projectName}"`, 'info');
}

function updateProjectUI() {
  // Top bar chip
  const chip = document.getElementById('topBarProjectChip');
  if (chip) chip.textContent = activeProjectName || '';

  // Sidebar footer
  const footerEl = document.getElementById('sidebarActiveProject');
  if (footerEl) footerEl.textContent = activeProjectName || '—';
}

// ============================================
// PROJECT SIDEBAR RENDERING
// ============================================
function renderSidebarProjects() {
  const container = document.getElementById('sidebarProjects');
  if (!container) return;

  const ids = Object.keys(allProjects);
  if (ids.length === 0) {
    container.innerHTML = '<div class="sidebar-no-projects">No projects yet</div>';
    return;
  }

  container.innerHTML = ids.map(id => {
    const p = allProjects[id];
    const isActive = id === activeProjectId;
    return `
      <div class="sidebar-project-item ${isActive ? 'active' : ''}" onclick="switchProject('${id}', '${escapeAttr(p.name)}')">
        <span class="sidebar-project-dot ${isActive ? 'active' : ''}"></span>
        <span class="sidebar-project-name">${escapeHtml(p.name)}</span>
        ${isActive ? '<span class="sidebar-project-active-badge">active</span>' : ''}
      </div>
    `;
  }).join('');
}

function escapeAttr(str) {
  return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ============================================
// PROJECT MODAL
// ============================================
function openProjectModal() {
  renderProjectModalList();
  document.getElementById('projectModalOverlay').classList.add('active');
  setTimeout(() => document.getElementById('newProjectName')?.focus(), 100);
}

function closeProjectModal() {
  document.getElementById('projectModalOverlay').classList.remove('active');
  document.getElementById('newProjectName').value = '';
}

function renderProjectModalList() {
  const container = document.getElementById('projectList');
  if (!container) return;

  const ids = Object.keys(allProjects);
  if (ids.length === 0) {
    container.innerHTML = '<div class="project-list-empty">No projects yet. Create your first one above.</div>';
    return;
  }

  container.innerHTML = ids.map(id => {
    const p = allProjects[id];
    const isActive = id === activeProjectId;
    return `
      <div class="project-list-item ${isActive ? 'active' : ''}">
        <div class="project-list-item-left">
          <span class="project-list-dot ${isActive ? 'active' : ''}"></span>
          <span class="project-list-name">${escapeHtml(p.name)}</span>
          ${isActive ? '<span class="project-active-badge">active</span>' : ''}
        </div>
        <div class="project-list-item-right">
          ${!isActive ? `<button class="project-switch-btn" onclick="switchProject('${id}', '${escapeAttr(p.name)}'); closeProjectModal()">Switch</button>` : ''}
          ${ids.length > 1 ? `<button class="project-delete-btn" onclick="confirmDeleteProject('${id}', '${escapeAttr(p.name)}')">✕</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function createProject() {
  const input = document.getElementById('newProjectName');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    showToast('Enter a project name', 'error');
    return;
  }
  if (!db) { showToast('Not connected to Firebase!', 'error'); return; }

  // Check for duplicate name
  const existing = Object.values(allProjects).find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    showToast('A project with that name already exists', 'error');
    return;
  }

  try {
    const ref = projectsRef.push();
    await ref.set({ name, createdAt: Date.now() });
    input.value = '';
    showToast(`Project "${name}" created!`, 'success');
    renderProjectModalList();
    // Auto-switch to the new project
    switchProject(ref.key, name);
    closeProjectModal();
  } catch (err) {
    console.error('Create project error:', err);
    showToast('Failed to create project.', 'error');
  }
}

function confirmDeleteProject(projectId, projectName) {
  const overlay = document.getElementById('modalOverlay');
  const message = document.getElementById('modalMessage');
  message.textContent = `Delete project "${projectName}" and ALL its data? This cannot be undone.`;
  overlay.classList.add('active');

  document.getElementById('modalConfirmBtn').onclick = async () => {
    overlay.classList.remove('active');
    try {
      await db.ref(`projects/${projectId}`).remove();
      await db.ref(`projects_meta/${projectId}`).remove();
      showToast(`Project "${projectName}" deleted`, 'info');
      renderProjectModalList();
      // If deleted the active project, switch to first remaining
      if (activeProjectId === projectId) {
        activeProjectId = null;
        const remaining = Object.keys(allProjects).filter(id => id !== projectId);
        if (remaining.length > 0) {
          switchProject(remaining[0], allProjects[remaining[0]].name);
        }
      }
    } catch (err) {
      console.error('Delete project error:', err);
      showToast('Failed to delete project.', 'error');
    }
  };
}

// ============================================
// CONNECTION STATUS
// ============================================
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

// ============================================
// POSITION KEY EXTRACTION
// ============================================
function extractPositionKey(folderName) {
  const parts = String(folderName).split('_');
  if (parts.length >= 5) {
    return parts[1] + '_' + parts[2] + '_' + parts[3];
  }
  return folderName;
}

// ============================================
// PROCESS ENTRIES
// ============================================
function processEntries() {
  const positionCounters = {};
  processedEntries = allEntries.map((entry, index) => {
    const positionKey = extractPositionKey(entry.folderName);
    if (positionCounters[positionKey] === undefined) positionCounters[positionKey] = 0;
    const positionVideoNum = positionCounters[positionKey];
    positionCounters[positionKey]++;
    return { ...entry, seriesNum: index + 1, positionKey, positionVideoNum };
  });
}

// ============================================
// ENTRY CRUD
// ============================================
function calculateAnnotations(totalFrames) {
  return Number(totalFrames) * 3;
}

function setEntryFormForEdit(entry) {
  editingEntryId = entry.id;
  document.getElementById('folderName').value = entry.folderName || '';
  document.getElementById('totalFrames').value = entry.totalFrames || '';
  document.getElementById('videoStatus').value = entry.status || '';
  document.getElementById('videoNotes').value = entry.notes || '';
  const addBtn = document.getElementById('addBtn');
  addBtn.innerHTML = '✦ Update Entry';
  addBtn.setAttribute('data-mode', 'update');
  document.getElementById('cancelUpdateBtn').style.display = 'block';
}

function cancelEditEntry() {
  editingEntryId = null;
  const folderInput = document.getElementById('folderName');
  const framesInput = document.getElementById('totalFrames');
  const statusInput = document.getElementById('videoStatus');
  const notesInput = document.getElementById('videoNotes');
  const addBtn = document.getElementById('addBtn');
  const cancelBtn = document.getElementById('cancelUpdateBtn');

  if (folderInput) folderInput.value = '';
  if (framesInput) framesInput.value = '';
  if (statusInput) statusInput.value = '';
  if (notesInput) notesInput.value = '';
  if (addBtn) { addBtn.innerHTML = '✦ Add Entry'; addBtn.removeAttribute('data-mode'); }
  if (cancelBtn) cancelBtn.style.display = 'none';
  clearFieldError('folderName');
  clearFieldError('totalFrames');
}

async function addEntry() {
  if (!activeProjectId) {
    showToast('No project selected. Create or select a project first.', 'error');
    return;
  }

  const folderName = document.getElementById('folderName').value.trim();
  const totalFrames = parseInt(document.getElementById('totalFrames').value, 10);
  const status = document.getElementById('videoStatus').value;
  const notes = document.getElementById('videoNotes').value.trim();
  const totalAnnotations = calculateAnnotations(totalFrames);

  let hasError = false;
  if (!folderName) { showFieldError('folderName', 'Folder name is required'); hasError = true; }
  else clearFieldError('folderName');

  if (isNaN(totalFrames) || totalFrames <= 0) { showFieldError('totalFrames', 'Enter a valid positive number of frames'); hasError = true; }
  else clearFieldError('totalFrames');

  if (hasError) return;
  if (!isFirebaseConnected || !entriesRef) { showToast('Not connected to Firebase!', 'error'); return; }

  const btn = document.getElementById('addBtn');
  btn.classList.add('loading');
  btn.innerHTML = '<div class="spinner"></div> Saving...';

  try {
    if (editingEntryId) {
      await db.ref(`projects/${activeProjectId}/annotations/${editingEntryId}`).update({
        folderName, totalFrames, totalAnnotations, status, notes
      });
      showToast(`Updated "${folderName}" successfully!`, 'success');
    } else {
      await entriesRef.push({ folderName, totalFrames, totalAnnotations, status, notes, dateAdded: Date.now() });
      showToast(`Added "${folderName}" successfully!`, 'success');
    }

    document.getElementById('folderName').value = '';
    document.getElementById('totalFrames').value = '';
    document.getElementById('videoStatus').value = '';
    document.getElementById('videoNotes').value = '';
    editingEntryId = null;
    btn.innerHTML = '✦ Add Entry';
    document.getElementById('cancelUpdateBtn').style.display = 'none';
    btn.removeAttribute('data-mode');
  } catch (err) {
    console.error('Save error:', err);
    showToast(editingEntryId ? 'Failed to update entry.' : 'Failed to add entry.', 'error');
  } finally {
    btn.classList.remove('loading');
    if (!editingEntryId) btn.innerHTML = '✦ Add Entry';
  }
}

function startEditEntry(id) {
  const entry = allEntries.find(item => item.id === id);
  if (!entry) return;
  setEntryFormForEdit(entry);
  navigateTo('homePage');
}

function confirmDelete(id, folderName) {
  const overlay = document.getElementById('modalOverlay');
  document.getElementById('modalMessage').textContent = `Are you sure you want to delete "${folderName}"? This action cannot be undone.`;
  overlay.classList.add('active');

  document.getElementById('modalConfirmBtn').onclick = async () => {
    overlay.classList.remove('active');
    try {
      await db.ref(`projects/${activeProjectId}/annotations/${id}`).remove();
      if (editingEntryId === id) cancelEditEntry();
      showToast(`Deleted "${folderName}"`, 'info');
    } catch (err) {
      console.error('Delete error:', err);
      showToast('Failed to delete. Try again.', 'error');
    }
  };
}

function confirmDeleteAll() {
  if (processedEntries.length === 0) { showToast('No entries to delete', 'info'); return; }

  const overlay = document.getElementById('modalOverlay');
  document.getElementById('modalMessage').textContent = `Delete ALL ${processedEntries.length} entries in "${activeProjectName}"? This cannot be undone.`;
  overlay.classList.add('active');

  document.getElementById('modalConfirmBtn').onclick = async () => {
    overlay.classList.remove('active');
    try {
      await db.ref(`projects/${activeProjectId}/annotations`).set(null);
      showToast('All entries deleted', 'info');
    } catch (err) {
      console.error('Delete all error:', err);
      showToast('Failed to delete all. Try again.', 'error');
    }
  };
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

// ============================================
// FIELD VALIDATION
// ============================================
function showFieldError(fieldId, message) {
  const input = document.getElementById(fieldId);
  if (!input) return;
  const error = input.parentElement.querySelector('.form-error');
  input.classList.add('error');
  if (error) { error.textContent = message; error.classList.add('visible'); }
}

function clearFieldError(fieldId) {
  const input = document.getElementById(fieldId);
  if (!input) return;
  const error = input.parentElement.querySelector('.form-error');
  input.classList.remove('error');
  if (error) error.classList.remove('visible');
}

// ============================================
// RENDER DATA TABLE
// ============================================
function renderDataTable() {
  const tbody = document.getElementById('dataTableBody');
  if (!tbody) return;

  const searchTerm = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  const filtered = processedEntries.filter(e => e.folderName.toLowerCase().includes(searchTerm));

  const sorted = filtered.slice().sort((a, b) => {
    const dateA = a.dateAdded || 0;
    const dateB = b.dateAdded || 0;
    return dataSortOrder === 'desc' ? dateB - dateA : dateA - dateB;
  });

  if (sorted.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty-state">
          <div class="empty-state-icon">📋</div>
          <div class="empty-state-text">${searchTerm ? 'No matching entries found' : 'No entries yet'}</div>
          <div class="empty-state-sub">${searchTerm ? 'Try a different search term' : 'Go to Home to add your first video entry'}</div>
        </div>
      </td></tr>`;
    const countEl = document.getElementById('entryCount');
    if (countEl) countEl.textContent = '0 entries';
    return;
  }

  let totalFrames = 0;
  let totalAnnotations = 0;

  let html = sorted.map(entry => {
    totalFrames += (entry.totalFrames || 0);
    totalAnnotations += (entry.totalAnnotations || 0);
    const date = entry.dateAdded
      ? new Date(entry.dateAdded).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : '-';

    return `
      <tr class="${getStatusRowClass(entry.status)}">
        <td><span class="series-num">#${entry.seriesNum}</span></td>
        <td><span class="video-num">${entry.positionVideoNum}</span></td>
        <td><span class="folder-name">${entry.folderName}</span></td>
        <td><span class="num-frames">${(entry.totalFrames || 0).toLocaleString()}</span></td>
        <td><span class="num-annot">${(entry.totalAnnotations || 0).toLocaleString()}</span></td>
        <td>
          <div class="table-status-cell">
            <select class="status-select status-${getStatusRowClass(entry.status).replace('status-row-', '')}" onchange="updateEntryStatus('${entry.id}', this.value)">
              <option value="" ${!entry.status ? 'selected' : ''}>No status</option>
              <option value="Complete" ${entry.status === 'Complete' ? 'selected' : ''}>Complete</option>
              <option value="In QA" ${entry.status === 'In QA' ? 'selected' : ''}>In QA</option>
              <option value="Remaining" ${entry.status === 'Remaining' ? 'selected' : ''}>Remaining</option>
              <option value="Wrong" ${entry.status === 'Wrong' ? 'selected' : ''}>Wrong</option>
              <option value="Review" ${entry.status === 'Review' ? 'selected' : ''}>Needs review</option>
            </select>
            ${entry.notes ? `<span class="table-note" title="${escapeHtml(entry.notes)}">${escapeHtml(entry.notes)}</span>` : ''}
          </div>
        </td>
        <td><span class="date-cell">${date}</span></td>
        <td>
          <div class="table-actions">
            <button class="table-action-btn" onclick="startEditEntry('${entry.id}')">Update</button>
            <button class="table-action-btn delete" onclick="confirmDelete('${entry.id}', '${String(entry.folderName).replace(/'/g, "\\'")}')">Delete</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  html += `
    <tr class="table-summary">
      <td colspan="3"><strong>TOTALS</strong></td>
      <td><strong>${totalFrames.toLocaleString()}</strong></td>
      <td><strong>${totalAnnotations.toLocaleString()}</strong></td>
      <td colspan="3"></td>
    </tr>`;

  tbody.innerHTML = html;
  const countEl = document.getElementById('entryCount');
  if (countEl) countEl.textContent = `${sorted.length} ${sorted.length === 1 ? 'entry' : 'entries'}`;
}

// ============================================
// RENDER RECENT ENTRIES
// ============================================
function renderRecentEntries() {
  const container = document.getElementById('recentEntries');
  if (!container) return;

  const recent = processedEntries.slice(-5).reverse();
  if (recent.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:30px 10px;">
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-text">No entries yet</div>
        <div class="empty-state-sub">Add your first entry above!</div>
      </div>`;
    return;
  }

  container.innerHTML = recent.map(entry => `
    <div class="recent-item">
      <div class="recent-item-left">
        <div class="recent-item-num">${entry.seriesNum}</div>
        <div>
          <div class="recent-item-name">${entry.folderName}</div>
          <div class="recent-item-meta">Position: ${entry.positionKey} · Video #${entry.positionVideoNum}</div>
          ${entry.status || entry.notes ? `<div class="recent-item-note">${entry.status ? `<span class="status-label status-${entry.status.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '')}">${escapeHtml(entry.status)}</span>` : ''}${entry.notes ? ` ${escapeHtml(entry.notes)}` : ''}</div>` : ''}
        </div>
      </div>
      <div class="recent-item-right">
        <span class="recent-frames">${(entry.totalFrames || 0).toLocaleString()} fr</span>
        <span class="recent-annot">${(entry.totalAnnotations || 0).toLocaleString()} ann</span>
      </div>
    </div>`).join('');
}

// ============================================
// HOME MINI STATS
// ============================================
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

// ============================================
// RENDER DASHBOARD
// ============================================
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
  renderDashboardNotes();
  renderMinutesTracker();
  renderCharts();
}

// ============================================
// MINUTES PROGRESS TRACKER
// ============================================
const TOTAL_TARGET_MINUTES = 1200;
const FPS = 15;

function renderMinutesTracker() {
  const completeEntries = processedEntries.filter(e => e.status === 'Complete');
  const totalFrames = completeEntries.reduce((sum, e) => sum + (e.totalFrames || 0), 0);
  const totalVideos = completeEntries.length;

  const minutesCompleted = totalFrames / (FPS * 60);
  const minutesRemaining = Math.max(0, TOTAL_TARGET_MINUTES - minutesCompleted);
  const percentComplete = Math.min(100, (minutesCompleted / TOTAL_TARGET_MINUTES) * 100);

  const mcEl = document.getElementById('dashMinutesCompleted');
  const mrEl = document.getElementById('dashMinutesRemaining');
  const mpEl = document.getElementById('dashMinutesPercent');
  const mfEl = document.getElementById('dashMinutesFill');
  const mgEl = document.getElementById('dashMinutesGlow');
  const mlEl = document.getElementById('dashMinutesCompletedLabel');
  const tfmEl = document.getElementById('dashTotalFramesMinutes');
  const tvmEl = document.getElementById('dashTotalVideosMinutes');

  if (mcEl) mcEl.textContent = minutesCompleted.toFixed(2);
  if (mrEl) mrEl.textContent = minutesRemaining.toFixed(2);
  if (mpEl) mpEl.textContent = percentComplete.toFixed(2) + '%';
  if (mfEl) mfEl.style.width = percentComplete + '%';
  if (mgEl) mgEl.style.width = percentComplete + '%';
  if (mlEl) mlEl.textContent = minutesCompleted.toFixed(2) + ' min completed';
  if (tfmEl) tfmEl.textContent = totalFrames.toLocaleString();
  if (tvmEl) tvmEl.textContent = totalVideos;

  if (mfEl) {
    if (percentComplete >= 100)      mfEl.style.background = 'linear-gradient(90deg, #10b981, #059669)';
    else if (percentComplete >= 75)  mfEl.style.background = 'linear-gradient(90deg, #2a9d8f, #10b981)';
    else if (percentComplete >= 50)  mfEl.style.background = 'linear-gradient(90deg, #1d3557, #2a9d8f)';
    else                             mfEl.style.background = 'linear-gradient(90deg, #1d3557, #457b9d)';
  }
}

// ============================================
// DASHBOARD NOTES
// ============================================
function renderDashboardNotes() {
  const container = document.getElementById('dashboardNotes');
  const pagination = document.getElementById('dashboardPagination');
  if (!container) return;

  const annotatedEntries = processedEntries.filter(entry => entry.status || entry.notes).slice().reverse();
  if (annotatedEntries.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:32px;"><div class="empty-state-icon">✎</div><div class="empty-state-text">No notes or statuses yet</div></div>';
    if (pagination) pagination.hidden = true;
    return;
  }

  const totalPages = Math.ceil(annotatedEntries.length / dashboardNotesPerPage);
  dashboardNotesPage = Math.min(dashboardNotesPage, totalPages);
  const startIndex = (dashboardNotesPage - 1) * dashboardNotesPerPage;
  const visibleEntries = annotatedEntries.slice(startIndex, startIndex + dashboardNotesPerPage);

  container.innerHTML = visibleEntries.map(entry => `
    <div class="dashboard-note-item">
      <div>
        <div class="dashboard-note-folder">${escapeHtml(entry.folderName)}</div>
        <div class="dashboard-note-position">Position: ${escapeHtml(entry.positionKey)} · Video #${entry.positionVideoNum}</div>
      </div>
      <div class="dashboard-note-content">
        ${entry.status ? `<span class="status-label status-${entry.status.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '')}">${escapeHtml(entry.status)}</span>` : ''}
        ${entry.notes ? `<span class="dashboard-note-text">${escapeHtml(entry.notes)}</span>` : ''}
      </div>
    </div>`).join('');

  if (pagination) {
    pagination.hidden = totalPages <= 1;
    document.getElementById('dashboardPageInfo').textContent = `Page ${dashboardNotesPage} of ${totalPages}`;
    document.getElementById('dashboardPrevBtn').disabled = dashboardNotesPage === 1;
    document.getElementById('dashboardNextBtn').disabled = dashboardNotesPage === totalPages;
  }
}

function changeDashboardNotesPage(direction) {
  dashboardNotesPage += direction;
  renderDashboardNotes();
}

// ============================================
// HELPERS
// ============================================
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}

function getStatusRowClass(status) {
  return status ? `status-row-${String(status).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '')}` : '';
}

async function updateEntryStatus(id, status) {
  if (!db) { showToast('Not connected to Firebase!', 'error'); return; }
  try {
    await db.ref(`projects/${activeProjectId}/annotations/${id}`).update({ status });
    showToast('Status updated', 'success');
  } catch (err) {
    console.error('Status update error:', err);
    showToast('Failed to update status.', 'error');
  }
}

// ============================================
// POSITION BREAKDOWN
// ============================================
function renderPositionBreakdown() {
  const tbody = document.getElementById('positionBreakdown');
  if (!tbody) return;

  const positionMap = {};
  processedEntries.forEach(entry => {
    if (!positionMap[entry.positionKey]) positionMap[entry.positionKey] = { videos: 0, frames: 0, annotations: 0 };
    positionMap[entry.positionKey].videos++;
    positionMap[entry.positionKey].frames += (entry.totalFrames || 0);
    positionMap[entry.positionKey].annotations += (entry.totalAnnotations || 0);
  });

  const positions = Object.keys(positionMap);
  if (positions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:30px;">No data to display</td></tr>`;
    return;
  }

  tbody.innerHTML = positions.map(key => `
    <tr>
      <td><span class="position-badge">${key}</span></td>
      <td><strong>${positionMap[key].videos}</strong></td>
      <td>${positionMap[key].frames.toLocaleString()}</td>
      <td>${positionMap[key].annotations.toLocaleString()}</td>
    </tr>`).join('');
}

// ============================================
// CHARTS
// ============================================
function renderCharts() {
  if (typeof Chart === 'undefined') return;

  const positionMap = {};
  processedEntries.forEach(entry => {
    if (!positionMap[entry.positionKey]) positionMap[entry.positionKey] = { frames: 0, annotations: 0 };
    positionMap[entry.positionKey].frames += (entry.totalFrames || 0);
    positionMap[entry.positionKey].annotations += (entry.totalAnnotations || 0);
  });

  const labels = Object.keys(positionMap);
  const framesData = labels.map(k => positionMap[k].frames);
  const annotData = labels.map(k => positionMap[k].annotations);

  const chartColors = [
    'rgba(29,53,87,0.88)', 'rgba(42,157,143,0.88)', 'rgba(69,123,157,0.88)',
    'rgba(233,196,106,0.95)', 'rgba(231,111,81,0.88)', 'rgba(76,114,145,0.88)',
    'rgba(38,166,154,0.88)', 'rgba(120,144,166,0.88)'
  ];
  const chartBorders = chartColors.map(c => c.replace(/0\.8[85]/, '1'));

  const framesCanvas = document.getElementById('framesChart');
  if (framesCanvas) {
    const ctx = framesCanvas.getContext('2d');
    if (framesChart) framesChart.destroy();
    framesChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels.length > 0 ? labels : ['No Data'],
        datasets: [{
          data: framesData.length > 0 ? framesData : [1],
          backgroundColor: framesData.length > 0 ? chartColors.slice(0, labels.length) : ['rgba(148,163,184,0.35)'],
          borderColor: framesData.length > 0 ? chartBorders.slice(0, labels.length) : ['rgba(100,116,139,0.6)'],
          borderWidth: 2, hoverOffset: 10
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: true, cutout: '65%',
        plugins: { legend: { position: 'bottom', labels: { color: '#334155', font: { family: 'Inter', size: 12, weight: '600' }, padding: 18, usePointStyle: true, pointStyleWidth: 8 } } }
      }
    });
  }

  const annotCanvas = document.getElementById('annotationsChart');
  if (annotCanvas) {
    const ctx = annotCanvas.getContext('2d');
    if (annotationsChart) annotationsChart.destroy();
    annotationsChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['No Data'],
        datasets: [{
          label: 'Annotations',
          data: annotData.length > 0 ? annotData : [0],
          backgroundColor: annotData.length > 0 ? chartColors.slice(0, labels.length) : ['rgba(148,163,184,0.35)'],
          borderColor: annotData.length > 0 ? chartBorders.slice(0, labels.length) : ['rgba(100,116,139,0.6)'],
          borderWidth: 0, borderRadius: 8, borderSkipped: false, barThickness: 'flex', maxBarThickness: 36
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        scales: {
          x: { ticks: { color: '#334155', font: { family: 'Inter', size: 11, weight: '600' } }, grid: { color: 'rgba(15,23,42,0.07)', drawBorder: false } },
          y: { beginAtZero: true, ticks: { color: '#334155', font: { family: 'Inter', size: 11, weight: '600' } }, grid: { color: 'rgba(15,23,42,0.07)', drawBorder: false } }
        },
        plugins: { legend: { display: false } }
      }
    });
  }
}

// ============================================
// TOAST
// ============================================
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
  setTimeout(() => toast.remove(), duration + 400);
}

// ============================================
// NAVIGATION
// ============================================
function navigateTo(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const targetPage = document.getElementById(pageId);
  if (targetPage) targetPage.classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${pageId}"]`)?.classList.add('active');

  const titles = { homePage: 'Home', dataPage: 'Data', dashboardPage: 'Dashboard' };
  const pageTitleEl = document.getElementById('pageTitle');
  if (pageTitleEl) pageTitleEl.textContent = titles[pageId] || 'Home';

  closeSidebar();
  if (pageId === 'dashboardPage') setTimeout(() => renderCharts(), 120);
}

// ============================================
// SORT TOGGLE
// ============================================
function toggleSortOrder() {
  dataSortOrder = dataSortOrder === 'desc' ? 'asc' : 'desc';
  const btn = document.getElementById('sortToggleBtn');
  const label = document.getElementById('sortLabel');
  const arrows = document.getElementById('sortArrows');

  if (dataSortOrder === 'asc') {
    btn.classList.add('sort-asc');
    if (label) label.textContent = 'Oldest First';
    if (arrows) arrows.textContent = '↑';
  } else {
    btn.classList.remove('sort-asc');
    if (label) label.textContent = 'Latest First';
    if (arrows) arrows.textContent = '↓';
  }
  renderDataTable();
}

// ============================================
// SIDEBAR
// ============================================
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

// ============================================
// SEARCH
// ============================================
function handleSearch() {
  renderDataTable();
}

// ============================================
// EXPORT CSV
// ============================================
function exportCSV() {
  if (processedEntries.length === 0) { showToast('No data to export', 'info'); return; }

  const headers = ['Series #', 'Video #', 'Folder Name', 'Total Frames', 'Total Annotations', 'Status', 'Notes', 'Date Added'];
  const rows = processedEntries.map(e => [
    e.seriesNum, e.positionVideoNum, `"${e.folderName}"`, e.totalFrames, e.totalAnnotations,
    `"${String(e.status || '').replace(/"/g, '""')}"`,
    `"${String(e.notes || '').replace(/"/g, '""')}"`,
    e.dateAdded ? new Date(e.dateAdded).toLocaleDateString() : ''
  ]);

  const totalVideos = processedEntries.length;
  const totalFrames = processedEntries.reduce((sum, e) => sum + (e.totalFrames || 0), 0);
  const totalAnnotations = processedEntries.reduce((sum, e) => sum + (e.totalAnnotations || 0), 0);
  const totalCompleted = processedEntries.filter(e => e.status === 'Complete').length;
  const totalRemaining = processedEntries.filter(e => e.status === 'Remaining').length;

  const summaryRows = [
    [], ['SUMMARY'], ['Project', activeProjectName || ''],
    ['Total Videos', totalVideos], ['Total Frames', totalFrames],
    ['Total Annotations', totalAnnotations], ['Total Completed', totalCompleted], ['Total Remaining', totalRemaining]
  ];

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.join(',')),
    ...summaryRows.map(row => row.join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cvat_${(activeProjectName || 'project').replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exported successfully!', 'success');
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();

  document.getElementById('folderName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addEntry();
  });
  document.getElementById('totalFrames')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addEntry();
  });
  document.getElementById('newProjectName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createProject();
  });

  // Close project modal on overlay click
  document.getElementById('projectModalOverlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('projectModalOverlay')) closeProjectModal();
  });

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('touchend', function(e) {
      e.preventDefault();
      const pageId = this.getAttribute('data-page');
      if (pageId) navigateTo(pageId);
    }, { passive: false });
  });
});
