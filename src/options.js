const DEFAULT_FTP = 250;

// ---------------- FTP logic (unchanged) ----------------

function clampFtp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_FTP;
  return Math.min(500, Math.max(50, Math.round(n)));
}

function loadFtp() {
  if (!chrome || !chrome.storage || !chrome.storage.sync) {
    document.getElementById("ftpInput").value = DEFAULT_FTP;
    return;
  }

  chrome.storage.sync.get({ftp: DEFAULT_FTP}, (data) => {
    const v = clampFtp(data.ftp);
    document.getElementById("ftpInput").value = v;
  });
}

function saveFtp() {
  const statusEl = document.getElementById("status");
  try {
    if (!chrome || !chrome.storage || !chrome.storage.sync) {
      statusEl.textContent = "Storage unavailable.";
      statusEl.className = "status error";
      return;
    }
  } catch {
    statusEl.textContent = "Storage unavailable.";
    statusEl.className = "status error";
    return;
  }

  const raw = document.getElementById("ftpInput").value;
  const ftp = clampFtp(raw);

  chrome.storage.sync.set({ftp}, () => {
    statusEl.textContent = "Saved";
    statusEl.className = "status saved";
    setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "status";
    }, 1500);
  });
}

// ---------------- Directory + workout manager ----------------

const DB_NAME = "zwo-downloader";
const DB_VERSION = 1;
let dbPromise = null;
let currentDirHandle = null;
let currentWorkouts = [];

// Small helper to open IndexedDB
function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", {keyPath: "key"});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function saveDirectoryHandle(handle) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    const store = tx.objectStore("settings");
    const value = {
      key: "dirHandle",
      handle
    };
    store.put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadDirectoryHandle() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const store = tx.objectStore("settings");
    const req = store.get("dirHandle");
    req.onsuccess = () => {
      resolve(req.result ? req.result.handle : null);
    };
    req.onerror = () => reject(req.error);
  });
}

// Request permission to read/write the folder
async function ensureDirPermission(handle) {
  if (!handle) return false;
  if (!handle.queryPermission || !handle.requestPermission) return true;

  const current = await handle.queryPermission({mode: "readwrite"});
  if (current === "granted") return true;
  if (current === "denied") return false;

  const result = await handle.requestPermission({mode: "readwrite"});
  return result === "granted";
}

// Scan the folder for .zwo files and parse metadata
async function scanWorkoutsFromDirectory(handle) {
  const workouts = [];
  try {
    for await (const entry of handle.values()) {
      if (entry.kind !== "file") continue;
      if (!entry.name.toLowerCase().endsWith(".zwo")) continue;

      const file = await entry.getFile();
      const text = await file.text();
      const meta = parseZwo(text, entry.name);
      workouts.push(meta);
    }
  } catch (err) {
    console.error("[ZWO Options] Error scanning workouts:", err);
  }
  return workouts;
}

// Basic ZWO XML parsing
function parseZwo(xmlText, fileName) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  const nameEl = doc.querySelector("workout_file > name");
  const catEl = doc.querySelector("workout_file > category");
  const descEl = doc.querySelector("workout_file > description");
  const tagEls = Array.from(doc.querySelectorAll("workout_file > tags > tag"));

  const name = (nameEl && nameEl.textContent.trim()) || fileName;
  const category = (catEl && catEl.textContent.trim()) || "Uncategorized";
  const description = descEl ? descEl.textContent || "" : "";

  const tags = tagEls
    .map((t) => t.getAttribute("name") || "")
    .filter(Boolean);

  let source = null;
  let tss = null;
  let ifValue = null;
  let durationMin = null;

  for (const tag of tags) {
    const trimmed = tag.trim();
    if (/^TrainerRoad$/i.test(trimmed)) source = "TrainerRoad";
    else if (/^TrainerDay$/i.test(trimmed)) source = "TrainerDay";
    else if (/^WhatsOnZwift$/i.test(trimmed)) source = "WhatsOnZwift";

    const tssMatch = trimmed.match(/^TSS\s+(\d+)/i);
    if (tssMatch) {
      tss = Number(tssMatch[1]);
    }

    const ifMatch = trimmed.match(/^IF\s+([\d.]+)/i);
    if (ifMatch) {
      ifValue = Number(ifMatch[1]);
    }

    const durMatch = trimmed.match(/^Duration:(\d+)min/i);
    if (durMatch) {
      durationMin = Number(durMatch[1]);
    }
  }

  return {
    fileName,
    name,
    category,
    description,
    tags,
    source: source || "Unknown",
    tss: Number.isFinite(tss) ? tss : null,
    ifValue: Number.isFinite(ifValue) ? ifValue : null,
    durationMin: Number.isFinite(durationMin) ? durationMin : null
  };
}

// Render Workout Manager table
function renderWorkoutManager() {
  const tbody = document.getElementById("workoutTbody");
  const searchInput = document.getElementById("searchInput");
  const categoryFilter = document.getElementById("categoryFilter");
  const summaryEl = document.getElementById("managerSummary");

  const searchTerm = (searchInput.value || "").toLowerCase();
  const cat = categoryFilter.value || "";

  let shown = currentWorkouts;

  if (cat) {
    shown = shown.filter((w) => w.category === cat);
  }

  if (searchTerm) {
    shown = shown.filter((w) => {
      const haystack = [
        w.name,
        w.category,
        w.source,
        w.tags.join(" "),
        (w.description || "").slice(0, 200)
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(searchTerm);
    });
  }

  // Sort by name for consistency
  shown = shown.slice().sort((a, b) => a.name.localeCompare(b.name));

  tbody.innerHTML = "";
  for (const w of shown) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = w.name;
    tdName.title = w.fileName;
    tr.appendChild(tdName);

    const tdCat = document.createElement("td");
    tdCat.textContent = w.category;
    tr.appendChild(tdCat);

    const tdSource = document.createElement("td");
    tdSource.textContent = w.source;
    tr.appendChild(tdSource);

    const tdIf = document.createElement("td");
    tdIf.textContent = w.ifValue != null ? w.ifValue.toFixed(2) : "";
    tr.appendChild(tdIf);

    const tdTss = document.createElement("td");
    tdTss.textContent = w.tss != null ? String(w.tss) : "";
    tr.appendChild(tdTss);

    const tdDur = document.createElement("td");
    tdDur.textContent =
      w.durationMin != null ? `${Math.round(w.durationMin)} min` : "";
    tr.appendChild(tdDur);

    const tdTags = document.createElement("td");
    for (const tag of w.tags.slice(0, 4)) {
      const span = document.createElement("span");
      span.className = "tag-pill";
      span.textContent = tag;
      tdTags.appendChild(span);
    }
    if (w.tags.length > 4) {
      const more = document.createElement("span");
      more.className = "tag-pill";
      more.textContent = `+${w.tags.length - 4}`;
      tdTags.appendChild(more);
    }
    tr.appendChild(tdTags);

    tbody.appendChild(tr);
  }

  const total = currentWorkouts.length;
  const shownCount = shown.length;
  summaryEl.textContent =
    total === 0
      ? "No .zwo files found in this folder yet."
      : `${shownCount} of ${total} workouts shown`;
}

// Build category filter options from currentWorkouts
function refreshCategoryFilter() {
  const select = document.getElementById("categoryFilter");
  const valueBefore = select.value;

  const cats = Array.from(
    new Set(currentWorkouts.map((w) => w.category || "Uncategorized"))
  ).sort((a, b) => a.localeCompare(b));

  select.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "All categories";
  select.appendChild(optAll);

  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    select.appendChild(opt);
  }

  if (cats.includes(valueBefore)) {
    select.value = valueBefore;
  }
}

// Initialize folder UI + manager
async function initDirectoryAndManager() {
  const dirSupportNote = document.getElementById("dirSupportNote");
  const dirCurrentEl = document.getElementById("dirCurrent");
  const workoutManager = document.getElementById("workoutManager");
  const chooseDirBtn = document.getElementById("chooseDirBtn");
  const rescanBtn = document.getElementById("rescanBtn");

  if (!("showDirectoryPicker" in window)) {
    dirSupportNote.textContent = "Folder selection requires a recent Chromium-based browser.";
    chooseDirBtn.disabled = true;
    rescanBtn.disabled = true;
    workoutManager.classList.add("hidden");
    return;
  } else {
    dirSupportNote.textContent = "";
  }

  // Load existing handle if present
  try {
    const handle = await loadDirectoryHandle();
    if (handle) {
      const ok = await ensureDirPermission(handle);
      if (ok) {
        currentDirHandle = handle;
        dirCurrentEl.textContent = `Current folder: ${handle.name || "(selected folder)"}`;
        await rescanWorkouts();
      } else {
        dirCurrentEl.textContent = "Folder permission not granted. Please choose a folder.";
        workoutManager.classList.add("hidden");
      }
    } else {
      dirCurrentEl.textContent = "No folder selected yet.";
      workoutManager.classList.add("hidden");
    }
  } catch (err) {
    console.error("[ZWO Options] Error loading directory handle:", err);
    dirCurrentEl.textContent = "No folder selected yet.";
  }

  chooseDirBtn.addEventListener("click", async () => {
    try {
      const handle = await window.showDirectoryPicker();
      const ok = await ensureDirPermission(handle);
      if (!ok) {
        dirCurrentEl.textContent = "Permission denied for selected folder.";
        workoutManager.classList.add("hidden");
        return;
      }
      currentDirHandle = handle;
      await saveDirectoryHandle(handle);
      dirCurrentEl.textContent = `Current folder: ${handle.name || "(selected folder)"}`;
      await rescanWorkouts();
    } catch (err) {
      if (err && err.name === "AbortError") {
        // User cancelled folder picker
        return;
      }
      console.error("[ZWO Options] Error choosing directory:", err);
      dirCurrentEl.textContent = "Failed to choose folder.";
    }
  });

  rescanBtn.addEventListener("click", async () => {
    await rescanWorkouts();
  });

  // Hook filters
  document.getElementById("searchInput").addEventListener("input", () => {
    renderWorkoutManager();
  });
  document.getElementById("categoryFilter").addEventListener("change", () => {
    renderWorkoutManager();
  });
}

async function rescanWorkouts() {
  const workoutManager = document.getElementById("workoutManager");
  const dirCurrentEl = document.getElementById("dirCurrent");

  if (!currentDirHandle) {
    workoutManager.classList.add("hidden");
    dirCurrentEl.textContent = "No folder selected yet.";
    return;
  }

  const ok = await ensureDirPermission(currentDirHandle);
  if (!ok) {
    workoutManager.classList.add("hidden");
    dirCurrentEl.textContent = "Folder permission lost. Please choose again.";
    return;
  }

  dirCurrentEl.textContent = `Current folder: ${currentDirHandle.name || "(selected folder)"}`;

  currentWorkouts = await scanWorkoutsFromDirectory(currentDirHandle);
  if (currentWorkouts.length === 0) {
    workoutManager.classList.remove("hidden");
    refreshCategoryFilter();
    renderWorkoutManager();
  } else {
    workoutManager.classList.remove("hidden");
    refreshCategoryFilter();
    renderWorkoutManager();
  }
}

// ---------------- init ----------------

document.addEventListener("DOMContentLoaded", () => {
  loadFtp();
  document.getElementById("saveBtn").addEventListener("click", saveFtp);

  initDirectoryAndManager().catch((err) => {
    console.error("[ZWO Options] init error:", err);
  });
});

