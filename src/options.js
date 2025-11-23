const DEFAULT_FTP = 250;

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

document.addEventListener("DOMContentLoaded", () => {
  loadFtp();
  document.getElementById("saveBtn").addEventListener("click", saveFtp);
});

