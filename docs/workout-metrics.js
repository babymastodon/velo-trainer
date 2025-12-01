// workout-metrics.js
// Pure workout metrics + ZWO parsing helpers shared across the app.

export const DEFAULT_FTP = 250;


// --------------------------- Metrics from segments ---------------------------

/**
 * Compute workout metrics from canonical rawSegments.
 *
 * rawSegments: Array<[minutes:number, startPct:number, endPct:number]>
 * ftp: numeric FTP (W)
 *
 * Returns: { totalSec, durationMin, ifValue, tss, kj, ftp }
 */
export function computeMetricsFromSegments(rawSegments, ftp) {
  const ftpVal = Number(ftp) || 0;
  if (!ftpVal || !rawSegments?.length) {
    return {
      totalSec: 0,
      durationMin: 0,
      ifValue: null,
      tss: null,
      kj: null,
      ftp: ftpVal || null,
    };
  }

  let totalSec = 0;
  let sumFrac = 0;   // sum of relative power samples
  let sumFrac4 = 0;  // sum of (relative power^4)

  for (const [minutes, startPct, endPct] of rawSegments) {
    const dur = Math.max(1, Math.round(minutes * 60));
    const p0 = startPct / 100;       // relative FTP 0–1
    const dp = (endPct - startPct) / 100;  // delta relative FTP

    for (let i = 0; i < dur; i++) {
      const rel = p0 + dp * ((i + 0.5) / dur); // mid-point power
      sumFrac += rel;
      sumFrac4 += rel ** 4;
      totalSec++;
    }
  }

  const durationMin = totalSec / 60;
  const IF = Math.pow(sumFrac4 / totalSec, 0.25);
  const tss = (totalSec * IF * IF) / 36;
  const kj = ftpVal * sumFrac / 1000;

  return {
    totalSec,
    durationMin,
    ifValue: IF,
    tss,
    kj,
    ftp: ftpVal,
  };
}

// --------------------------- Zone inference ---------------------------

/**
 * rawSegments: [[minutes, startPct, endPct?], ...]
 * pct values are in % of FTP (e.g. 75 for 75%).
 */
export function inferZoneFromSegments(rawSegments) {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return "Uncategorized";
  }

  const zoneTime = {
    recovery: 0,
    endurance: 0,
    tempo: 0,
    threshold: 0,
    vo2: 0,
    anaerobic: 0,
  };

  let totalSec = 0;
  let workSec = 0;

  for (const seg of rawSegments) {
    if (!Array.isArray(seg) || seg.length < 2) continue;
    const minutes = Number(seg[0]);
    const startPct = Number(seg[1]);
    const endPct =
      seg.length > 2 && seg[2] != null ? Number(seg[2]) : startPct;

    if (
      !Number.isFinite(minutes) ||
      !Number.isFinite(startPct) ||
      !Number.isFinite(endPct)
    ) {
      continue;
    }

    const durSec = minutes * 60;
    if (durSec <= 0) continue;

    const avgPct = (startPct + endPct) / 2;
    totalSec += durSec;

    let zoneKey;
    if (avgPct < 60) zoneKey = "recovery";
    else if (avgPct < 76) zoneKey = "endurance";
    else if (avgPct < 90) zoneKey = "tempo";
    else if (avgPct < 105) zoneKey = "threshold";
    else if (avgPct < 119) zoneKey = "vo2";
    else zoneKey = "anaerobic";

    zoneTime[zoneKey] += durSec;

    if (avgPct >= 75) workSec += durSec;
  }

  if (totalSec === 0) return "Uncategorized";

  const z = zoneTime;
  const hiSec = z.vo2 + z.anaerobic;
  const thrSec = z.threshold;
  const tempoSec = z.tempo;

  const workFrac = workSec / totalSec;

  // Light / easy: mostly recovery / endurance
  if (workFrac < 0.15) {
    if (z.recovery / totalSec >= 0.7) return "Recovery";
    return "Endurance";
  }

  const safeDiv = workSec || 1;
  const fracWork = {
    hi: hiSec / safeDiv,
    thr: thrSec / safeDiv,
    tempo: tempoSec / safeDiv,
  };

  if (fracWork.hi >= 0.2) {
    const anaerFrac = z.anaerobic / safeDiv;
    if (anaerFrac >= 0.1) {
      return "HIIT";
    }
    return "VO2Max";
  }

  if (fracWork.thr + fracWork.hi >= 0.35) {
    return "Threshold";
  }

  if (fracWork.tempo + fracWork.thr + fracWork.hi >= 0.5) {
    return "Tempo";
  }

  return "Endurance";
}

// --------------------------- Picker helpers ---------------------------

/**
 * Buckets duration into label used by the duration filter.
 */
export function getDurationBucket(durationMin) {
  if (!Number.isFinite(durationMin)) return ">240";
  if (durationMin <= 30) return "0-30";
  if (durationMin <= 60) return "30-60";
  if (durationMin <= 90) return "60-90";
  if (durationMin <= 120) return "90-120";
  if (durationMin <= 150) return "120-150";
  if (durationMin <= 180) return "150-180";
  if (durationMin <= 210) return "180-210";
  if (durationMin <= 240) return "210-240";
  return ">240";
}

/**
 * Adjust kJ to the current FTP (used in picker list sorting).
 */
export function getAdjustedKjForPicker(baseKj, baseFtp, currentFtp) {
  if (
    baseKj == null ||
    !Number.isFinite(baseFtp) ||
    !Number.isFinite(currentFtp)
  ) {
    return baseKj;
  }
  if (baseFtp <= 0) return workout.baseKj;
  return baseKj * (currentFtp / baseFtp);
}

