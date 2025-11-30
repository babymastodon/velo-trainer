// workout-builder.js

import {renderMiniWorkoutGraph} from "./workout-chart.js";
import {
  computeMetricsFromSegments,
  inferZoneFromSegments,
} from "./workout-metrics.js";
import {
  saveWorkoutBuilderState,
  loadWorkoutBuilderState,
} from "./storage.js";
import {
  parseZwoSnippet,
  segmentsToZwoSnippet,
} from "./zwo.js";
import {importWorkoutFromUrl} from "./scrapers.js";

/**
 * @typedef WorkoutBuilderOptions
 * @property {HTMLElement} rootEl
 * @property {() => number} getCurrentFtp
 */

export function createWorkoutBuilder(options) {
  const {rootEl, getCurrentFtp} = options;
  if (!rootEl) throw new Error("[WorkoutBuilder] rootEl is required");

  // ---------- State ----------
  /** @type {Array<[number, number, number]>} */ // [minutes, startPct, endPct]
  let currentRawSegments = [];
  let currentErrors = [];
  let currentMetrics = null;
  let currentZone = null;

  // ---------- Layout ----------
  rootEl.innerHTML = "";
  rootEl.classList.add("workout-builder-root");

  const wrapper = document.createElement("div");
  wrapper.className = "workout-builder";

  const body = document.createElement("div");
  body.className = "workout-builder-body";

  const colMeta = document.createElement("section");
  colMeta.className = "workout-builder-col wb-col-meta";

  const colCode = document.createElement("section");
  colCode.className = "workout-builder-col wb-col-code";

  body.appendChild(colMeta);
  body.appendChild(colCode);
  wrapper.appendChild(body);
  rootEl.appendChild(wrapper);

  // ---------- Column 1: metadata + stats + chart ----------

  // Metadata card
  const metaCard = document.createElement("div");
  metaCard.className = "wb-card wb-meta-card";

  const metaFields = document.createElement("div");
  metaFields.className = "wb-meta-fields";

  const nameField = createLabeledInput("Name");
  const sourceField = createLabeledInput("Author / Source");
  const descField = createLabeledTextarea("Description");

  descField.textarea.addEventListener("input", () => {
    autoGrowTextarea(descField.textarea);
  });

  metaFields.appendChild(nameField.wrapper);
  metaFields.appendChild(sourceField.wrapper);
  metaFields.appendChild(descField.wrapper);

  // Stats
  const statsRow = document.createElement("div");
  statsRow.className = "wb-stats-row";

  const statTss = createStatChip("TSS");
  const statIf = createStatChip("IF");
  const statKj = createStatChip("kJ");
  const statDuration = createStatChip("Duration");
  const statFtp = createStatChip("FTP");
  const statZone = createStatChip("Zone");

  [
    statTss.el,
    statIf.el,
    statKj.el,
    statDuration.el,
    statFtp.el,
    statZone.el,
  ].forEach((el) => statsRow.appendChild(el));

  metaCard.appendChild(metaFields);
  metaCard.appendChild(statsRow);

  // Chart card
  const chartCard = document.createElement("div");
  chartCard.className = "wb-card wb-chart-card";

  const chartTitle = document.createElement("div");
  chartTitle.className = "wb-section-title";
  chartTitle.textContent = "Workout preview";

  const chartContainer = document.createElement("div");
  chartContainer.className = "wb-chart-container";

  const chartMiniHost = document.createElement("div");
  chartMiniHost.className = "wb-chart-mini-host";

  chartContainer.appendChild(chartMiniHost);
  chartCard.appendChild(chartTitle);
  chartCard.appendChild(chartContainer);

  colMeta.appendChild(metaCard);
  colMeta.appendChild(chartCard);

  // ---------- Column 2: ZWO editor + error + URL import ----------

  // Status bar
  const statusCard = document.createElement("div");
  statusCard.className = "wb-card wb-code-card";

  const errorRow = document.createElement("div");
  errorRow.className = "wb-code-error-row";

  const errorLabel = document.createElement("div");
  errorLabel.className = "wb-code-error-label";
  errorLabel.textContent = "Status:";

  const errorMessage = document.createElement("div");
  errorMessage.className =
    "wb-code-error-message wb-code-error-message--neutral";
  errorMessage.textContent = "Not checked yet.";

  errorRow.appendChild(errorLabel);
  errorRow.appendChild(errorMessage);
  statusCard.appendChild(errorRow);

  colCode.appendChild(statusCard);

  // URL import card
  const importCard = document.createElement("div");
  importCard.className = "wb-card wb-code-card";
  const urlSection = document.createElement("div");
  urlSection.className = "wb-url-section";

  const urlTitle = document.createElement("div");
  urlTitle.className = "wb-section-title";
  urlTitle.innerHTML = `Import from URL - <a href="https://whatsonzwift.com/workouts" target="_blank" rel="noopener noreferrer">WhatsOnZwift</a> or <a href="https://app.trainerday.com/search" target="_blank" rel="noopener noreferrer">TrainerDay</a>`;

  const urlRow = document.createElement("div");
  urlRow.className = "wb-url-row";

  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.placeholder =
    "Paste a TrainerDay / WhatsOnZwift workout URL";
  urlInput.className = "wb-url-input";

  const urlBtn = document.createElement("button");
  urlBtn.type = "button";
  urlBtn.className = "picker-add-btn";

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.classList.add("wb-code-icon");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");

  const path1 = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  path1.setAttribute("d", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4");

  const path2 = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline",
  );
  path2.setAttribute("points", "7 10 12 15 17 10");

  const path3 = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "line",
  );
  path3.setAttribute("x1", "12");
  path3.setAttribute("y1", "3");
  path3.setAttribute("x2", "12");
  path3.setAttribute("y2", "15");

  icon.appendChild(path1);
  icon.appendChild(path2);
  icon.appendChild(path3);

  const textSpan = document.createElement("span");
  textSpan.textContent = "Import";

  urlBtn.appendChild(icon);
  urlBtn.appendChild(textSpan);

  urlRow.appendChild(urlInput);
  urlRow.appendChild(urlBtn);
  urlSection.appendChild(urlTitle);
  urlSection.appendChild(urlRow);

  importCard.appendChild(urlSection);
  colCode.appendChild(importCard);

  // Toolbar with ZWO elements
  const codeCard = document.createElement("div");
  codeCard.className = "wb-card wb-code-card";

  const toolbar = document.createElement("div");
  toolbar.className = "wb-code-toolbar";

  const toolbarLabel = document.createElement("div");
  toolbarLabel.className = "wb-code-toolbar-label";
  toolbarLabel.textContent = "Workout";

  const toolbarButtons = document.createElement("div");
  toolbarButtons.className = "wb-code-toolbar-buttons";

  const buttonSpecs = [
    {
      key: "steady",
      label: "SteadyState",
      snippet: '<SteadyState Duration="300" Power="0.75" />',
      icon: "steady",
    },
    {
      key: "warmup",
      label: "Warmup",
      snippet:
        '<Warmup Duration="600" PowerLow="0.50" PowerHigh="0.75" />',
      icon: "rampUp",
    },
    {
      key: "cooldown",
      label: "Cooldown",
      snippet:
        '<Cooldown Duration="600" PowerLow="0.75" PowerHigh="0.50" />',
      icon: "rampDown",
    },
    {
      key: "intervals",
      label: "IntervalsT",
      snippet:
        '<IntervalsT Repeat="3" OnDuration="300" OffDuration="180" OnPower="0.90" OffPower="0.50" />',
      icon: "intervals",
    },
  ];

  buttonSpecs.forEach((spec) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wb-code-insert-btn";
    btn.dataset.key = spec.key;

    if (spec.icon) {
      const iconEl = createWorkoutElementIcon(spec.icon);
      btn.appendChild(iconEl);
    }

    const labelSpan = document.createElement("span");
    labelSpan.textContent = spec.label;
    btn.appendChild(labelSpan);

    btn.addEventListener("click", () => {
      insertSnippetAtCursor(codeTextarea, spec.snippet);
      handleAnyChange();
    });

    toolbarButtons.appendChild(btn);
  });

  toolbar.appendChild(toolbarLabel);
  toolbar.appendChild(toolbarButtons);

  const textareaWrapper = document.createElement("div");
  textareaWrapper.className = "wb-code-textarea-wrapper";

  const codeWrapper = document.createElement("div");
  codeWrapper.className = "wb-code-wrapper";

  const codeHighlights = document.createElement("div");
  codeHighlights.className = "wb-code-highlights";

  const codeTextarea = document.createElement("textarea");
  codeTextarea.className = "wb-code-textarea";
  codeTextarea.spellcheck = false;
  codeTextarea.rows = 18;
  codeTextarea.placeholder =
    "Click the above buttons to add workout blocks.";
  codeTextarea.addEventListener("input", () =>
    autoGrowTextarea(codeTextarea),
  );
  codeTextarea.addEventListener("scroll", () => {
    codeHighlights.scrollTop = codeTextarea.scrollTop;
    codeHighlights.scrollLeft = codeTextarea.scrollLeft;
  });

  codeWrapper.appendChild(codeHighlights);
  codeWrapper.appendChild(codeTextarea);
  textareaWrapper.appendChild(codeWrapper);

  codeCard.appendChild(toolbar);
  codeCard.appendChild(textareaWrapper);

  colCode.appendChild(codeCard);

  // ---------- Events ----------

  codeTextarea.addEventListener("input", () => {
    handleAnyChange();
  });
  codeTextarea.addEventListener("click", () => {
    updateErrorMessageForCaret();
  });
  codeTextarea.addEventListener("keyup", () => {
    updateErrorMessageForCaret();
  });

  [nameField.input, sourceField.input, descField.textarea].forEach((el) => {
    el.addEventListener("input", () => {
      handleAnyChange({skipParse: true});
    });
  });

  // URL import
  let isUrlImportInProgress = false;

  async function runUrlImport() {
    const url = (urlInput.value || "").trim();
    if (!url || isUrlImportInProgress) return;

    isUrlImportInProgress = true;
    errorMessage.textContent = "Importing workout…";
    errorMessage.className =
      "wb-code-error-message wb-code-error-message--neutral";

    try {
      const {canonical, error} =
        await importWorkoutFromUrl(url);

      if (error) {
        console.warn("[WorkoutBuilder] Import error:", error);
        errorMessage.textContent =
          (error && error.message) ||
          "Could not import workout from this URL yet.";
        errorMessage.className =
          "wb-code-error-message wb-code-error-message--error";
        return;
      }

      if (canonical) {
        if (canonical.workoutTitle) {
          nameField.input.value = canonical.workoutTitle;
        }
        if (canonical.description) {
          descField.textarea.value = canonical.description;
        }
        if (canonical.source) {
          sourceField.input.value = canonical.source;
        } else {
          sourceField.input.value = "Imported workout";
        }
      }

      codeTextarea.value = segmentsToZwoSnippet(canonical.rawSegments);
      refreshLayout();
    } catch (err) {
      console.error("[WorkoutBuilder] Import failed:", err);
      errorMessage.textContent =
        "Import failed. See console for details.";
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--error";
    } finally {
      isUrlImportInProgress = false;
    }
  }

  urlBtn.addEventListener("click", (e) => {
    e.preventDefault();
    runUrlImport();
  });

  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runUrlImport();
    }
  });

  // ---------- Init: restore from storage or default ----------

  (async () => {
    try {
      if (typeof loadWorkoutBuilderState === "function") {
        const saved = await loadWorkoutBuilderState();
        if (
          saved &&
          typeof saved === "object" &&
          Array.isArray(saved.rawSegments)
        ) {
          nameField.input.value = saved.workoutTitle || "";
          sourceField.input.value = saved.source || "";
          descField.textarea.value = saved.description || "";
          codeTextarea.value = segmentsToZwoSnippet(saved.rawSegments);
        }
      }
    } catch (e) {
      console.warn("[WorkoutBuilder] Failed to load saved state:", e);
    }
    if (!codeTextarea.value.trim()) {
      setDefaultSnippet();
    }
    refreshLayout();
  })();

  // ---------- Public API ----------

  function refreshLayout() {
    handleAnyChange();
    autoGrowTextarea(descField.textarea);
    autoGrowTextarea(codeTextarea);
  }

  function getState() {
    const title =
      (nameField.input.value || "Custom workout").trim() || "Custom workout";
    const source =
      (sourceField.input.value || "VeloDrive Builder").trim() ||
      "VeloDrive Builder";
    const description = descField.textarea.value || "";

    /** @type {import("./zwo.js").CanonicalWorkout} */
    const canonical = {
      source,
      sourceURL: "",
      workoutTitle: title,
      rawSegments: currentRawSegments.slice(),
      description,
    };

    return canonical;
  }

  function clearState() {
    nameField.input.value = "";
    sourceField.input.value = "";
    descField.textarea.value = "";
    codeTextarea.value = "";

    setDefaultSnippet();
    refreshLayout();
  }

  /**
   * Load a canonical workout into the builder.
   * @param {import("./zwo.js").CanonicalWorkout} canonical
   */
  function loadCanonicalWorkout(canonical) {
    if (
      !canonical ||
      typeof canonical !== "object" ||
      !Array.isArray(canonical.rawSegments) ||
      !canonical.rawSegments.length
    ) {
      return;
    }

    nameField.input.value = canonical.workoutTitle || "";
    sourceField.input.value = canonical.source || "";
    descField.textarea.value = canonical.description || "";
    codeTextarea.value = segmentsToZwoSnippet(canonical.rawSegments);

    handleAnyChange();
  }

  function validateForSave() {
    handleAnyChange();

    const name = (nameField.input.value || "").trim();
    const source = (sourceField.input.value || "").trim();
    const desc = (descField.textarea.value || "").trim();
    const snippet = (codeTextarea.value || "").trim();

    nameField.input.classList.remove("wb-input-error");
    sourceField.input.classList.remove("wb-input-error");
    descField.textarea.classList.remove("wb-input-error");
    codeTextarea.classList.remove("wb-input-error");

    /** @type {{field: string, message: string}[]} */
    const errors = [];

    if (!name) errors.push({field: "name", message: "Name is required."});
    if (!source) {
      errors.push({
        field: "source",
        message: "Author / Source is required.",
      });
    }
    if (!desc) {
      errors.push({
        field: "description",
        message: "Description is required.",
      });
    }
    if (!snippet) {
      errors.push({
        field: "code",
        message: "Workout code is empty.",
      });
    }

    if (currentErrors && currentErrors.length) {
      const firstSyntax = currentErrors[0];
      errors.push({
        field: "code",
        message:
          firstSyntax.message || "Fix syntax errors before saving.",
      });
    }

    const hasErrors = errors.length > 0;

    for (const err of errors) {
      switch (err.field) {
        case "name":
          nameField.input.classList.add("wb-input-error");
          break;
        case "source":
          sourceField.input.classList.add("wb-input-error");
          break;
        case "description":
          descField.textarea.classList.add("wb-input-error");
          break;
        case "code":
          codeTextarea.classList.add("wb-input-error");
          break;
      }
    }

    if (hasErrors) {
      const first = errors[0];
      errorMessage.textContent = first.message;
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--error";
    } else {
      errorMessage.textContent = "Ready to save.";
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--ok";
    }

    return {
      ok: !hasErrors,
      errors: errors.map((e) => e.message),
    };
  }

  function setDefaultSnippet() {
    codeTextarea.value =
      '<Warmup Duration="600" PowerLow="0.50" PowerHigh="0.75" />\n' +
      '<SteadyState Duration="1200" Power="0.85" />\n' +
      '<Cooldown Duration="600" PowerLow="0.75" PowerHigh="0.50" />';
  }

  function handleAnyChange(opts = {}) {
    const {skipParse = false} = opts;

    if (!skipParse) {
      const text = codeTextarea.value || "";
      const parsed = parseZwoSnippet(text);
      currentRawSegments = parsed.rawSegments || [];
      currentErrors = parsed.errors || [];
    }

    const ftp = getCurrentFtp() || 0;

    if (currentRawSegments.length && ftp > 0) {
      currentMetrics = computeMetricsFromSegments(currentRawSegments, ftp);
      currentZone = inferZoneFromSegments(currentRawSegments);
    } else {
      currentMetrics = {
        totalSec: 0,
        durationMin: 0,
        ifValue: null,
        tss: null,
        kj: null,
        ftp: ftp || null,
      };
      currentZone = null;
    }

    updateStats();
    renderChart();
    updateErrorStyling();
    updateErrorHighlights();

    try {
      if (typeof saveWorkoutBuilderState === "function") {
        saveWorkoutBuilderState(getState());
      }
    } catch (e) {
      console.warn("[WorkoutBuilder] Failed to save builder state:", e);
    }
  }

  function updateStats() {
    const ftp = getCurrentFtp() || 0;

    if (!currentMetrics || currentMetrics.totalSec === 0) {
      statTss.value.textContent = "--";
      statIf.value.textContent = "--";
      statKj.value.textContent = "--";
      statDuration.value.textContent = "--";
      statFtp.value.textContent =
        ftp > 0 ? `${Math.round(ftp)} W` : "--";
      statZone.value.textContent = currentZone || "--";
      return;
    }

    statTss.value.textContent =
      currentMetrics.tss != null
        ? String(Math.round(currentMetrics.tss))
        : "--";
    statIf.value.textContent =
      currentMetrics.ifValue != null
        ? currentMetrics.ifValue.toFixed(2)
        : "--";
    statKj.value.textContent =
      currentMetrics.kj != null
        ? String(Math.round(currentMetrics.kj))
        : "--";
    statDuration.value.textContent =
      currentMetrics.durationMin != null
        ? `${Math.round(currentMetrics.durationMin)} min`
        : "--";
    statFtp.value.textContent =
      currentMetrics.ftp != null
        ? `${Math.round(currentMetrics.ftp)} W`
        : "--";
    statZone.value.textContent = currentZone || "--";
  }

  function renderChart() {
    // Canonical workout built from UI state
    const canonical = getState();
    const ftp = getCurrentFtp() || 0;

    chartMiniHost.innerHTML = "";
    try {
      renderMiniWorkoutGraph(chartMiniHost, canonical, ftp);
    } catch (e) {
      console.error("[WorkoutBuilder] Failed to render mini chart:", e);
    }
  }

  function updateErrorStyling() {
    const text = codeTextarea.value || "";

    if (!text.trim()) {
      codeTextarea.classList.remove("wb-has-error");
      errorMessage.textContent =
        "Empty workout. Add elements to begin.";
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--neutral";
      return;
    }

    if (!currentErrors.length) {
      codeTextarea.classList.remove("wb-has-error");
      errorMessage.textContent = "No syntax errors detected.";
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--ok";
      return;
    }

    codeTextarea.classList.add("wb-has-error");
    const first = currentErrors[0];
    errorMessage.textContent = first.message;
    errorMessage.className =
      "wb-code-error-message wb-code-error-message--error";
    updateErrorMessageForCaret();
  }

  function updateErrorMessageForCaret() {
    if (!currentErrors.length) return;
    const pos = codeTextarea.selectionStart || 0;
    const overlapping = currentErrors.find(
      (err) => pos >= err.start && pos <= err.end,
    );
    if (overlapping) {
      errorMessage.textContent = overlapping.message;
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--error";
    }
  }

  // ---------- Small DOM helpers ----------

  function escapeHtml(str) {
    return (str || "").replace(/[&<>"]/g, (c) => {
      switch (c) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        default:
          return c;
      }
    });
  }

  function updateErrorHighlights() {
    if (!codeHighlights) return;

    const text = codeTextarea.value || "";
    const lines = text.split("\n");
    const lineCount = lines.length;

    if (!currentErrors.length) {
      const html = lines
        .map((line) => `<div>${escapeHtml(line) || " "}</div>`)
        .join("");
      codeHighlights.innerHTML = html;
      return;
    }

    const lineOffsets = [];
    let offset = 0;
    for (let i = 0; i < lineCount; i += 1) {
      lineOffsets.push(offset);
      offset += lines[i].length + 1;
    }

    function indexToLine(idx) {
      if (!Number.isFinite(idx)) return 0;
      if (idx <= 0) return 0;
      if (idx >= text.length) return lineCount - 1;

      for (let i = 0; i < lineOffsets.length; i += 1) {
        const start = lineOffsets[i];
        const nextStart =
          i + 1 < lineOffsets.length
            ? lineOffsets[i + 1]
            : Infinity;
        if (idx >= start && idx < nextStart) {
          return i;
        }
      }
      return lineCount - 1;
    }

    const errorLines = new Set();

    for (const err of currentErrors) {
      let start = Number.isFinite(err.start) ? err.start : 0;
      let end = Number.isFinite(err.end) ? err.end : start;

      start = Math.max(0, Math.min(start, text.length));
      end = Math.max(start, Math.min(end, text.length));

      const startLine = indexToLine(start);
      const endLine = indexToLine(end);

      const s = Math.max(0, Math.min(startLine, lineCount - 1));
      const e = Math.max(s, Math.min(endLine, lineCount - 1));

      for (let i = s; i <= e; i += 1) {
        errorLines.add(i);
      }
    }

    const html = lines
      .map((line, idx) => {
        const safe = escapeHtml(line) || " ";
        if (errorLines.has(idx)) {
          return `<div class="wb-highlight-line">${safe}</div>`;
        }
        return `<div>${safe}</div>`;
      })
      .join("");

    codeHighlights.innerHTML = html;
  }

  function createWorkoutElementIcon(kind) {
    const svg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.classList.add("wb-code-icon");

    const path = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    path.setAttribute("fill", "currentColor");

    switch (kind) {
      case "steady":
        path.setAttribute("d", "M4 14h16v6H4z");
        break;
      case "rampUp":
        path.setAttribute("d", "M4 20 L20 20 20 8 4 16 Z");
        break;
      case "rampDown":
        path.setAttribute("d", "M4 8 L20 16 20 20 4 20 Z");
        break;
      case "intervals":
      default:
        path.setAttribute(
          "d",
          "M4 20h4v-8H4zm6 0h4v-14h-4zm6 0h4v-10h-4z",
        );
        break;
    }

    svg.appendChild(path);
    return svg;
  }

  function autoGrowTextarea(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  function createLabeledInput(labelText) {
    const wrapper = document.createElement("div");
    wrapper.className = "wb-field";

    const label = document.createElement("label");
    label.className = "wb-field-label";
    label.textContent = labelText;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "wb-field-input";

    wrapper.appendChild(label);
    wrapper.appendChild(input);

    return {wrapper, input};
  }

  function createLabeledTextarea(labelText) {
    const wrapper = document.createElement("div");
    wrapper.className = "wb-field";

    const label = document.createElement("label");
    label.className = "wb-field-label";
    label.textContent = labelText;

    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    textarea.className = "wb-field-textarea";

    wrapper.appendChild(label);
    wrapper.appendChild(textarea);

    return {wrapper, textarea};
  }

  function createStatChip(label) {
    const el = document.createElement("div");
    el.className = "wb-stat-chip";
    const labelEl = document.createElement("div");
    labelEl.className = "wb-stat-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("div");
    valueEl.className = "wb-stat-value";
    valueEl.textContent = "--";
    el.appendChild(labelEl);
    el.appendChild(valueEl);
    return {el, value: valueEl};
  }

  function insertSnippetAtCursor(textarea, snippet) {
    const value = textarea.value || "";
    const startSel = textarea.selectionStart || 0;
    const endSel = textarea.selectionEnd || startSel;

    let insertPos = endSel;
    const after = value.slice(endSel);
    const nextGt = after.indexOf(">");
    if (nextGt !== -1) {
      insertPos = endSel + nextGt + 1;
    }

    const beforeText = value.slice(0, insertPos);
    const afterText = value.slice(insertPos);

    const prefix = beforeText && !beforeText.endsWith("\n") ? "\n" : "";
    const suffix = afterText && !afterText.startsWith("\n") ? "\n" : "";

    const newValue = beforeText + prefix + snippet + suffix + afterText;
    textarea.value = newValue;

    const caretPos = (beforeText + prefix + snippet).length;
    textarea.setSelectionRange(caretPos, caretPos);
    textarea.focus();

    autoGrowTextarea(textarea);
  }

  return {
    getState,
    clearState,
    refreshLayout,
    validateForSave,
    loadCanonicalWorkout,
  };
}

