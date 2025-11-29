// workout-chart.js
// Shared chart helpers: zones, colors, scaled segments, SVG rendering, hover.

import {DEFAULT_FTP} from "./workout-metrics.js";

// --------------------------- CSS / color helpers ---------------------------

export function getCssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

export function parseHexColor(hex) {
  if (!hex) return null;
  let s = hex.trim().toLowerCase();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.length === 3) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  }
  if (s.length !== 6) return null;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return {r, g, b};
}

export function mixColors(hexA, hexB, factor) {
  const a = parseHexColor(hexA);
  const b = parseHexColor(hexB);
  if (!a || !b) return hexA;
  const f = Math.min(1, Math.max(0, factor));
  const r = Math.round(a.r * (1 - f) + b.r * f);
  const g = Math.round(a.g * (1 - f) + b.g * f);
  const bC = Math.round(a.b * (1 - f) + b.b * f);
  const toHex = (x) => x.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(bC)}`;
}

// --------------------------- Zone / color mapping ---------------------------

/**
 * Maps a relative intensity (fraction of FTP) to zone name and colors.
 * Returns: { key, color, bg }
 */
export function zoneInfoFromRel(rel) {
  const clampedRel = Math.max(0, rel);
  const pct = clampedRel * 100;
  let key = "Recovery";
  if (pct < 60) key = "Recovery";
  else if (pct < 76) key = "Base";
  else if (pct < 90) key = "Tempo";
  else if (pct < 105) key = "Threshold";
  else if (pct < 119) key = "VO2Max";
  else key = "Anaerobic";

  const colorVarMap = {
    Recovery: "--zone-recovery",
    Base: "--zone-base",
    Tempo: "--zone-tempo",
    Threshold: "--zone-threshold",
    VO2Max: "--zone-vo2",
    Anaerobic: "--zone-anaerobic",
  };

  const color = getCssVar(colorVarMap[key] || "--zone-recovery");
  const bg = getCssVar("--bg") || "#f4f4f4";

  return {key, color, bg};
}

// --------------------------- Segment scaling ---------------------------

/**
 * Converts "segments for metrics" into scaled segments with absolute times
 * and target watts, ready for rendering/use in the workout engine.
 *
 * segments: [{ durationSec, pStartRel, pEndRel }, ...]
 */
export function computeScaledSegments(segments, ftp) {
  let t = 0;
  const scaled = (segments || []).map((seg) => {
    const dur = Math.max(1, Math.round(seg.durationSec || 0));
    const pStartRel = seg.pStartRel || 0;
    const pEndRel = seg.pEndRel != null ? seg.pEndRel : pStartRel;

    const targetWattsStart = Math.round(ftp * pStartRel);
    const targetWattsEnd = Math.round(ftp * pEndRel);

    const s = {
      durationSec: dur,
      startTimeSec: t,
      endTimeSec: t + dur,
      targetWattsStart,
      targetWattsEnd,
      pStartRel,
      pEndRel,
    };

    t += dur;
    return s;
  });

  return {
    scaledSegments: scaled,
    totalSec: t,
  };
}

// --------------------------- SVG helpers ---------------------------

function clearSvg(svg) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

/**
 * Renders a single workout segment polygon into an SVG, with data attributes
 * for hover tooltips. Used by both the main workout chart and the mini graphs.
 */
function renderWorkoutSegmentPolygon({
  svg,
  seg,
  totalSec,
  width,
  height,
  ftp,
  maxY,
}) {
  if (!svg || !totalSec || totalSec <= 0) return;

  const w = width;
  const h = height;

  const x1 = (seg.startTimeSec / totalSec) * w;
  const x2 = (seg.endTimeSec / totalSec) * w;

  const avgRel = (seg.pStartRel + seg.pEndRel) / 2;
  const zone = zoneInfoFromRel(avgRel);

  const p0 = seg.pStartRel * ftp;
  const p1 = seg.pEndRel * ftp;

  const y0 = h - (Math.min(maxY, Math.max(0, p0)) / maxY) * h;
  const y1 = h - (Math.min(maxY, Math.max(0, p1)) / maxY) * h;

  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  const pts = `${x1},${h} ${x1},${y0} ${x2},${y1} ${x2},${h}`;
  poly.setAttribute("points", pts);

  const muted = mixColors(zone.color, zone.bg, 0.3);
  const hover = mixColors(zone.color, zone.bg, 0.15);

  poly.setAttribute("fill", muted);
  poly.setAttribute("fill-opacity", "1");
  poly.setAttribute("stroke", "none");
  poly.classList.add("chart-segment");

  const p0Pct = seg.pStartRel * 100;
  const p1Pct = seg.pEndRel * 100;
  const durMin = seg.durationSec / 60;

  poly.dataset.zone = zone.key;
  poly.dataset.p0 = p0Pct.toFixed(0);
  poly.dataset.p1 = p1Pct.toFixed(0);
  poly.dataset.durMin = durMin.toFixed(1);
  poly.dataset.color = zone.color;
  poly.dataset.mutedColor = muted;
  poly.dataset.hoverColor = hover;

  svg.appendChild(poly);
}

// Track last hovered segment across charts (main + mini)
let lastHoveredSegment = null;

/**
 * Attaches hover behavior for segments: shows tooltip and highlights polygon.
 */
function attachSegmentHover(svg, tooltipEl, containerEl) {
  if (!svg || !tooltipEl || !containerEl) return;

  svg.addEventListener("mousemove", (e) => {
    const segment = e.target.closest ? e.target.closest(".chart-segment") : null;

    if (!segment) {
      tooltipEl.style.display = "none";
      if (lastHoveredSegment) {
        const prevColor =
          lastHoveredSegment.dataset.mutedColor ||
          lastHoveredSegment.dataset.color;
        if (prevColor) {
          lastHoveredSegment.setAttribute("fill", prevColor);
        }
        lastHoveredSegment = null;
      }
      return;
    }

    const zone = segment.dataset.zone;
    const p0 = segment.dataset.p0;
    const p1 = segment.dataset.p1;
    const durMin = segment.dataset.durMin;

    if (p0 === p1) {
      tooltipEl.textContent = `${zone}: ${p0}% FTP, ${durMin} min`;
    } else {
      tooltipEl.textContent = `${zone}: ${p0}%–${p1}% FTP, ${durMin} min`;
    }
    tooltipEl.style.display = "block";

    const panelRect = containerEl.getBoundingClientRect();
    let tx = e.clientX - panelRect.left + 8;
    let ty = e.clientY - panelRect.top + 8;

    const ttRect = tooltipEl.getBoundingClientRect();
    if (tx + ttRect.width > panelRect.width - 4) {
      tx = panelRect.width - ttRect.width - 4;
    }
    if (tx < 0) tx = 0;
    if (ty + ttRect.height > panelRect.height - 4) {
      ty = panelRect.height - ttRect.height - 4;
    }
    if (ty < 0) ty = 0;

    tooltipEl.style.left = `${tx}px`;
    tooltipEl.style.top = `${ty}px`;

    if (lastHoveredSegment && lastHoveredSegment !== segment) {
      const prevColor =
        lastHoveredSegment.dataset.mutedColor ||
        lastHoveredSegment.dataset.color;
      if (prevColor) {
        lastHoveredSegment.setAttribute("fill", prevColor);
      }
    }

    const hoverColor =
      segment.dataset.hoverColor ||
      segment.dataset.color ||
      segment.dataset.mutedColor;
    if (hoverColor) {
      segment.setAttribute("fill", hoverColor);
    }

    lastHoveredSegment = segment;
  });

  svg.addEventListener("mouseleave", () => {
    tooltipEl.style.display = "none";
    if (lastHoveredSegment) {
      const prevColor =
        lastHoveredSegment.dataset.mutedColor ||
        lastHoveredSegment.dataset.color;
      if (prevColor) {
        lastHoveredSegment.setAttribute("fill", prevColor);
      }
      lastHoveredSegment = null;
    }
  });
}

// --------------------------- Mini workout graph (picker) ---------------------------

/**
 * Renders a small workout profile chart into a container for the picker.
 *
 * - container: DOM element where the SVG + tooltip go.
 * - workout: object from parseZwo (must have segmentsForMetrics, ftpAtSelection / ftpFromFile)
 * - currentFtp: current FTP used in the picker view.
 */
export function renderMiniWorkoutGraph(container, workout, currentFtp) {
  container.innerHTML = "";

  const baseSegments = workout.segmentsForMetrics || [];
  if (!baseSegments.length) {
    container.textContent = "No workout structure available.";
    container.classList.add("picker-detail-empty");
    return;
  }

  const ftp =
    currentFtp ||
    workout.ftpAtSelection ||
    workout.ftpFromFile ||
    DEFAULT_FTP;

  const {scaledSegments, totalSec} = computeScaledSegments(
    baseSegments,
    ftp
  );

  if (!scaledSegments.length || totalSec <= 0) {
    container.textContent = "No workout structure available.";
    container.classList.add("picker-detail-empty");
    return;
  }

  const width = 400;
  const height = 120;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("picker-graph-svg");

  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", width);
  bg.setAttribute("height", height);
  bg.setAttribute("fill", "transparent");
  svg.appendChild(bg);

  const maxY = Math.max(200, ftp * 2);

  scaledSegments.forEach((seg) => {
    renderWorkoutSegmentPolygon({
      svg,
      seg,
      totalSec,
      width,
      height,
      ftp,
      maxY,
    });
  });

  const tooltip = document.createElement("div");
  tooltip.className = "picker-tooltip";

  container.appendChild(svg);
  container.appendChild(tooltip);

  attachSegmentHover(svg, tooltip, container);
}

// Draw the main workout chart

export function drawWorkoutChart({
  svg,
  panel,
  tooltipEl,
  width,
  height,
  mode,
  ftp,
  scaledSegments,
  totalSec,
  elapsedSec,
  liveSamples,
  manualErgTarget,
}) {
  if (!svg || !panel) return;
  clearSvg(svg);

  const w = width;
  const h = height;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("shape-rendering", "crispEdges");

  const maxY = Math.max(200, ftp * 2);

  // grid
  const step = 100;
  for (let yVal = 0; yVal <= maxY; yVal += step) {
    const y = h - (yVal / maxY) * h;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", "0");
    line.setAttribute("x2", String(w));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("stroke", getCssVar("--grid-line-subtle"));
    line.setAttribute("stroke-width", "0.5");
    line.setAttribute("pointer-events", "none");
    svg.appendChild(line);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", "4");
    label.setAttribute("y", String(y - 6));
    label.setAttribute("font-size", "14");
    label.setAttribute("fill", getCssVar("--text-muted"));
    label.setAttribute("pointer-events", "none");
    label.textContent = String(yVal);
    svg.appendChild(label);
  }

  const safeTotalSec = totalSec || 1;

  // workout segments
  if (mode === "workout" && scaledSegments && scaledSegments.length) {
    scaledSegments.forEach((seg) => {
      renderWorkoutSegmentPolygon({
        svg,
        seg,
        totalSec: safeTotalSec,
        width: w,
        height: h,
        ftp,
        maxY,
      });
    });
  }

  // ERG mode target
  if (mode === "erg") {
    const pctFtp = manualErgTarget / ((ftp > 0) ? ftp : DEFAULT_FTP);
    const seg = {
      durationSec: safeTotalSec,
      startTimeSec: 0,
      endTimeSec: safeTotalSec,
      targetWattsStart: manualErgTarget,
      targetWattsEnd: manualErgTarget,
      pStartRel: pctFtp,
      pEndRel: pctFtp,
    };
    renderWorkoutSegmentPolygon({
      svg,
      seg,
      totalSec: safeTotalSec,
      width: w,
      height: h,
      ftp,
      maxY,
    });
  }

  // past shade
  if (elapsedSec > 0 && safeTotalSec > 0) {
    const xPast = Math.min(w, (elapsedSec / safeTotalSec) * w);
    const shade = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    shade.setAttribute("x", "0");
    shade.setAttribute("y", "0");
    shade.setAttribute("width", String(xPast));
    shade.setAttribute("height", String(h));
    shade.setAttribute("fill", getCssVar("--shade-bg"));
    shade.setAttribute("fill-opacity", "0.05");
    shade.setAttribute("pointer-events", "none");
    svg.appendChild(shade);
  }

  // FTP line
  const ftpY = h - (ftp / maxY) * h;
  const ftpLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  ftpLine.setAttribute("x1", "0");
  ftpLine.setAttribute("x2", String(w));
  ftpLine.setAttribute("y1", String(ftpY));
  ftpLine.setAttribute("y2", String(ftpY));
  ftpLine.setAttribute("stroke", getCssVar("--ftp-line"));
  ftpLine.setAttribute("stroke-width", "1.5");
  ftpLine.setAttribute("pointer-events", "none");
  svg.appendChild(ftpLine);

  const ftpLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  ftpLabel.setAttribute("x", String(w - 4));
  ftpLabel.setAttribute("y", String(ftpY - 6));
  ftpLabel.setAttribute("font-size", "14");
  ftpLabel.setAttribute("fill", getCssVar("--ftp-line"));
  ftpLabel.setAttribute("text-anchor", "end");
  ftpLabel.setAttribute("pointer-events", "none");
  ftpLabel.textContent = `FTP ${ftp}`;
  svg.appendChild(ftpLabel);

  // position line
  const xNow = Math.min(w, (elapsedSec / safeTotalSec) * w);
  const posLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  posLine.setAttribute("x1", String(xNow));
  posLine.setAttribute("x2", String(xNow));
  posLine.setAttribute("y1", "0");
  posLine.setAttribute("y2", String(h));
  posLine.setAttribute("stroke", "#fdd835");
  posLine.setAttribute("stroke-width", "1.5");
  posLine.setAttribute("pointer-events", "none");
  svg.appendChild(posLine);

  // live sample lines
  const samples = liveSamples || [];
  const powerColor = getCssVar("--power-line");
  const hrColor = getCssVar("--hr-line");
  const cadColor = getCssVar("--cad-line");

  if (samples.length) {
    const pathForKey = (key) => {
      let d = "";
      samples.forEach((s) => {
        const t = s.t;
        const val = s[key];
        if (val == null) return;
        const x = Math.min(w, (t / safeTotalSec) * w);
        const yVal = Math.min(maxY, Math.max(0, val));
        const y = h - (yVal / maxY) * h;
        d += (d ? " L " : "M ") + x + " " + y;
      });
      return d;
    };

    const addPath = (d, color, strokeWidth) => {
      if (!d) return;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", color);
      p.setAttribute("stroke-width", String(strokeWidth));
      p.setAttribute("pointer-events", "none");
      svg.appendChild(p);
    };

    addPath(pathForKey("power"), powerColor, 2.5);
    addPath(pathForKey("hr"), hrColor, 1.5);
    addPath(pathForKey("cadence"), cadColor, 1.5);
  }

  attachSegmentHover(svg, tooltipEl, panel);
}

