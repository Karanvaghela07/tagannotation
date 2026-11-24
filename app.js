// ============================================
// CVAT Annotation Tracker — App Logic
// ============================================

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

// ============================================
// PROJECT TYPES
// ============================================
// 'video'  → Tag Annotation style: folder name, frames, annotations (frames×3),
//            minutes tracker, position breakdown
// 'bbox'   → BBox Annotation style: folder name, frames, bounding boxes count,
//            no minutes tracker, no position breakdown
const PROJECT_TYPES = {
  video: {
    label: '🎬 Video / Tag Annotation',
    desc:  'Track video folders with frames, tag annotations, and minutes progress',
    defaultConfig: {
      showMinutesTracker:    true,
      targetMinutes:         1200,
      fps:                   15,
      showAnnotations:       true,   // tag annotations (frames × 3)
      showPositionBreakdown: true,
      color:                 '#2a9d8f'
    }
  },
  bbox: {
    label: '🟦 BBox / Frame Annotation',
    desc:  'Track image folders with frames and bounding box counts',
    defaultConfig: {
      showMinutesTracker:    false,
      targetMinutes:         0,
      fps:                   15,
      showAnnotations:       true,   // bbox count per folder
      showPositionBreakdown: false,
      color:                 '#7c3aed'
    }
  }
};

const DEFAULT_PROJECT_CONFIG = PROJECT_TYPES.video.defaultConfig;

const PROJECT_COLORS = [
  { label: 'Teal',    value: '#2a9d8f' },
  { label: 'Navy',    value: '#1d3557' },
  { label: 'Blue',    value: '#457b9d' },
  { label: 'Violet',  value: '#7c3aed' },
  { label: 'Rose',    value: '#e76f51' },
  { label: 'Amber',   value: '#b8860b' },
  { label: 'Emerald', value: '#238b70' },
  { label: 'Pink',    value: '#db2777' },
];

// ============================================
// APP STATE
// ============================================
let db = null;
let entriesRef        = null;
let projectsRef       = null;
let allEntries        = [];
let processedEntries  = [];
let isFirebaseConnected = false;
let framesChart       = null;
let annotationsChart  = null;
let editingEntryId    = null;
let dashboardNotesPage = 1;
const dashboardNotesPerPage = 10;
let dataSortOrder     = 'desc';

// Project state
let activeProjectId   = null;
let activeProjectName = null;
let activeProjectType = 'video';
let activeConfig      = { ...DEFAULT_PROJECT_CONFIG };
let allProjects       = {};
let entriesListener   = null;

// Settings-modal state
let settingsModalMode  = 'create';
let settingsEditTarget = null;

const LAST_PROJECT_KEY = 'cvat_lastProjectId';

// ============================================
// CONFIG HELPERS
// ============================================
function buildConfig(type, saved) {
  const typeDefaults = (PROJECT_TYPES[type] || PROJECT_TYPES.video).defaultConfig;
  return { ...typeDefaults, ...(saved || {}) };
}

function getProjectType(meta) {
  return meta && meta.type && PROJECT_TYPES[meta.type] ? meta.type : 'video';
}

// ============================================
// FIREBASE INIT
// ============================================
function initFirebase() {
  try {
    if (typeof firebase === 'undefined') {
      setConnectionStatus(false); return;
    }
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    db = firebase.database();
    projectsRef = db.ref('projects_meta');

    projectsRef.on('value', (snapshot) => {
      const data = snapshot.val() || {};
      allProjects = data;
      renderSidebarProjects();

      if (!activeProjectId) {
        const ids = Object.keys(data);
        if (ids.length === 0) {
          seedDefaultProject();
          return;
        }
        // ---- FIX 1: restore last active project from localStorage ----
        const lastId = localStorage.getItem(LAST_PROJECT_KEY);
        const targetId = (lastId && data[lastId]) ? lastId : ids[0];
        switchProject(targetId);
      } else {
        // Refresh config if meta changed (e.g. after edit save)
        if (allProjects[activeProjectId]) {
          const meta = allProjects[activeProjectId];
          activeProjectName = meta.name;
          activeProjectType = getProjectType(meta);
          activeConfig = buildConfig(activeProjectType, meta.config);
          applyProjectConfig();
          updateProjectUI();
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
    await ref.set({
      name: 'Tag Annotation',
      type: 'video',
      createdAt: Date.now(),
      config: { ...PROJECT_TYPES.video.defaultConfig }
    });
    // Migrate any old data at root /annotations
    const existing = await db.ref('annotations').once('value');
    if (existing.val()) {
      await db.ref(`projects/${ref.key}/annotations`).set(existing.val());
    }
  } catch (err) {
    console.error('Seed error:', err);
  }
}

// ============================================
// PROJECT SWITCHING
// ============================================
function switchProject(projectId) {
  if (activeProjectId === projectId) return;

  // Detach previous listener
  if (entriesListener && activeProjectId) {
    db.ref(`projects/${activeProjectId}/annotations`).off('value', entriesListener);
    entriesListener = null;
  }

  activeProjectId = projectId;
  const meta = allProjects[projectId] || {};
  activeProjectName = meta.name || 'Unnamed';
  activeProjectType = getProjectType(meta);
  activeConfig = buildConfig(activeProjectType, meta.config);

  // ---- FIX 1: persist selected project ----
  localStorage.setItem(LAST_PROJECT_KEY, projectId);

  allEntries = [];
  processedEntries = [];
  editingEntryId = null;
  cancelEditEntry();

  entriesRef = db.ref(`projects/${projectId}/annotations`);
  entriesListener = entriesRef.on('value', (snapshot) => {
    const data = snapshot.val();
    allEntries = [];
    if (data) {
      Object.keys(data).forEach(key => allEntries.push({ id: key, ...data[key] }));
      allEntries.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    }
    processEntries();
    renderAll();
  }, (err) => {
    console.error('Firebase read error:', err);
    setConnectionStatus(false);
  });

  renderSidebarProjects();
  applyProjectConfig();
  updateProjectUI();
  navigateTo('homePage');
  showToast(`Switched to "${activeProjectName}"`, 'info');
}

function renderAll() {
  renderDataTable();
  renderDashboard();
  renderRecentEntries();
  updateTotalStats();
}

// ============================================
// APPLY PROJECT CONFIG
// ============================================
function applyProjectConfig() {
  const cfg  = activeConfig;
  const type = activeProjectType;

  // ----- Minutes Tracker -----
  const minutesCard = document.querySelector('.minutes-tracker-card');
  if (minutesCard) minutesCard.style.display = cfg.showMinutesTracker ? '' : 'none';

  // ----- Annotations column header label -----
  const annotTh = document.getElementById('annotationsTh');
  if (annotTh) {
    annotTh.style.display = cfg.showAnnotations ? '' : 'none';
    annotTh.textContent = type === 'bbox' ? 'Bounding Boxes' : 'Annotations';
  }

  // ----- Position breakdown + charts -----
  const posCard = document.getElementById('positionBreakdownCard');
  if (posCard) posCard.style.display = cfg.showPositionBreakdown ? '' : 'none';
  const chartsGrid = document.querySelector('.charts-grid');
  if (chartsGrid) chartsGrid.style.display = cfg.showPositionBreakdown ? '' : 'none';

  // ----- Home form hint -----
  const folderHint = document.getElementById('folderNameHint');
  if (folderHint) {
    folderHint.textContent = type === 'bbox'
      ? 'Folder name containing image files'
      : 'Format: XXXXX_AA_BB_CC_X — position key extracted from AA_BB_CC';
  }

  // ----- Home form field label -----
  const framesLabel = document.getElementById('framesFieldLabel');
  if (framesLabel) framesLabel.textContent = type === 'bbox' ? 'Total Frames / Images' : 'Total Frames';

  // ----- Annotation form field -----
  const annotFormGroup = document.getElementById('annotFormGroup');
  if (annotFormGroup) {
    if (type === 'bbox') {
      annotFormGroup.style.display = '';
      const annotLabel = document.getElementById('annotFieldLabel');
      if (annotLabel) annotLabel.textContent = 'Total Bounding Boxes';
      const annotInput = document.getElementById('totalAnnotationsInput');
      if (annotInput) annotInput.placeholder = 'e.g., 4200';
    } else {
      annotFormGroup.style.display = 'none';
    }
  }

  // ----- Dashboard stat card labels -----
  const dashAnnotStat = document.getElementById('dashAnnotStatCard');
  if (dashAnnotStat) {
    dashAnnotStat.style.display = cfg.showAnnotations ? '' : 'none';
    const lbl = dashAnnotStat.querySelector('.stat-card-label');
    if (lbl) lbl.textContent = type === 'bbox' ? 'Total Bounding Boxes' : 'Total Annotations';
    const icon = dashAnnotStat.querySelector('.stat-card-icon');
    if (icon) icon.textContent = type === 'bbox' ? '🟦' : '🏷️';
  }

  // ----- Home mini stats -----
  const homeAnnotMiniStat = document.getElementById('homeAnnotMiniStat');
  if (homeAnnotMiniStat) {
    homeAnnotMiniStat.style.display = cfg.showAnnotations ? '' : 'none';
    const lbl = homeAnnotMiniStat.querySelector('.mini-stat-lbl');
    if (lbl) lbl.textContent = type === 'bbox' ? 'BBoxes' : 'Annotations';
  }

  // ----- Welcome banner text -----
  const welcomeTitle = document.getElementById('welcomeTitle');
  if (welcomeTitle) {
    welcomeTitle.textContent = type === 'bbox'
      ? 'BBox Annotation Tracker'
      : 'CVAT Tracker';
  }
  const welcomeSubtitle = document.getElementById('welcomeSubtitle');
  if (welcomeSubtitle) {
    welcomeSubtitle.textContent = type === 'bbox'
      ? 'Track image folders, frames, and bounding box counts. Add entries below.'
      : 'Track your video annotations with precision. Add entries below to get started.';
  }

  // ----- Project chip color -----
  const chip = document.getElementById('topBarProjectChip');
  if (chip) {
    chip.style.background  = hexToRgba(cfg.color, 0.1);
    chip.style.borderColor = hexToRgba(cfg.color, 0.25);
    chip.style.color       = cfg.color;
  }

  // ----- Minutes tracker target label -----
  if (cfg.showMinutesTracker) {
    const targetLabel = document.querySelector('.minutes-tracker-target');
    if (targetLabel) targetLabel.textContent = `Target: ${Number(cfg.targetMinutes).toLocaleString()} min`;
    const endLabel = document.querySelector('.minutes-progress-labels span:last-child');
    if (endLabel) endLabel.textContent = `${Number(cfg.targetMinutes).toLocaleString()} min`;
  }
}

function hexToRgba(hex, alpha) {
  const h = String(hex).replace('#','');
  const r = parseInt(h.slice(0,2),16);
  const g = parseInt(h.slice(2,4),16);
  const b = parseInt(h.slice(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ============================================
// PROJECT UI
// ============================================
function updateProjectUI() {
  const chip = document.getElementById('topBarProjectChip');
  if (chip) chip.textContent = activeProjectName || '';
  const footerEl = document.getElementById('sidebarActiveProject');
  if (footerEl) footerEl.textContent = activeProjectName || '—';
  applyProjectConfig();
}

// ============================================
// SIDEBAR PROJECTS
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
    const type = getProjectType(p);
    const cfg = buildConfig(type, p.config);
    const isActive = id === activeProjectId;
    const dotColor = cfg.color || '#2a9d8f';
    const typeIcon = type === 'bbox' ? '🟦' : '🎬';
    return `
      <div class="sidebar-project-item${isActive ? ' active' : ''}" onclick="switchProject('${id}')">
        <span class="sidebar-project-dot" style="background:${dotColor};box-shadow:0 0 6px ${hexToRgba(dotColor,0.5)};"></span>
        <span class="sidebar-project-name">${escapeHtml(p.name)}</span>
        <span class="sidebar-project-type-icon">${typeIcon}</span>
        ${isActive ? '<span class="sidebar-project-active-badge">active</span>' : ''}
      </div>`;
  }).join('');
}

function escapeAttr(str) {
  return String(str).replace(/'/g,"\\'").replace(/"/g,'&quot;');
}

// ============================================
// PROJECT MODAL
// ============================================
function openProjectModal() {
  renderProjectModalList();
  document.getElementById('projectModalOverlay').classList.add('active');
  document.getElementById('projectModalListView').style.display    = '';
  document.getElementById('projectModalSettingsView').style.display = 'none';
}

function closeProjectModal() {
  document.getElementById('projectModalOverlay').classList.remove('active');
  settingsModalMode  = 'create';
  settingsEditTarget = null;
  // ---- FIX 2: safe clear — element may not exist ----
  const nameEl = document.getElementById('settingsProjectName');
  if (nameEl) nameEl.value = '';
}

function renderProjectModalList() {
  const container = document.getElementById('projectList');
  if (!container) return;

  const ids = Object.keys(allProjects);
  if (ids.length === 0) {
    container.innerHTML = '<div class="project-list-empty">No projects yet. Create your first one!</div>';
    return;
  }

  container.innerHTML = ids.map(id => {
    const p = allProjects[id];
    const type = getProjectType(p);
    const cfg = buildConfig(type, p.config);
    const isActive = id === activeProjectId;
    const dotColor = cfg.color || '#2a9d8f';
    const typeLabel = type === 'bbox' ? '🟦 BBox' : '🎬 Video';

    const badges = [];
    if (!cfg.showMinutesTracker)    badges.push('No tracker');
    if (!cfg.showPositionBreakdown) badges.push('No position');

    return `
      <div class="project-list-item${isActive ? ' active' : ''}">
        <div class="project-list-item-left">
          <span class="project-list-dot" style="background:${dotColor};box-shadow:0 0 5px ${hexToRgba(dotColor,0.45)};"></span>
          <div>
            <div style="display:flex;align-items:center;gap:7px;">
              <span class="project-list-name">${escapeHtml(p.name)}</span>
              <span class="project-type-badge">${typeLabel}</span>
              ${isActive ? '<span class="project-active-badge">active</span>' : ''}
            </div>
            ${badges.length ? `<div class="project-config-badges">${badges.map(b=>`<span class="project-config-badge">${b}</span>`).join('')}</div>` : ''}
          </div>
        </div>
        <div class="project-list-item-right">
          <button class="project-settings-btn" onclick="openSettingsView('${id}')" title="Edit settings">⚙</button>
          ${!isActive ? `<button class="project-switch-btn" onclick="switchProject('${id}');closeProjectModal()">Switch</button>` : ''}
          ${ids.length > 1 ? `<button class="project-delete-btn" onclick="confirmDeleteProject('${id}','${escapeAttr(p.name)}')">✕</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ============================================
// SETTINGS VIEW
// ============================================
function openSettingsView(projectId) {
  settingsModalMode  = projectId ? 'edit' : 'create';
  settingsEditTarget = projectId || null;

  let type = 'video';
  let cfg  = { ...PROJECT_TYPES.video.defaultConfig };
  let name = '';

  if (projectId && allProjects[projectId]) {
    const meta = allProjects[projectId];
    type = getProjectType(meta);
    cfg  = buildConfig(type, meta.config);
    name = meta.name;
  }

  document.getElementById('settingsProjectName').value       = name;
  document.getElementById('settingsShowMinutes').checked     = cfg.showMinutesTracker;
  document.getElementById('settingsTargetMinutes').value     = cfg.targetMinutes || 1200;
  document.getElementById('settingsFps').value               = cfg.fps || 15;
  document.getElementById('settingsShowAnnotations').checked = cfg.showAnnotations;
  document.getElementById('settingsShowPosition').checked    = cfg.showPositionBreakdown;

  // Project type radio
  const typeRadio = document.querySelector(`input[name="settingsProjectType"][value="${type}"]`);
  if (typeRadio) typeRadio.checked = true;

  renderColorSwatches(cfg.color);
  toggleMinutesFields();
  toggleTypeFields();

  const title = document.getElementById('settingsViewTitle');
  if (title) title.textContent = projectId ? `Edit: ${name}` : 'New Project Settings';

  const saveBtn = document.getElementById('settingsSaveBtn');
  if (saveBtn) saveBtn.textContent = projectId ? '✓ Save Changes' : '✦ Create Project';

  document.getElementById('projectModalListView').style.display    = 'none';
  document.getElementById('projectModalSettingsView').style.display = '';
}

function renderColorSwatches(selectedColor) {
  const container = document.getElementById('colorSwatches');
  if (!container) return;
  container.innerHTML = PROJECT_COLORS.map(c => `
    <div class="color-swatch${c.value === selectedColor ? ' selected' : ''}"
         style="background:${c.value};"
         title="${c.label}"
         onclick="selectColor('${c.value}')"></div>`).join('');
}

function selectColor(color) {
  document.getElementById('settingsSelectedColor').value = color;
  renderColorSwatches(color);
}

function toggleMinutesFields() {
  const show = document.getElementById('settingsShowMinutes').checked;
  const fields = document.getElementById('minutesSubFields');
  if (fields) fields.style.display = show ? '' : 'none';
}

function toggleTypeFields() {
  const type = document.querySelector('input[name="settingsProjectType"]:checked')?.value || 'video';

  // For bbox type, disable minutes tracker toggle and position breakdown toggle
  const minutesRow  = document.getElementById('minutesTrackerRow');
  const positionRow = document.getElementById('positionBreakdownRow');
  const annotLabel  = document.getElementById('annotationsToggleLabel');
  const annotDesc   = document.getElementById('annotationsToggleDesc');

  if (type === 'bbox') {
    if (minutesRow)  minutesRow.style.opacity  = '0.4';
    if (positionRow) positionRow.style.opacity = '0.4';
    document.getElementById('settingsShowMinutes').checked  = false;
    document.getElementById('settingsShowPosition').checked = false;
    toggleMinutesFields();
    if (annotLabel) annotLabel.textContent = 'Bounding Boxes Count';
    if (annotDesc)  annotDesc.textContent  = 'Show total bounding boxes per folder in table and stats';
  } else {
    if (minutesRow)  minutesRow.style.opacity  = '1';
    if (positionRow) positionRow.style.opacity = '1';
    if (annotLabel) annotLabel.textContent = 'Annotations Column';
    if (annotDesc)  annotDesc.textContent  = 'Show annotations count (frames × 3) in table and stats';
  }
}

function backToProjectList() {
  document.getElementById('projectModalListView').style.display    = '';
  document.getElementById('projectModalSettingsView').style.display = 'none';
  renderProjectModalList();
  settingsModalMode  = 'create';
  settingsEditTarget = null;
}

// ---- FIX 2: saveProjectSettings — robust, correct path ----
async function saveProjectSettings() {
  const nameEl  = document.getElementById('settingsProjectName');
  const colorEl = document.getElementById('settingsSelectedColor');
  const name    = nameEl ? nameEl.value.trim() : '';
  const color   = (colorEl ? colorEl.value : '') || '#2a9d8f';
  const type    = document.querySelector('input[name="settingsProjectType"]:checked')?.value || 'video';

  if (!name) {
    if (nameEl) nameEl.focus();
    showToast('Enter a project name', 'error');
    return;
  }
  if (!db) { showToast('Not connected to Firebase!', 'error'); return; }

  // Duplicate name check (skip self when editing)
  const duplicate = Object.entries(allProjects).find(([id, p]) =>
    p.name.toLowerCase() === name.toLowerCase() && id !== settingsEditTarget
  );
  if (duplicate) { showToast('A project with that name already exists', 'error'); return; }

  const config = {
    showMinutesTracker:    type === 'video' && document.getElementById('settingsShowMinutes').checked,
    targetMinutes:         Math.max(1, parseInt(document.getElementById('settingsTargetMinutes').value, 10) || 1200),
    fps:                   Math.max(1, parseInt(document.getElementById('settingsFps').value, 10) || 15),
    showAnnotations:       document.getElementById('settingsShowAnnotations').checked,
    showPositionBreakdown: type === 'video' && document.getElementById('settingsShowPosition').checked,
    color
  };

  const saveBtn = document.getElementById('settingsSaveBtn');
  if (saveBtn) { saveBtn.classList.add('loading'); saveBtn.innerHTML = '<div class="spinner"></div> Saving…'; }

  try {
    if (settingsModalMode === 'edit' && settingsEditTarget) {
      // ---- FIX 2: use set() not update() so nested config object replaces cleanly ----
      await projectsRef.child(settingsEditTarget).set({
        name,
        type,
        createdAt: allProjects[settingsEditTarget]?.createdAt || Date.now(),
        config
      });
      showToast(`"${name}" saved!`, 'success');
      // Immediately apply if this is the active project
      if (settingsEditTarget === activeProjectId) {
        activeProjectName = name;
        activeProjectType = type;
        activeConfig      = config;
        applyProjectConfig();
        updateProjectUI();
        renderAll();
      }
    } else {
      const ref = projectsRef.push();
      await ref.set({ name, type, createdAt: Date.now(), config });
      showToast(`Project "${name}" created!`, 'success');
      switchProject(ref.key);
    }
    closeProjectModal();
  } catch (err) {
    console.error('saveProjectSettings error:', err);
    showToast('Failed to save. Check Firebase rules.', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.classList.remove('loading');
      saveBtn.textContent = settingsModalMode === 'edit' ? '✓ Save Changes' : '✦ Create Project';
    }
  }
}

// ============================================
// DELETE PROJECT
// ============================================
function confirmDeleteProject(projectId, projectName) {
  document.getElementById('modalMessage').textContent =
    `Delete project "${projectName}" and ALL its data? This cannot be undone.`;
  document.getElementById('modalOverlay').classList.add('active');
  document.getElementById('modalConfirmBtn').onclick = async () => {
    document.getElementById('modalOverlay').classList.remove('active');
    try {
      await db.ref(`projects/${projectId}`).remove();
      await db.ref(`projects_meta/${projectId}`).remove();
      if (activeProjectId === projectId) {
        activeProjectId = null;
        localStorage.removeItem(LAST_PROJECT_KEY);
        const remaining = Object.keys(allProjects).filter(id => id !== projectId);
        if (remaining.length > 0) switchProject(remaining[0]);
      }
      showToast(`"${projectName}" deleted`, 'info');
      renderProjectModalList();
    } catch (err) { showToast('Failed to delete project.', 'error'); }
  };
}

// ============================================
// CONNECTION STATUS
// ============================================
function setConnectionStatus(connected) {
  isFirebaseConnected = connected;
  const badge = document.getElementById('connectionStatus');
  if (!badge) return;
  badge.className = connected ? 'status-badge connected' : 'status-badge disconnected';
  badge.innerHTML = `<span class="status-dot"></span> ${connected ? 'Connected' : 'Disconnected'}`;
}

// ============================================
// POSITION KEY
// ============================================
function extractPositionKey(folderName) {
  const parts = String(folderName).split('_');
  if (parts.length >= 5) return `${parts[1]}_${parts[2]}_${parts[3]}`;
  return folderName;
}

// ============================================
// PROCESS ENTRIES
// ============================================
function processEntries() {
  const positionCounters = {};
  processedEntries = allEntries.map((entry, index) => {
    const positionKey = extractPositionKey(entry.folderName);
    if (!positionCounters[positionKey]) positionCounters[positionKey] = 0;
    const positionVideoNum = positionCounters[positionKey]++;
    return { ...entry, seriesNum: index + 1, positionKey, positionVideoNum };
  });
}

// ============================================
// ANNOTATIONS CALCULATION
// ============================================
function calculateAnnotations(totalFrames, manualAnnotCount) {
  if (activeProjectType === 'bbox') {
    // bbox: user enters annotation count directly
    return manualAnnotCount || 0;
  }
  // video: auto-calculate
  return activeConfig.showAnnotations ? Number(totalFrames) * 3 : 0;
}

// ============================================
// ENTRY CRUD
// ============================================
function setEntryFormForEdit(entry) {
  editingEntryId = entry.id;
  document.getElementById('folderName').value  = entry.folderName || '';
  document.getElementById('totalFrames').value = entry.totalFrames || '';
  document.getElementById('videoStatus').value = entry.status || '';
  document.getElementById('videoNotes').value  = entry.notes || '';
  const annotInput = document.getElementById('totalAnnotationsInput');
  if (annotInput) annotInput.value = entry.totalAnnotations || '';
  const addBtn = document.getElementById('addBtn');
  addBtn.innerHTML = '✦ Update Entry';
  addBtn.setAttribute('data-mode', 'update');
  document.getElementById('cancelUpdateBtn').style.display = 'block';
}

function cancelEditEntry() {
  editingEntryId = null;
  ['folderName','totalFrames','videoStatus','videoNotes'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const annotInput = document.getElementById('totalAnnotationsInput');
  if (annotInput) annotInput.value = '';
  const addBtn = document.getElementById('addBtn');
  if (addBtn) { addBtn.innerHTML = '✦ Add Entry'; addBtn.removeAttribute('data-mode'); }
  const cancelBtn = document.getElementById('cancelUpdateBtn');
  if (cancelBtn) cancelBtn.style.display = 'none';
  clearFieldError('folderName');
  clearFieldError('totalFrames');
}

async function addEntry() {
  if (!activeProjectId) { showToast('No project selected.', 'error'); return; }

  const folderName  = document.getElementById('folderName').value.trim();
  const totalFrames = parseInt(document.getElementById('totalFrames').value, 10);
  const status      = document.getElementById('videoStatus').value;
  const notes       = document.getElementById('videoNotes').value.trim();
  const manualAnnot = parseInt(document.getElementById('totalAnnotationsInput')?.value || '0', 10);
  const totalAnnotations = calculateAnnotations(totalFrames, isNaN(manualAnnot) ? 0 : manualAnnot);

  let hasError = false;
  if (!folderName) { showFieldError('folderName', 'Folder name is required'); hasError = true; }
  else clearFieldError('folderName');
  if (isNaN(totalFrames) || totalFrames <= 0) { showFieldError('totalFrames', 'Enter a valid positive number'); hasError = true; }
  else clearFieldError('totalFrames');
  if (hasError) return;
  if (!isFirebaseConnected || !entriesRef) { showToast('Not connected!', 'error'); return; }

  const btn = document.getElementById('addBtn');
  btn.classList.add('loading');
  btn.innerHTML = '<div class="spinner"></div> Saving...';

  try {
    const payload = { folderName, totalFrames, totalAnnotations, status, notes };
    if (editingEntryId) {
      await db.ref(`projects/${activeProjectId}/annotations/${editingEntryId}`).update(payload);
      showToast(`Updated "${folderName}"!`, 'success');
    } else {
      await entriesRef.push({ ...payload, dateAdded: Date.now() });
      showToast(`Added "${folderName}"!`, 'success');
    }
    ['folderName','totalFrames','videoStatus','videoNotes'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const annotInput = document.getElementById('totalAnnotationsInput');
    if (annotInput) annotInput.value = '';
    editingEntryId = null;
    btn.innerHTML = '✦ Add Entry';
    document.getElementById('cancelUpdateBtn').style.display = 'none';
    btn.removeAttribute('data-mode');
  } catch (err) {
    console.error('Save error:', err);
    showToast('Failed to save entry.', 'error');
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
  document.getElementById('modalMessage').textContent = `Delete "${folderName}"? Cannot be undone.`;
  document.getElementById('modalOverlay').classList.add('active');
  document.getElementById('modalConfirmBtn').onclick = async () => {
    document.getElementById('modalOverlay').classList.remove('active');
    try {
      await db.ref(`projects/${activeProjectId}/annotations/${id}`).remove();
      if (editingEntryId === id) cancelEditEntry();
      showToast(`Deleted "${folderName}"`, 'info');
    } catch (err) { showToast('Failed to delete.', 'error'); }
  };
}

function confirmDeleteAll() {
  if (!processedEntries.length) { showToast('No entries to delete', 'info'); return; }
  document.getElementById('modalMessage').textContent =
    `Delete ALL ${processedEntries.length} entries in "${activeProjectName}"?`;
  document.getElementById('modalOverlay').classList.add('active');
  document.getElementById('modalConfirmBtn').onclick = async () => {
    document.getElementById('modalOverlay').classList.remove('active');
    try {
      await db.ref(`projects/${activeProjectId}/annotations`).set(null);
      showToast('All entries deleted', 'info');
    } catch (err) { showToast('Failed.', 'error'); }
  };
}

function closeModal() { document.getElementById('modalOverlay').classList.remove('active'); }

// ============================================
// FIELD VALIDATION
// ============================================
function showFieldError(fieldId, msg) {
  const input = document.getElementById(fieldId); if (!input) return;
  const err = input.parentElement.querySelector('.form-error');
  input.classList.add('error');
  if (err) { err.textContent = msg; err.classList.add('visible'); }
}
function clearFieldError(fieldId) {
  const input = document.getElementById(fieldId); if (!input) return;
  const err = input.parentElement.querySelector('.form-error');
  input.classList.remove('error');
  if (err) err.classList.remove('visible');
}

// ============================================
// RENDER DATA TABLE
// ============================================
function renderDataTable() {
  const tbody = document.getElementById('dataTableBody');
  if (!tbody) return;

  const isBbox    = activeProjectType === 'bbox';
  const showAnnot = activeConfig.showAnnotations;
  const annotTh   = document.getElementById('annotationsTh');
  if (annotTh) {
    annotTh.style.display = showAnnot ? '' : 'none';
    annotTh.textContent   = isBbox ? 'Bounding Boxes' : 'Annotations';
  }

  const searchTerm = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  const filtered   = processedEntries.filter(e => e.folderName.toLowerCase().includes(searchTerm));
  const sorted     = filtered.slice().sort((a,b) => {
    const dA = a.dateAdded||0, dB = b.dateAdded||0;
    return dataSortOrder === 'desc' ? dB-dA : dA-dB;
  });

  const colCount = showAnnot ? 8 : 7;

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}"><div class="empty-state">
      <div class="empty-state-icon">📋</div>
      <div class="empty-state-text">${searchTerm ? 'No matching entries' : 'No entries yet'}</div>
      <div class="empty-state-sub">${searchTerm ? 'Try a different search term' : 'Go to Home to add your first entry'}</div>
    </div></td></tr>`;
    const c = document.getElementById('entryCount'); if (c) c.textContent = '0 entries';
    return;
  }

  let totalFrames = 0, totalAnnotations = 0;
  let html = sorted.map(entry => {
    totalFrames      += (entry.totalFrames || 0);
    totalAnnotations += (entry.totalAnnotations || 0);
    const date = entry.dateAdded
      ? new Date(entry.dateAdded).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
      : '-';
    return `
      <tr class="${getStatusRowClass(entry.status)}">
        <td><span class="series-num">#${entry.seriesNum}</span></td>
        <td><span class="video-num">${entry.positionVideoNum}</span></td>
        <td><span class="folder-name">${entry.folderName}</span></td>
        <td><span class="num-frames">${(entry.totalFrames||0).toLocaleString()}</span></td>
        ${showAnnot ? `<td><span class="num-annot">${(entry.totalAnnotations||0).toLocaleString()}</span></td>` : ''}
        <td>
          <div class="table-status-cell">
            <select class="status-select status-${getStatusRowClass(entry.status).replace('status-row-','')}" onchange="updateEntryStatus('${entry.id}',this.value)">
              <option value="" ${!entry.status?'selected':''}>No status</option>
              <option value="Complete" ${entry.status==='Complete'?'selected':''}>Complete</option>
              <option value="In QA" ${entry.status==='In QA'?'selected':''}>In QA</option>
              <option value="Remaining" ${entry.status==='Remaining'?'selected':''}>Remaining</option>
              <option value="Wrong" ${entry.status==='Wrong'?'selected':''}>Wrong</option>
              <option value="Review" ${entry.status==='Review'?'selected':''}>Needs review</option>
            </select>
            ${entry.notes ? `<span class="table-note" title="${escapeHtml(entry.notes)}">${escapeHtml(entry.notes)}</span>` : ''}
          </div>
        </td>
        <td><span class="date-cell">${date}</span></td>
        <td>
          <div class="table-actions">
            <button class="table-action-btn" onclick="startEditEntry('${entry.id}')">Update</button>
            <button class="table-action-btn delete" onclick="confirmDelete('${entry.id}','${String(entry.folderName).replace(/'/g,"\\'")}')">Delete</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  html += `<tr class="table-summary">
    <td colspan="3"><strong>TOTALS</strong></td>
    <td><strong>${totalFrames.toLocaleString()}</strong></td>
    ${showAnnot ? `<td><strong>${totalAnnotations.toLocaleString()}</strong></td>` : ''}
    <td colspan="${colCount - (showAnnot ? 5 : 4)}"></td>
  </tr>`;

  tbody.innerHTML = html;
  const c = document.getElementById('entryCount');
  if (c) c.textContent = `${sorted.length} ${sorted.length===1?'entry':'entries'}`;
}

// ============================================
// RENDER RECENT ENTRIES
// ============================================
function renderRecentEntries() {
  const container = document.getElementById('recentEntries');
  if (!container) return;
  const isBbox  = activeProjectType === 'bbox';
  const recent  = processedEntries.slice(-5).reverse();

  if (!recent.length) {
    container.innerHTML = `<div class="empty-state" style="padding:30px 10px;">
      <div class="empty-state-icon">📭</div>
      <div class="empty-state-text">No entries yet</div>
      <div class="empty-state-sub">Add your first entry above!</div>
    </div>`; return;
  }

  container.innerHTML = recent.map(entry => `
    <div class="recent-item">
      <div class="recent-item-left">
        <div class="recent-item-num">${entry.seriesNum}</div>
        <div>
          <div class="recent-item-name">${entry.folderName}</div>
          <div class="recent-item-meta">${isBbox ? 'Folder' : 'Position'}: ${entry.positionKey} · #${entry.positionVideoNum}</div>
          ${entry.status||entry.notes ? `<div class="recent-item-note">
            ${entry.status ? `<span class="status-label status-${entry.status.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z-]/g,'')}">${escapeHtml(entry.status)}</span>` : ''}
            ${entry.notes ? ` ${escapeHtml(entry.notes)}` : ''}
          </div>` : ''}
        </div>
      </div>
      <div class="recent-item-right">
        <span class="recent-frames">${(entry.totalFrames||0).toLocaleString()} fr</span>
        ${activeConfig.showAnnotations ? `<span class="recent-annot">${(entry.totalAnnotations||0).toLocaleString()} ${isBbox?'bbox':'ann'}</span>` : ''}
      </div>
    </div>`).join('');
}

// ============================================
// HOME MINI STATS
// ============================================
function updateTotalStats() {
  const isBbox = activeProjectType === 'bbox';
  const totalVideos      = processedEntries.length;
  const totalFrames      = processedEntries.reduce((s,e) => s+(e.totalFrames||0), 0);
  const totalAnnotations = processedEntries.reduce((s,e) => s+(e.totalAnnotations||0), 0);

  const vEl = document.getElementById('homeTotalVideos');
  const fEl = document.getElementById('homeTotalFrames');
  const aEl = document.getElementById('homeTotalAnnotations');
  if (vEl) vEl.textContent = totalVideos;
  if (fEl) fEl.textContent = totalFrames.toLocaleString();
  if (aEl) aEl.textContent = totalAnnotations.toLocaleString();

  // Label the first mini stat correctly
  const videosLbl = document.getElementById('homeTotalVideosLbl');
  if (videosLbl) videosLbl.textContent = isBbox ? 'Folders' : 'Videos';

  const homeAnnotMiniStat = document.getElementById('homeAnnotMiniStat');
  if (homeAnnotMiniStat) {
    homeAnnotMiniStat.style.display = activeConfig.showAnnotations ? '' : 'none';
    const lbl = homeAnnotMiniStat.querySelector('.mini-stat-lbl');
    if (lbl) lbl.textContent = isBbox ? 'BBoxes' : 'Annotations';
  }
}

// ============================================
// RENDER DASHBOARD
// ============================================
function renderDashboard() {
  const isBbox         = activeProjectType === 'bbox';
  const totalVideos    = processedEntries.length;
  const totalFrames    = processedEntries.reduce((s,e)=>s+(e.totalFrames||0),0);
  const totalAnnotations = processedEntries.reduce((s,e)=>s+(e.totalAnnotations||0),0);
  const avgFrames      = totalVideos > 0 ? Math.round(totalFrames/totalVideos) : 0;

  const dvEl   = document.getElementById('dashTotalVideos');
  const dfEl   = document.getElementById('dashTotalFrames');
  const daEl   = document.getElementById('dashTotalAnnotations');
  const davgEl = document.getElementById('dashAvgFrames');
  if (dvEl)   dvEl.textContent   = totalVideos;
  if (dfEl)   dfEl.textContent   = totalFrames.toLocaleString();
  if (daEl)   daEl.textContent   = totalAnnotations.toLocaleString();
  if (davgEl) davgEl.textContent = avgFrames.toLocaleString();

  // Update label for Videos stat card
  const videosLabel = document.getElementById('dashVideosLabel');
  if (videosLabel) videosLabel.textContent = isBbox ? 'Total Folders' : 'Total Videos';
  const videosIcon = document.getElementById('dashVideosIcon');
  if (videosIcon) videosIcon.textContent = isBbox ? '📂' : '🎬';

  // Annotations stat card
  const annotStatCard = document.getElementById('dashAnnotStatCard');
  if (annotStatCard) {
    annotStatCard.style.display = activeConfig.showAnnotations ? '' : 'none';
    const lbl  = annotStatCard.querySelector('.stat-card-label');
    const icon = annotStatCard.querySelector('.stat-card-icon');
    if (lbl)  lbl.textContent  = isBbox ? 'Total BBoxes' : 'Total Annotations';
    if (icon) icon.textContent = isBbox ? '🟦' : '🏷️';
  }

  renderPositionBreakdown();
  renderDashboardNotes();
  renderMinutesTracker();
  renderCharts();
}

// ============================================
// MINUTES TRACKER
// ============================================
function renderMinutesTracker() {
  const cfg = activeConfig;
  const minutesCard = document.querySelector('.minutes-tracker-card');
  if (minutesCard) minutesCard.style.display = cfg.showMinutesTracker ? '' : 'none';
  if (!cfg.showMinutesTracker) return;

  const TARGET = Number(cfg.targetMinutes) || 1200;
  const FPS    = Number(cfg.fps) || 15;

  const completeEntries  = processedEntries.filter(e => e.status === 'Complete');
  const totalFrames      = completeEntries.reduce((s,e) => s+(e.totalFrames||0), 0);
  const totalVideos      = completeEntries.length;
  const minutesCompleted = totalFrames / (FPS * 60);
  const minutesRemaining = Math.max(0, TARGET - minutesCompleted);
  const pct              = Math.min(100, (minutesCompleted / TARGET) * 100);

  ['dashMinutesCompleted','dashMinutesRemaining','dashMinutesPercent',
   'dashTotalFramesMinutes','dashTotalVideosMinutes','dashFpsLabel',
   'dashMinutesCompletedLabel'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    if (id === 'dashMinutesCompleted')      el.textContent = minutesCompleted.toFixed(2);
    if (id === 'dashMinutesRemaining')      el.textContent = minutesRemaining.toFixed(2);
    if (id === 'dashMinutesPercent')        el.textContent = pct.toFixed(2) + '%';
    if (id === 'dashTotalFramesMinutes')    el.textContent = totalFrames.toLocaleString();
    if (id === 'dashTotalVideosMinutes')    el.textContent = totalVideos;
    if (id === 'dashFpsLabel')              el.textContent = FPS + ' fps';
    if (id === 'dashMinutesCompletedLabel') el.textContent = minutesCompleted.toFixed(2) + ' min completed';
  });

  const mfEl = document.getElementById('dashMinutesFill');
  const mgEl = document.getElementById('dashMinutesGlow');
  if (mfEl) { mfEl.style.width = pct+'%'; }
  if (mgEl) { mgEl.style.width = pct+'%'; }

  const targetLabel = document.querySelector('.minutes-tracker-target');
  if (targetLabel) targetLabel.textContent = `Target: ${TARGET.toLocaleString()} min`;
  const endLabel = document.querySelector('.minutes-progress-labels span:last-child');
  if (endLabel) endLabel.textContent = `${TARGET.toLocaleString()} min`;

  if (mfEl) {
    if (pct>=100)      mfEl.style.background='linear-gradient(90deg,#10b981,#059669)';
    else if (pct>=75)  mfEl.style.background='linear-gradient(90deg,#2a9d8f,#10b981)';
    else if (pct>=50)  mfEl.style.background='linear-gradient(90deg,#1d3557,#2a9d8f)';
    else               mfEl.style.background='linear-gradient(90deg,#1d3557,#457b9d)';
  }
}

// ============================================
// DASHBOARD NOTES
// ============================================
function renderDashboardNotes() {
  const container  = document.getElementById('dashboardNotes');
  const pagination = document.getElementById('dashboardPagination');
  if (!container) return;

  const annotated = processedEntries.filter(e => e.status||e.notes).slice().reverse();
  if (!annotated.length) {
    container.innerHTML = '<div class="empty-state" style="padding:32px;"><div class="empty-state-icon">✎</div><div class="empty-state-text">No notes or statuses yet</div></div>';
    if (pagination) pagination.hidden = true;
    return;
  }

  const totalPages   = Math.ceil(annotated.length / dashboardNotesPerPage);
  dashboardNotesPage = Math.min(dashboardNotesPage, totalPages);
  const start        = (dashboardNotesPage-1) * dashboardNotesPerPage;
  const visible      = annotated.slice(start, start+dashboardNotesPerPage);

  container.innerHTML = visible.map(entry => `
    <div class="dashboard-note-item">
      <div>
        <div class="dashboard-note-folder">${escapeHtml(entry.folderName)}</div>
        <div class="dashboard-note-position">${activeProjectType==='bbox'?'Folder':'Position'}: ${escapeHtml(entry.positionKey)} · #${entry.positionVideoNum}</div>
      </div>
      <div class="dashboard-note-content">
        ${entry.status ? `<span class="status-label status-${entry.status.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z-]/g,'')}">${escapeHtml(entry.status)}</span>` : ''}
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

function changeDashboardNotesPage(direction) { dashboardNotesPage += direction; renderDashboardNotes(); }

// ============================================
// HELPERS
// ============================================
function escapeHtml(value) {
  return String(value??'').replace(/[&<>'"]/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function getStatusRowClass(status) {
  return status ? `status-row-${String(status).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z-]/g,'')}` : '';
}

async function updateEntryStatus(id, status) {
  if (!db) return;
  try {
    await db.ref(`projects/${activeProjectId}/annotations/${id}`).update({ status });
    showToast('Status updated', 'success');
  } catch (err) { showToast('Failed to update status.', 'error'); }
}

// ============================================
// POSITION BREAKDOWN
// ============================================
function renderPositionBreakdown() {
  const tbody   = document.getElementById('positionBreakdown');
  const posCard = document.getElementById('positionBreakdownCard');
  if (posCard) posCard.style.display = activeConfig.showPositionBreakdown ? '' : 'none';
  if (!tbody || !activeConfig.showPositionBreakdown) return;

  const map = {};
  processedEntries.forEach(e => {
    if (!map[e.positionKey]) map[e.positionKey] = {videos:0,frames:0,annotations:0};
    map[e.positionKey].videos++;
    map[e.positionKey].frames      += (e.totalFrames||0);
    map[e.positionKey].annotations += (e.totalAnnotations||0);
  });

  const keys = Object.keys(map);
  if (!keys.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:30px;">No data</td></tr>`;
    return;
  }
  tbody.innerHTML = keys.map(k => `
    <tr>
      <td><span class="position-badge">${k}</span></td>
      <td><strong>${map[k].videos}</strong></td>
      <td>${map[k].frames.toLocaleString()}</td>
      <td>${map[k].annotations.toLocaleString()}</td>
    </tr>`).join('');
}

// ============================================
// CHARTS
// ============================================
function renderCharts() {
  if (typeof Chart === 'undefined') return;
  const chartsGrid = document.querySelector('.charts-grid');
  if (chartsGrid) chartsGrid.style.display = activeConfig.showPositionBreakdown ? '' : 'none';
  if (!activeConfig.showPositionBreakdown) return;

  const map = {};
  processedEntries.forEach(e => {
    if (!map[e.positionKey]) map[e.positionKey] = {frames:0,annotations:0};
    map[e.positionKey].frames      += (e.totalFrames||0);
    map[e.positionKey].annotations += (e.totalAnnotations||0);
  });

  const labels    = Object.keys(map);
  const framesD   = labels.map(k=>map[k].frames);
  const annotD    = labels.map(k=>map[k].annotations);
  const colors = ['rgba(29,53,87,0.88)','rgba(42,157,143,0.88)','rgba(69,123,157,0.88)',
    'rgba(233,196,106,0.95)','rgba(231,111,81,0.88)','rgba(76,114,145,0.88)',
    'rgba(38,166,154,0.88)','rgba(120,144,166,0.88)'];
  const borders = colors.map(c=>c.replace(/0\.8[85]/,'1'));

  const fCanvas = document.getElementById('framesChart');
  if (fCanvas) {
    if (framesChart) framesChart.destroy();
    framesChart = new Chart(fCanvas.getContext('2d'), {
      type:'doughnut',
      data:{labels:labels.length?labels:['No Data'],datasets:[{
        data:framesD.length?framesD:[1],
        backgroundColor:framesD.length?colors.slice(0,labels.length):['rgba(148,163,184,0.35)'],
        borderColor:framesD.length?borders.slice(0,labels.length):['rgba(100,116,139,0.6)'],
        borderWidth:2,hoverOffset:10}]},
      options:{responsive:true,maintainAspectRatio:true,cutout:'65%',
        plugins:{legend:{position:'bottom',labels:{color:'#334155',font:{family:'Inter',size:12,weight:'600'},padding:18,usePointStyle:true,pointStyleWidth:8}}}}
    });
  }

  const aCanvas = document.getElementById('annotationsChart');
  if (aCanvas) {
    if (annotationsChart) annotationsChart.destroy();
    annotationsChart = new Chart(aCanvas.getContext('2d'), {
      type:'bar',
      data:{labels:labels.length?labels:['No Data'],datasets:[{
        label:'Annotations',data:annotD.length?annotD:[0],
        backgroundColor:annotD.length?colors.slice(0,labels.length):['rgba(148,163,184,0.35)'],
        borderColor:annotD.length?borders.slice(0,labels.length):['rgba(100,116,139,0.6)'],
        borderWidth:0,borderRadius:8,borderSkipped:false,barThickness:'flex',maxBarThickness:36}]},
      options:{responsive:true,maintainAspectRatio:true,
        scales:{x:{ticks:{color:'#334155',font:{family:'Inter',size:11,weight:'600'}},grid:{color:'rgba(15,23,42,0.07)',drawBorder:false}},
                y:{beginAtZero:true,ticks:{color:'#334155',font:{family:'Inter',size:11,weight:'600'}},grid:{color:'rgba(15,23,42,0.07)',drawBorder:false}}},
        plugins:{legend:{display:false}}}
    });
  }
}

// ============================================
// TOAST
// ============================================
function showToast(message, type='info') {
  const c = document.getElementById('toastContainer'); if (!c) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-dot"></span> ${message}`;
  t.style.cssText = 'animation-duration:0.4s,0.4s;animation-delay:0s,3s;';
  c.appendChild(t);
  setTimeout(()=>t.remove(), 3400);
}

// ============================================
// NAVIGATION
// ============================================
function navigateTo(pageId) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById(pageId)?.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${pageId}"]`)?.classList.add('active');
  const titles = {homePage:'Home',dataPage:'Data',dashboardPage:'Dashboard'};
  const el = document.getElementById('pageTitle');
  if (el) el.textContent = titles[pageId]||'Home';
  closeSidebar();
  if (pageId==='dashboardPage') setTimeout(()=>renderCharts(),120);
}

// ============================================
// SORT
// ============================================
function toggleSortOrder() {
  dataSortOrder = dataSortOrder==='desc'?'asc':'desc';
  const btn=document.getElementById('sortToggleBtn');
  const lbl=document.getElementById('sortLabel');
  const arr=document.getElementById('sortArrows');
  if (dataSortOrder==='asc') {
    btn?.classList.add('sort-asc');
    if(lbl) lbl.textContent='Oldest First';
    if(arr) arr.textContent='↑';
  } else {
    btn?.classList.remove('sort-asc');
    if(lbl) lbl.textContent='Latest First';
    if(arr) arr.textContent='↓';
  }
  renderDataTable();
}

// ============================================
// SIDEBAR TOGGLE
// ============================================
function toggleSidebar() {
  const s=document.querySelector('.sidebar'), o=document.querySelector('.sidebar-overlay');
  const open=s.classList.toggle('open');
  o.classList.toggle('active',open);
  document.body.classList.toggle('sidebar-open',open);
  document.body.style.overflow=open?'hidden':'';
}
function closeSidebar() {
  document.querySelector('.sidebar')?.classList.remove('open');
  document.querySelector('.sidebar-overlay')?.classList.remove('active');
  document.body.classList.remove('sidebar-open');
  document.body.style.overflow='';
}

// ============================================
// SEARCH & CSV
// ============================================
function handleSearch() { renderDataTable(); }

function exportCSV() {
  if (!processedEntries.length) { showToast('No data to export','info'); return; }
  const isBbox = activeProjectType==='bbox';
  const headers = ['Series #','#','Folder Name','Frames', isBbox?'Bounding Boxes':'Annotations','Status','Notes','Date'];
  const rows = processedEntries.map(e => [
    e.seriesNum, e.positionVideoNum, `"${e.folderName}"`, e.totalFrames, e.totalAnnotations,
    `"${String(e.status||'').replace(/"/g,'""')}"`,
    `"${String(e.notes||'').replace(/"/g,'""')}"`,
    e.dateAdded ? new Date(e.dateAdded).toLocaleDateString() : ''
  ]);
  const tf = processedEntries.reduce((s,e)=>s+(e.totalFrames||0),0);
  const ta = processedEntries.reduce((s,e)=>s+(e.totalAnnotations||0),0);
  const summary = [[],['SUMMARY'],['Project',activeProjectName||''],['Type',activeProjectType],
    ['Total Entries',processedEntries.length],['Total Frames',tf],[isBbox?'Total BBoxes':'Total Annotations',ta],
    ['Complete',processedEntries.filter(e=>e.status==='Complete').length]];
  const csv = [headers.join(','),...rows.map(r=>r.join(',')),...summary.map(r=>r.join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  const a = document.createElement('a');
  a.href=url; a.download=`cvat_${(activeProjectName||'project').replace(/\s+/g,'_')}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
  showToast('CSV exported!','success');
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();
  document.getElementById('folderName')?.addEventListener('keydown', e=>{if(e.key==='Enter')addEntry();});
  document.getElementById('totalFrames')?.addEventListener('keydown', e=>{if(e.key==='Enter')addEntry();});
  document.getElementById('projectModalOverlay')?.addEventListener('click', e=>{
    if(e.target===document.getElementById('projectModalOverlay')) closeProjectModal();
  });
  document.querySelectorAll('.nav-item').forEach(item=>{
    item.addEventListener('touchend',function(e){
      e.preventDefault();
      const p=this.getAttribute('data-page'); if(p) navigateTo(p);
    },{passive:false});
  });
});
