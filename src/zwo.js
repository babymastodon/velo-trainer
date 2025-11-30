// zwo.js
//
// Canonical workout representation + conversion to/from ZWO,
// plus inline ZWO parsing.
//
// This file is intentionally standalone (no DOM or fetch dependencies).

/**
 * Canonical representation of a scraped workout.
 *
 * @typedef CanonicalWorkout
 * @property {string} source
 *   e.g. "TrainerRoad" | "TrainerDay" | "WhatsOnZwift" | "Unknown"
 * @property {string} sourceURL
 *   Original workout page URL
 * @property {string} workoutTitle
 *   Human-readable workout title
 * @property {Array<[number, number, number]>} rawSegments
 *   Canonical segments: [minutes, startPower, endPower]
 *   - minutes: duration in minutes (float allowed)
 *   - startPower: % FTP or equivalent "start power" (0–100 usually)
 *   - endPower: % FTP or equivalent "end power" (0–100 usually)
 * @property {string} description
 *   Human-readable description/notes
 * @property {string} filename
 *   Suggested filename (e.g. original ZWO filename), may be ""
 */

// ---------------- Safety limits for ZWO parsing ----------------

const ZWO_MAX_SEGMENT_DURATION_SEC = 12 * 3600; // 12 hours per segment
const ZWO_MAX_WORKOUT_DURATION_SEC = 24 * 3600; // 24 hours total workout
const ZWO_MAX_INTERVAL_REPEATS = 500; // sanity cap on repeats

// ---------------- Small helpers ----------------

function escapeXml(text) {
  return (text || "").replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return ch;
    }
  });
}

function unescapeXml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cdataWrap(text) {
  if (!text) return "<![CDATA[]]>";
  // Prevent accidental CDATA close inside content
  const safe = String(text).replace("]]>", "]]&gt;");
  return "<![CDATA[" + safe + "]]>";
}

function cdataUnwrap(text) {
  if (!text) return "";
  const str = String(text).trim();
  if (str.startsWith("<![CDATA[") && str.endsWith("]]>")) {
    const inner = str.slice(9, -3);
    return inner.replace("]]&gt;", "]]>");
  }
  return str;
}

// ---------------- Inline ZWO snippet parser ----------------

/**
 * Parse a ZWO-style snippet containing SteadyState / Warmup / Cooldown / IntervalsT
 * into canonical segments and syntax errors.
 *
 * Returns segments as:
 *   { durationSec: number, pStartRel: number, pEndRel: number }[]
 * where power is relative FTP (0–1).
 *
 * Errors have:
 *   { start: number, end: number, message: string }
 *
 * Safety limits:
 *   - Max per-segment duration  : 12 hours
 *   - Max total IntervalsT time : 24 hours
 *   - Max IntervalsT repeats    : 500
 *
 * @param {string} text
 * @returns {{segments:Array<{durationSec:number,pStartRel:number,pEndRel:number}>,errors:Array<{start:number,end:number,message:string}>}}
 */
export function parseZwoSnippet(text) {
  /** @type {Array<{durationSec:number,pStartRel:number,pEndRel:number}>} */
  const segments = [];
  const errors = [];

  const raw = (text || "")
    .replace(/<\s*workout[^>]*>/gi, "")
    .replace(/<\/\s*workout\s*>/gi, "");
  const trimmed = raw.trim();
  if (!trimmed) return {segments, errors};

  const tagRegex = /<([A-Za-z]+)\b([^>]*)\/>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(trimmed)) !== null) {
    const full = match[0];
    const tagName = match[1];
    const attrsText = match[2] || "";
    const startIdx = match.index;
    const endIdx = startIdx + full.length;

    const between = trimmed.slice(lastIndex, startIdx);
    if (between.trim().length > 0) {
      errors.push({
        start: lastIndex,
        end: startIdx,
        message:
          "Unexpected text between elements; only ZWO workout elements are allowed.",
      });
    }

    const {attrs, hasGarbage} = parseZwoAttributes(attrsText);

    if (hasGarbage) {
      errors.push({
        start: startIdx,
        end: endIdx,
        message:
          "Malformed element: unexpected text or tokens inside element.",
      });
      lastIndex = endIdx;
      continue;
    }

    switch (tagName) {
      case "SteadyState":
        handleZwoSteady(attrs, segments, errors, startIdx, endIdx);
        break;
      case "Warmup":
      case "Cooldown":
        handleZwoRamp(tagName, attrs, segments, errors, startIdx, endIdx);
        break;
      case "IntervalsT":
        handleZwoIntervals(attrs, segments, errors, startIdx, endIdx);
        break;
      default:
        errors.push({
          start: startIdx,
          end: endIdx,
          message: `Unknown element <${tagName}>`,
        });
        break;
    }

    lastIndex = endIdx;
  }

  const trailing = trimmed.slice(lastIndex);
  if (trailing.trim().length > 0) {
    errors.push({
      start: lastIndex,
      end: lastIndex + trailing.length,
      message: "Trailing text after last element.",
    });
  }

  return {segments, errors};
}

function parseZwoAttributes(attrText) {
  const attrs = {};
  let hasGarbage = false;

  const attrRegex =
    /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*"([^"]*)"/g;

  let m;
  let lastIndex = 0;

  while ((m = attrRegex.exec(attrText)) !== null) {
    if (m.index > lastIndex) {
      const between = attrText.slice(lastIndex, m.index);
      if (between.trim().length > 0) {
        hasGarbage = true;
      }
    }

    attrs[m[1]] = m[2];
    lastIndex = attrRegex.lastIndex;
  }

  const trailing = attrText.slice(lastIndex);
  if (trailing.trim().length > 0) {
    hasGarbage = true;
  }

  return {attrs, hasGarbage};
}

function handleZwoSteady(
  attrs,
  segments,
  errors,
  start,
  end
) {
  const durStr = attrs.Duration;
  const pStr = attrs.Power;
  const duration = durStr != null ? Number(durStr) : NaN;
  const power = pStr != null ? Number(pStr) : NaN;

  if (
    !validateZwoDuration(
      duration,
      "SteadyState",
      start,
      end,
      errors
    )
  ) {
    return;
  }
  if (!Number.isFinite(power) || power <= 0) {
    errors.push({
      start,
      end,
      message:
        "SteadyState must have a positive numeric Power (relative FTP, e.g. 0.75).",
    });
    return;
  }

  segments.push({
    durationSec: duration,
    pStartRel: power,
    pEndRel: power,
  });
}

function handleZwoRamp(
  tagName,
  attrs,
  segments,
  errors,
  start,
  end
) {
  const durStr = attrs.Duration;
  const loStr = attrs.PowerLow;
  const hiStr = attrs.PowerHigh;
  const duration = durStr != null ? Number(durStr) : NaN;
  const pLow = loStr != null ? Number(loStr) : NaN;
  const pHigh = hiStr != null ? Number(hiStr) : NaN;

  if (
    !validateZwoDuration(
      duration,
      tagName,
      start,
      end,
      errors
    )
  ) {
    return;
  }
  if (!Number.isFinite(pLow) || !Number.isFinite(pHigh)) {
    errors.push({
      start,
      end,
      message: `${tagName} must have PowerLow and PowerHigh as numbers (relative FTP).`,
    });
    return;
  }

  segments.push({
    durationSec: duration,
    pStartRel: pLow,
    pEndRel: pHigh,
  });
}

function validateZwoDuration(
  duration,
  tagName,
  start,
  end,
  errors
) {
  if (!Number.isFinite(duration) || duration <= 0) {
    errors.push({
      start,
      end,
      message: `${tagName} must have a positive numeric Duration (seconds).`,
    });
    return false;
  }
  if (duration > ZWO_MAX_SEGMENT_DURATION_SEC) {
    errors.push({
      start,
      end,
      message: `${tagName} Duration is unrealistically large (max ${ZWO_MAX_SEGMENT_DURATION_SEC} seconds).`,
    });
    return false;
  }
  return true;
}

function handleZwoIntervals(
  attrs,
  segments,
  errors,
  start,
  end
) {
  const repStr = attrs.Repeat;
  const onDurStr = attrs.OnDuration;
  const offDurStr = attrs.OffDuration;
  const onPowStr = attrs.OnPower;
  const offPowStr = attrs.OffPower;

  const repeat = repStr != null ? Number(repStr) : NaN;
  const onDur = onDurStr != null ? Number(onDurStr) : NaN;
  const offDur = offDurStr != null ? Number(offDurStr) : NaN;
  const onPow = onPowStr != null ? Number(onPowStr) : NaN;
  const offPow = offPowStr != null ? Number(offPowStr) : NaN;

  if (
    !Number.isFinite(repeat) ||
    repeat <= 0 ||
    repeat > ZWO_MAX_INTERVAL_REPEATS
  ) {
    errors.push({
      start,
      end,
      message: `IntervalsT must have Repeat as a positive integer (max ${ZWO_MAX_INTERVAL_REPEATS}).`,
    });
    return;
  }

  if (
    !validateZwoDuration(
      onDur,
      "IntervalsT OnDuration",
      start,
      end,
      errors
    )
  ) {
    return;
  }
  if (
    !validateZwoDuration(
      offDur,
      "IntervalsT OffDuration",
      start,
      end,
      errors
    )
  ) {
    return;
  }

  const totalBlockSec = repeat * (onDur + offDur);
  if (
    !Number.isFinite(totalBlockSec) ||
    totalBlockSec > ZWO_MAX_WORKOUT_DURATION_SEC
  ) {
    errors.push({
      start,
      end,
      message: "IntervalsT total duration is unrealistically large.",
    });
    return;
  }
  if (!Number.isFinite(onPow) || !Number.isFinite(offPow)) {
    errors.push({
      start,
      end,
      message:
        "IntervalsT must have numeric OnPower and OffPower (relative FTP).",
    });
    return;
  }

  const reps = Math.round(repeat);
  for (let i = 0; i < reps; i++) {
    segments.push({
      durationSec: onDur,
      pStartRel: onPow,
      pEndRel: onPow,
    });
    segments.push({
      durationSec: offDur,
      pStartRel: offPow,
      pEndRel: offPow,
    });
  }
}

// ---------------- Canonical segments -> ZWO body ----------------

/**
 * segments: [minutes, startPower, endPower]
 * Detects repeated steady on/off pairs and emits IntervalsT when possible.
 *
 * startPower/endPower are assumed to be in “FTP-relative” units where:
 *   - <= 5 → treated as 0–1 (fraction of FTP)
 *   - >  5 → treated as 0–100 (% of FTP)
 *
 * @param {Array<[number, number, number]>} segments
 * @returns {string} ZWO <workout> body lines joined by "\n"
 */
export function segmentsToZwoSnippet(segments) {
  if (!Array.isArray(segments) || !segments.length) return "";

  const blocks = [];

  // ---------- 1) segments -> normalized blocks ----------
  for (const seg of segments) {
    if (!Array.isArray(seg) || seg.length < 2) continue;

    const minutes = Number(seg[0]);
    let startVal = Number(seg[1]);
    let endVal =
      seg.length > 2 && seg[2] != null ? Number(seg[2]) : startVal;

    if (
      !Number.isFinite(minutes) ||
      minutes <= 0 ||
      !Number.isFinite(startVal) ||
      !Number.isFinite(endVal)
    ) {
      continue;
    }

    // Convert to relative FTP (0–1) with a simple heuristic:
    // if value <= 5, assume already 0–1; otherwise assume 0–100%.
    const toRel = (v) => (v <= 5 ? v : v / 100);

    const durationSec = minutes * 60;
    const pStartRel = toRel(startVal);
    const pEndRel = toRel(endVal);

    if (durationSec <= 0) continue;

    if (Math.abs(pStartRel - pEndRel) < 1e-6) {
      // steady
      blocks.push({
        kind: "steady",
        durationSec,
        powerRel: pStartRel,
      });
    } else if (pEndRel > pStartRel) {
      // ramp up
      blocks.push({
        kind: "rampUp",
        durationSec,
        powerLowRel: pStartRel,
        powerHighRel: pEndRel,
      });
    } else {
      // ramp down
      blocks.push({
        kind: "rampDown",
        durationSec,
        powerLowRel: pStartRel,
        powerHighRel: pEndRel,
      });
    }
  }

  if (!blocks.length) return "";

  // ---------- 2) compress blocks -> ZWO lines ----------
  const lines = [];
  const DUR_TOL = 1; // seconds
  const PWR_TOL = 0.01; // relative FTP (0.01 = 1%)

  let i = 0;

  while (i < blocks.length) {
    // Try to detect repeated steady on/off pairs → IntervalsT
    if (i + 3 < blocks.length) {
      const firstA = blocks[i];
      const firstB = blocks[i + 1];

      if (firstA.kind === "steady" && firstB.kind === "steady") {
        let repeat = 1;
        let j = i + 2;

        // Scan forward for more identical A/B pairs
        while (j + 1 < blocks.length) {
          const nextA = blocks[j];
          const nextB = blocks[j + 1];

          if (
            nextA.kind !== "steady" ||
            nextB.kind !== "steady" ||
            !blocksSimilarSteady(firstA, nextA, DUR_TOL, PWR_TOL) ||
            !blocksSimilarSteady(firstB, nextB, DUR_TOL, PWR_TOL)
          ) {
            break;
          }

          repeat++;
          j += 2;
        }

        if (repeat >= 2) {
          const onDur = Math.round(firstA.durationSec);
          const offDur = Math.round(firstB.durationSec);
          const onPow = firstA.powerRel.toFixed(2);
          const offPow = firstB.powerRel.toFixed(2);

          lines.push(
            `<IntervalsT Repeat="${repeat}"` +
            ` OnDuration="${onDur}" OffDuration="${offDur}"` +
            ` OnPower="${onPow}" OffPower="${offPow}" />`
          );

          i += repeat * 2;
          continue;
        }
      }
    }

    // Fallback: single block -> SteadyState / Warmup / Cooldown
    const b = blocks[i];

    if (b.kind === "steady") {
      lines.push(
        `<SteadyState Duration="${Math.round(
          b.durationSec
        )}" Power="${b.powerRel.toFixed(2)}" />`
      );
    } else if (b.kind === "rampUp") {
      lines.push(
        `<Warmup Duration="${Math.round(
          b.durationSec
        )}" PowerLow="${b.powerLowRel.toFixed(
          2
        )}" PowerHigh="${b.powerHighRel.toFixed(2)}" />`
      );
    } else if (b.kind === "rampDown") {
      lines.push(
        `<Cooldown Duration="${Math.round(
          b.durationSec
        )}" PowerLow="${b.powerLowRel.toFixed(
          2
        )}" PowerHigh="${b.powerHighRel.toFixed(2)}" />`
      );
    }

    i++;
  }

  return lines.join("\n");
}

function blocksSimilarSteady(a, b, durTolSec, pwrTol) {
  if (a.kind !== "steady" || b.kind !== "steady") return false;
  const durDiff = Math.abs(a.durationSec - b.durationSec);
  const pDiff = Math.abs(a.powerRel - b.powerRel);
  return durDiff <= durTolSec && pDiff <= pwrTol;
}

// ---------------- CanonicalWorkout -> ZWO XML ----------------

/**
 * Build a full ZWO XML file from a CanonicalWorkout.
 *
 * The original source URL is included:
 *   - Appended to the description inside CDATA
 *   - As a tag: <tag name="OriginalURL:..."/>
 *
 * The source is *not* encoded in tags; it is just the <author>.
 *
 * @param {CanonicalWorkout} meta
 * @param {Object} [options]
 * @param {string} [options.sportType]  - Zwift sportType (default: "bike")
 * @returns {string} ZWO XML content
 */
export function canonicalWorkoutToZwoXml(meta) {

  const {
    source = "Unknown",
    sourceURL = "",
    workoutTitle = "",
    rawSegments = [],
    description = "",
    filename = "",
  } = meta || {};

  const name =
    (workoutTitle || "Custom workout").trim() || "Custom workout";
  const author = (source || "External workout").trim() || "External workout";

  const workoutSnippet = segmentsToZwoSnippet(rawSegments);

  // Include URL in description so it's visible in Zwift UI
  let descCombined = description || "";
  if (sourceURL) {
    const urlLine = `Original workout URL: ${sourceURL}`;
    descCombined = descCombined
      ? `${descCombined}\n\n${urlLine}`
      : urlLine;
  }

  // Include URL as a tag (Zwift will just ignore unknown tags,
  // but tools can use it later).
  const urlTag = sourceURL
    ? `    <tag name="OriginalURL:${escapeXml(sourceURL)}"/>\n`
    : "";

  const indentedBody = workoutSnippet
    ? workoutSnippet
      .split("\n")
      .map((line) => "    " + line)
      .join("\n")
    : "";

  const fileNameTag = filename
    ? `  <!-- filename: ${escapeXml(filename)} -->\n`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<workout_file>
  <author>${escapeXml(author)}</author>
  <name>${escapeXml(name)}</name>
  <description>${cdataWrap(descCombined)}</description>
  <sportType>bike</sportType>
  <tags>
${urlTag}  </tags>
  <workout>
${indentedBody}
  </workout>
${fileNameTag}</workout_file>
`;
}

/**
 * Simple inverse of canonicalWorkoutToZwoXml:
 * Parse a full ZWO XML file into a CanonicalWorkout.
 *
 * This uses basic string-based parsing (not a full XML parser) and
 * focuses on the common fields produced by canonicalWorkoutToZwoXml.
 *
 * @param {string} xmlText
 * @param {string} [filename]
 * @returns {CanonicalWorkout|null}
 */
export function parseZwoXmlToCanonicalWorkout(xmlText, filename = "") {
  if (!xmlText || typeof xmlText !== "string") return null;
  const xml = xmlText;

  const nameMatch = xml.match(/<name>([\s\S]*?)<\/name>/i);
  const rawName = nameMatch ? nameMatch[1].trim() : "Imported workout";
  const workoutTitle = unescapeXml(cdataUnwrap(rawName));

  const descMatch = xml.match(/<description>([\s\S]*?)<\/description>/i);
  let description = "";
  if (descMatch) {
    let rawDesc = descMatch[1].trim();
    rawDesc = cdataUnwrap(rawDesc);
    rawDesc = unescapeXml(rawDesc);

    // Strip the "Original workout URL: ..." line if present
    const lines = rawDesc.split(/\r?\n/);
    const filtered = [];
    for (const line of lines) {
      if (
        line.trim().toLowerCase().startsWith("original workout url:")
      ) {
        continue;
      }
      filtered.push(line);
    }
    description = filtered.join("\n").trim();
  }

  // Extract OriginalURL tag if present
  let sourceURL = "";
  const urlTagMatch = xml.match(
    /<tag[^>]*\sname="OriginalURL:([^"]*)"/i
  );
  if (urlTagMatch) {
    sourceURL = unescapeXml(urlTagMatch[1]);
  }

  // Source is just the author
  let source = "Imported ZWO";
  const authorMatch = xml.match(/<author>([\s\S]*?)<\/author>/i);
  if (authorMatch) {
    source = unescapeXml(authorMatch[1].trim());
  }

  // Extract <workout>...</workout> body and reuse parseZwoSnippet
  const workoutMatch = xml.match(
    /<workout[^>]*>([\s\S]*?)<\/workout>/i
  );
  const workoutInner = workoutMatch ? workoutMatch[1] : "";
  const {segments} = parseZwoSnippet(workoutInner);

  const rawSegments = segments.map((s) => {
    const minutes = s.durationSec / 60;
    const startPct = s.pStartRel * 100;
    const endPct = s.pEndRel * 100;
    return [minutes, startPct, endPct];
  });

  /** @type {CanonicalWorkout} */
  const cw = {
    source,
    sourceURL,
    workoutTitle,
    rawSegments,
    description,
    filename: filename || "",
  };

  return cw;
}

