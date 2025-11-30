// scrapers.js
//
// Site-specific scrapers that turn web pages / URLs into CanonicalWorkout
// instances and optional ZWO snippets.
//
// Depends on zwo.js for the canonical → ZWO transformation.

/** @typedef {import('./zwo.js').CanonicalWorkout} CanonicalWorkout */

// ---------------- Site detection regexes (for parsers) ----------------

const TRAINERROAD_WORKOUT_REGEX =
  /\/app\/cycling\/workouts\/add\/(\d+)(?:\/|$)/;
const TRAINERDAY_WORKOUT_REGEX = /^\/workouts\/([^/?#]+)/;
const WHATSONZWIFT_WORKOUT_REGEX = /^\/workouts\/.+/;

// ---------------- Small helpers (fetch / JSON) ----------------

/**
 * fetchJson with basic CORS / extension-host-permission detection.
 *
 * In a Chrome extension options page, blocked cross-origin requests often show
 * up as TypeError while the browser is online. We wrap those as a custom
 * VeloDriveCorsError so callers can present better remediation instructions.
 */
async function fetchJson(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.json();
  } catch (err) {
    const isOnline =
      typeof navigator !== "undefined" &&
        navigator != null &&
        typeof navigator.onLine === "boolean"
        ? navigator.onLine
        : true;

    if (err instanceof TypeError && isOnline) {
      const corsErr = new Error(
        "Request was blocked by the browser (CORS / site access)."
      );
      corsErr.name = "VeloDriveCorsError";
      corsErr.isVeloDriveCorsError = true;
      throw corsErr;
    }

    throw err;
  }
}

async function fetchTrainerRoadJson(url, options = {}) {
  return fetchJson(url, {
    credentials: "include",
    headers: {
      "trainerroad-jsonformat": "camel-case",
    },
    ...options,
  });
}

async function fetchTrainerDayWorkoutBySlug(slug) {
  const url = `https://app.api.trainerday.com/api/workouts/bySlug/${encodeURIComponent(
    slug
  )}`;
  return fetchJson(url, {credentials: "omit"});
}

// ---------------- Parsers for each site -> CanonicalWorkout -----------
//
// Each parser returns a tuple: [CanonicalWorkout|null, string|null]
//   - On success: [canonicalWorkout, null]
//   - On failure: [null, "user-friendly error message"]

// ---------- TrainerRoad ----------

/**
 * Convert TrainerRoad chart "course data" into canonical [minutes, startPower, endPower].
 *
 * @param {any} courseData
 * @returns {Array<[number, number, number]>}
 */
function canonicalizeTrainerRoadSegments(courseData) {
  if (!Array.isArray(courseData)) return [];
  const out = [];

  for (const seg of courseData) {
    // Case 1: already numeric array
    if (Array.isArray(seg)) {
      if (seg.length >= 2) {
        let minutes = Number(seg[0]);
        let start = Number(seg[1]);
        let end =
          seg.length > 2 && seg[2] != null ? Number(seg[2]) : start;

        // Heuristic: if first value looks like seconds (very large),
        // treat it as seconds and convert to minutes.
        if (Number.isFinite(minutes) && minutes > 90 * 60) {
          minutes = minutes / 60;
        }

        if (
          Number.isFinite(minutes) &&
          minutes > 0 &&
          Number.isFinite(start) &&
          Number.isFinite(end)
        ) {
          out.push([minutes, start, end]);
        }
      }
      continue;
    }

    if (!seg || typeof seg !== "object") continue;

    // Case 2: object — try to find duration/time
    let minutes = null;

    if ("Minutes" in seg) minutes = Number(seg.Minutes);
    else if ("minutes" in seg) minutes = Number(seg.minutes);
    else if ("Duration" in seg) minutes = Number(seg.Duration) / 60;
    else if ("duration" in seg) minutes = Number(seg.duration) / 60;
    else if ("Seconds" in seg) minutes = Number(seg.Seconds) / 60;
    else if ("seconds" in seg) minutes = Number(seg.seconds) / 60;

    // Case 3: power is often a single value (steady)
    let powerVal =
      seg.power ??
      seg.Power ??
      seg.percentFTP ??
      seg.PercentFTP ??
      seg.work ??
      seg.Work;

    if (!Number.isFinite(minutes) || minutes <= 0 || powerVal == null) {
      continue;
    }

    powerVal = Number(powerVal);
    if (!Number.isFinite(powerVal)) continue;

    const startPower = powerVal;
    const endPower = powerVal;
    out.push([minutes, startPower, endPower]);
  }

  return out;
}

/**
 * Parse the current TrainerRoad workout page into a CanonicalWorkout tuple.
 *
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
export async function parseTrainerRoadPage() {
  try {
    const path = window.location.pathname;
    const match = path.match(TRAINERROAD_WORKOUT_REGEX);
    if (!match) {
      return [
        null,
        "This doesn’t look like a TrainerRoad workout page. Open a workout in TrainerRoad and try again.",
      ];
    }

    const workoutId = match[1];
    const baseUrl = "https://www.trainerroad.com";

    const chartUrl = `${baseUrl}/app/api/workouts/${workoutId}/chart-data`;
    const summaryUrl = `${baseUrl}/app/api/workouts/${workoutId}/summary?withDifficultyRating=true`;

    const chartData = await fetchTrainerRoadJson(chartUrl);
    const metaResp = await fetchTrainerRoadJson(summaryUrl);
    const summary = metaResp.summary || metaResp || {};

    // Course data -> canonical segments
    let courseData =
      chartData.CourseData || chartData.courseData || chartData;
    if (!Array.isArray(courseData) && chartData.courseData) {
      courseData = chartData.courseData;
    }
    if (!Array.isArray(courseData) && chartData.data) {
      courseData = chartData.data;
    }

    const rawSegments = canonicalizeTrainerRoadSegments(courseData);
    if (!rawSegments.length) {
      return [
        null,
        "This TrainerRoad workout doesn’t have any intervals that VeloDrive can read yet.",
      ];
    }

    const workoutTitle =
      summary.workoutName || document.title || "TrainerRoad Workout";

    const description =
      summary.workoutDescription || summary.goalDescription || "";

    /** @type {CanonicalWorkout} */
    const cw = {
      source: "TrainerRoad",
      sourceURL: window.location.href,
      workoutTitle,
      rawSegments,
      description,
      filename: "",
    };

    return [cw, null];
  } catch (err) {
    console.warn("[VeloDrive][TrainerRoad] parse error:", err);
    return [
      null,
      "VeloDrive couldn’t read this TrainerRoad workout. Make sure you’re logged in and try reloading the page.",
    ];
  }
}

// ---------- TrainerDay ----------

/**
 * Convert TrainerDay segments into canonical [minutes, startPower, endPower].
 * TrainerDay segments are typically [minutes, startPct, endPct?].
 *
 * @param {Array<any>} segments
 * @returns {Array<[number, number, number]>}
 */
function canonicalizeTrainerDaySegments(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];

  for (const seg of segments) {
    if (!Array.isArray(seg) || seg.length < 2) continue;

    const minutes = Number(seg[0]);
    const start = Number(seg[1]);
    const end =
      seg.length > 2 && seg[2] != null ? Number(seg[2]) : start;

    if (
      Number.isFinite(minutes) &&
      minutes > 0 &&
      Number.isFinite(start) &&
      Number.isFinite(end)
    ) {
      out.push([minutes, start, end]);
    }
  }

  return out;
}

/**
 * Parse the current TrainerDay workout page into a CanonicalWorkout tuple.
 *
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
export async function parseTrainerDayPage() {
  try {
    const path = window.location.pathname;
    const match = path.match(TRAINERDAY_WORKOUT_REGEX);
    if (!match) {
      return [
        null,
        "This doesn’t look like a TrainerDay workout page. Open a workout on TrainerDay and try again.",
      ];
    }

    const slug = match[1];
    const details = await fetchTrainerDayWorkoutBySlug(slug);

    const rawSegments = canonicalizeTrainerDaySegments(
      Array.isArray(details.segments) ? details.segments : []
    );

    if (!rawSegments.length) {
      return [
        null,
        "This TrainerDay workout doesn’t have any intervals that VeloDrive can use.",
      ];
    }

    const workoutTitle =
      details.title || document.title || "TrainerDay Workout";
    const description = details.description || "";

    /** @type {CanonicalWorkout} */
    const cw = {
      source: "TrainerDay",
      sourceURL: window.location.href,
      workoutTitle,
      rawSegments,
      description,
      filename: "",
    };

    return [cw, null];
  } catch (err) {
    console.warn("[VeloDrive][TrainerDay] parse error:", err);
    return [
      null,
      "VeloDrive couldn’t import this TrainerDay workout. Please check the URL and try again.",
    ];
  }
}

// ---------- WhatsOnZwift (DOM helpers) ----------

function extractWozTitleFromDoc(doc) {
  const el = doc.querySelector("header.my-8 h1");
  return el ? el.textContent.trim() : "WhatsOnZwift Workout";
}

function extractWozDescriptionFromDoc(doc) {
  const ul = doc.querySelector("ul.items-baseline");
  if (!ul) return "";
  let el = ul.previousElementSibling;
  while (el) {
    if (el.tagName && el.tagName.toLowerCase() === "p") {
      return el.textContent.trim();
    }
    el = el.previousElementSibling;
  }
  return "";
}

/**
 * Returns an array of { minutes, startPct, endPct, cadence|null }
 * extracted from a WhatsOnZwift workout DOM document.
 *
 * @param {Document} doc
 */
function extractWozSegmentsFromDoc(doc) {
  const container = doc.querySelector("div.order-2");
  if (!container) {
    console.warn("[zwo] WhatsOnZwift: order-2 container not found.");
    return [];
  }

  const bars = Array.from(container.querySelectorAll(".textbar"));
  const segments = [];

  for (const bar of bars) {
    const text = (bar.textContent || "").replace(/\s+/g, " ").trim();
    const powSpans = bar.querySelectorAll(
      'span[data-unit="relpow"][data-value]'
    );

    // Patterns like: "5x 4min @ 72% FTP, 2min @ 52% FTP"
    const repMatch = text.match(/(\d+)\s*x\b/i);
    if (repMatch && powSpans.length >= 2) {
      const reps = parseInt(repMatch[1], 10);
      if (Number.isFinite(reps) && reps > 0) {
        const durMatches = Array.from(
          text.matchAll(/(\d+(?:\.\d+)?)\s*(min|sec)/gi)
        );
        const durations = durMatches
          .map((m) => {
            const val = parseFloat(m[1]);
            const unit = (m[2] || "").toLowerCase();
            if (!Number.isFinite(val)) return null;
            if (unit === "sec") return val / 60;
            return val; // minutes
          })
          .filter((v) => v != null);

        if (durations.length >= 2) {
          const onMinutes = durations[0];
          const offMinutes = durations[1];

          const pOn = Number(powSpans[0].getAttribute("data-value"));
          const pOff = Number(powSpans[1].getAttribute("data-value"));

          if (
            Number.isFinite(onMinutes) &&
            onMinutes > 0 &&
            Number.isFinite(offMinutes) &&
            offMinutes > 0 &&
            Number.isFinite(pOn) &&
            Number.isFinite(pOff)
          ) {
            for (let i = 0; i < reps; i++) {
              segments.push({
                minutes: onMinutes,
                startPct: pOn,
                endPct: pOn,
                cadence: null,
              });
              segments.push({
                minutes: offMinutes,
                startPct: pOff,
                endPct: pOff,
                cadence: null,
              });
            }
            continue;
          }
        }
      }
    }

    // Single bars, including ramps, with minutes or seconds
    let minutes = null;
    const minMatch = text.match(/(\d+)\s*min/i);
    if (minMatch) {
      minutes = Number(minMatch[1]);
    } else {
      const secMatch = text.match(/(\d+)\s*sec/i);
      if (secMatch) {
        const secs = Number(secMatch[1]);
        if (Number.isFinite(secs)) {
          minutes = secs / 60;
        }
      }
    }
    if (!Number.isFinite(minutes) || minutes <= 0) continue;

    const cadenceMatch = text.match(/@\s*(\d+)\s*rpm/i);
    const cadence = cadenceMatch ? Number(cadenceMatch[1]) : null;

    if (powSpans.length === 1) {
      const pct = Number(powSpans[0].getAttribute("data-value"));
      if (!Number.isFinite(pct)) continue;
      segments.push({
        minutes,
        startPct: pct,
        endPct: pct,
        cadence,
      });
    } else if (powSpans.length >= 2) {
      const pctLow = Number(powSpans[0].getAttribute("data-value"));
      const pctHigh = Number(powSpans[1].getAttribute("data-value"));
      if (!Number.isFinite(pctLow) || !Number.isFinite(pctHigh)) continue;
      segments.push({
        minutes,
        startPct: pctLow,
        endPct: pctHigh,
        cadence,
      });
    }
  }

  return segments;
}

// Convenience wrappers that use the current page DOM
function extractWozTitle() {
  return extractWozTitleFromDoc(document);
}

function extractWozDescription() {
  return extractWozDescriptionFromDoc(document);
}

function extractWozSegmentsFromDom() {
  return extractWozSegmentsFromDoc(document);
}

/**
 * Map WhatsOnZwift DOM segments into canonical [minutes, startPower, endPower].
 *
 * @param {Array<{minutes:number,startPct:number,endPct:number}>} segments
 * @returns {Array<[number, number, number]>}
 */
function canonicalizeWozSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];

  for (const s of segments) {
    if (!s || typeof s !== "object") continue;
    const minutes = Number(s.minutes);
    const start = Number(s.startPct);
    const end =
      s.endPct != null ? Number(s.endPct) : start;

    if (
      Number.isFinite(minutes) &&
      minutes > 0 &&
      Number.isFinite(start) &&
      Number.isFinite(end)
    ) {
      out.push([minutes, start, end]);
    }
  }

  return out;
}

/**
 * Parse the current WhatsOnZwift workout page into a CanonicalWorkout tuple.
 *
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
export async function parseWhatsOnZwiftPage() {
  try {
    const path = window.location.pathname;
    if (!WHATSONZWIFT_WORKOUT_REGEX.test(path)) {
      return [
        null,
        "This doesn’t look like a WhatsOnZwift workout page. Open a workout on WhatsOnZwift and try again.",
      ];
    }

    const segments = extractWozSegmentsFromDom();
    const rawSegments = canonicalizeWozSegments(segments);

    if (!rawSegments.length) {
      return [
        null,
        "VeloDrive couldn’t find any intervals on this WhatsOnZwift workout page.",
      ];
    }

    const workoutTitle = extractWozTitle();
    const description = extractWozDescription() || "";

    /** @type {CanonicalWorkout} */
    const cw = {
      source: "WhatsOnZwift",
      sourceURL: window.location.href,
      workoutTitle,
      rawSegments,
      description,
      filename: "",
    };

    return [cw, null];
  } catch (err) {
    console.warn("[VeloDrive][WhatsOnZwift] parse error:", err);
    return [
      null,
      "VeloDrive couldn’t read this WhatsOnZwift workout. Try reloading the page and make sure the workout loads fully.",
    ];
  }
}

// ---------- URL-based import for TrainerDay / WhatsOnZwift ----------

/**
 * Import a workout from a URL (TrainerDay or WhatsOnZwift).
 *
 * @param {string} inputUrl
 * @returns {Promise<{
 *   canonical: CanonicalWorkout|null,
 *   error: {type:string,message:string}|null
 * }>}
 */
export async function importWorkoutFromUrl(inputUrl) {
  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    return {
      canonical: null,
      error: {
        type: "invalidUrl",
        message: "That doesn’t look like a valid URL.",
      },
    };
  }

  const host = url.host.toLowerCase();

  if (host.includes("trainerday.com")) {
    return importTrainerDayFromUrl(url);
  }

  if (host.includes("whatsonzwift.com")) {
    return importWhatsOnZwiftFromUrl(url);
  }

  return {
    canonical: null,
    error: {
      type: "unsupportedHost",
      message:
        "This URL is not from a supported workout site (TrainerDay or WhatsOnZwift).",
    },
  };
}

async function importTrainerDayFromUrl(url) {
  try {
    const match = url.pathname.match(TRAINERDAY_WORKOUT_REGEX);
    if (!match) {
      return {
        canonical: null,
        error: {
          type: "invalidTrainerDayPath",
          message: "This TrainerDay URL does not look like a workout page.",
        },
      };
    }

    const slug = match[1];
    const details = await fetchTrainerDayWorkoutBySlug(slug);

    const rawSegments = canonicalizeTrainerDaySegments(
      Array.isArray(details.segments) ? details.segments : []
    );

    if (!rawSegments.length) {
      return {
        canonical: null,
        error: {
          type: "noSegments",
          message: "TrainerDay workout has no segments to import.",
        },
      };
    }

    /** @type {CanonicalWorkout} */
    const canonical = {
      source: "TrainerDay",
      sourceURL: url.toString(),
      workoutTitle: details.title || "TrainerDay Workout",
      rawSegments,
      description: details.description || "",
      filename: "",
    };

    return {canonical, error: null};
  } catch (err) {
    console.error("[zwo] TrainerDay import error:", err);

    if (err && (err.name === "VeloDriveCorsError" || err.isVeloDriveCorsError)) {
      return {
        canonical: null,
        error: {
          type: "corsOrPermission",
          message:
            "VeloDrive couldn’t reach TrainerDay from this page.\n\n" +
            "In Chrome, open chrome://extensions → VeloDrive → Details, then under “Site access” enable “Automatically allow access to these sites” for trainerday.com and app.api.trainerday.com, then try again.",
        },
      };
    }

    return {
      canonical: null,
      error: {
        type: "exception",
        message: "Import from TrainerDay failed. See console for details.",
      },
    };
  }
}

async function importWhatsOnZwiftFromUrl(url) {
  try {
    const res = await fetch(url.toString(), {credentials: "omit"});
    if (!res.ok) {
      return {
        canonical: null,
        error: {
          type: "network",
          message: `WhatsOnZwift request failed (HTTP ${res.status}).`,
        },
      };
    }

    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const wozSegments = extractWozSegmentsFromDoc(doc);
    if (!wozSegments || !wozSegments.length) {
      console.warn("[zwo][WhatsOnZwift] No segments extracted from DOM.");
      return {
        canonical: null,
        error: {
          type: "noSegments",
          message:
            "Could not find any intervals on this WhatsOnZwift workout page.",
        },
      };
    }

    const rawSegments = canonicalizeWozSegments(wozSegments);
    if (!rawSegments.length) {
      return {
        canonical: null,
        error: {
          type: "noSegments",
          message:
            "WhatsOnZwift workout intervals could not be canonicalized.",
        },
      };
    }

    const workoutTitle = extractWozTitleFromDoc(doc);
    const description = extractWozDescriptionFromDoc(doc);

    /** @type {CanonicalWorkout} */
    const canonical = {
      source: "WhatsOnZwift",
      sourceURL: url.toString(),
      workoutTitle,
      rawSegments,
      description: description || "",
      filename: "",
    };

    return {canonical, error: null};
  } catch (err) {
    console.error("[zwo] WhatsOnZwift import error:", err);

    const isOnline =
      typeof navigator !== "undefined" &&
        navigator != null &&
        typeof navigator.onLine === "boolean"
        ? navigator.onLine
        : true;

    if (err instanceof TypeError && isOnline) {
      return {
        canonical: null,
        error: {
          type: "corsOrPermission",
          message:
            "VeloDrive couldn’t reach WhatsOnZwift from this page.\n\n" +
            "In Chrome, open chrome://extensions → VeloDrive → Details, then under “Site access” enable “Automatically allow access to these sites” for whatsonzwift.com, then try again.",
        },
      };
    }

    return {
      canonical: null,
      error: {
        type: "exception",
        message:
          "Import from WhatsOnZwift failed. See console for details.",
      },
    };
  }
}

