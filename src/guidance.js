/** Evidence-aware indoor-air guidance. Severity is a display priority, not a health rating. */
export const DEFAULT_POLICY = {
  profile: 'strict',
  bucketMs: 5 * 60 * 1000,
  staleAfterMs: 15 * 60 * 1000,
  clockSkewToleranceMs: 5 * 60 * 1000,
  humidityWindowMs: 30 * 60 * 1000,
  thresholds: { pm25: 15, pm10: 45, co2: 1000, humidityLow: 30, humidityHigh: 50 },
  gasBands: { voc: [150, 250, 400], nox: [20, 150, 300] },
  practical: {
    gates: {
      pm25: [{ threshold: 75, minutes: 10, severity: 3 }, { threshold: 35, minutes: 30, severity: 2 }],
      pm10: [{ threshold: 150, minutes: 10, severity: 3 }, { threshold: 100, minutes: 30, severity: 2 }],
      co2: [{ threshold: 2000, minutes: 10, severity: 3 }, { threshold: 1500, minutes: 30, severity: 2, exclusive: true }],
      voc: [{ threshold: 400, minutes: 10, severity: 3 }, { threshold: 250, minutes: 30, severity: 2 }],
      nox: [{ threshold: 300, minutes: 10, severity: 3 }, { threshold: 150, minutes: 30, severity: 2 }],
    },
    humidity: { attentionHigh: 65, advisoryHigh: 60, advisoryLow: 25, minutes: 60 },
  },
  sources: {
    whoParticles: {
      reference: 'WHO global air quality guidelines (2021)',
      referenceUrl: 'https://www.who.int/publications/i/item/9789240034228',
      basis: 'WHO 24-hour guideline: PM₂.₅ 15 µg/m³; PM₁₀ 45 µg/m³. Current-reading thresholds are local screening cues, not WHO instantaneous limits.',
    },
    healthCanadaCo2: {
      reference: 'Health Canada residential CO₂ guideline',
      referenceUrl: 'https://www.canada.ca/en/health-canada/services/publications/healthy-living/residential-indoor-air-quality-guidelines-carbon-dioxide.html',
      basis: 'Health Canada recommends 1,000 ppm as a 24-hour average. Current-reading screening does not establish a guideline exceedance.',
    },
    sensirionGas: {
      reference: 'Sensirion example VOC/NOx event bands',
      referenceUrl: 'https://sensirion.com/media/documents/ACD82D45/6294DFC0/Info_Note_Integration_VOC_NOx_Sensor.pdf',
      basis: 'Manufacturer example control bands for relative gas events; these indices are not gas concentrations or health exposure limits. Typical learned backgrounds are VOC 100 and NOx 1. The baseline adapts, so a low index does not certify pollutant absence.',
    },
    sensirionLearning: {
      reference: 'Sensirion SEN5x engineering guidance',
      referenceUrl: 'https://sensirion.com/en/media/documents/25AB572C/62B463AA/Sensirion_Engineering_Guidelines_SEN5x.pdf',
      basis: 'The indices adapt to recent conditions. A persistent source can become part of the learned background, and a low index does not certify pollutant absence. A Home Assistant connection or state change does not establish when the physical sensor restarted.',
    },
    healthCanadaHumidity: {
      reference: 'Health Canada moisture and mould guidance',
      referenceUrl: 'https://www.canada.ca/en/health-canada/services/publications/healthy-living/addressing-moisture-mould-your-home.html',
      basis: 'Health Canada recommends 30–50% relative humidity at home; colder surfaces may require lower humidity to avoid condensation. The 30-minute screen is a local display choice.',
    },
    healthCanadaVentilation: {
      reference: 'Health Canada home indoor air quality guidance',
      referenceUrl: 'https://www.canada.ca/en/health-canada/services/air-quality/improve-indoor-air-quality-in-your-home.html',
      basis: 'Reduce pollutant sources and ventilate when outdoor conditions permit. Particle filtration does not remove CO₂.',
    },
    epaHumidity: {
      reference: 'EPA home moisture guidance',
      referenceUrl: 'https://www.epa.gov/mold/mold-course-chapter-9',
      basis: 'EPA recommends keeping humidity below 60%, ideally 30–50%. This practical profile uses local recorded-trend rules: above 65% for attention, and above 60% or below 25% for quiet moisture/dryness advisories, each over 60 minutes. These are dashboard tolerances, not agency exposure limits; cold surfaces may collect condensation below them.',
    },
    hseVentilation: {
      reference: 'HSE: using CO₂ monitors to assess ventilation',
      referenceUrl: 'https://www.hse.gov.uk/ventilation/using-co2-monitors.htm',
      basis: 'HSE uses consistently above 1,500 ppm as a workplace ventilation indicator. It is not a residential safety or exposure limit. The practical profile’s 30-minute and 10-minute attention gates are local dashboard heuristics.',
    },
  },
};

const KNOWN = ['pm25', 'pm10', 'pm1', 'pm4', 'co2', 'voc', 'nox', 'humidity', 'temperature'];
const LABELS = { pm25: 'PM₂.₅', pm10: 'PM₁₀', pm1: 'PM₁', pm4: 'PM₄', co2: 'CO₂', voc: 'VOC Index', nox: 'NOx Index', humidity: 'Humidity', temperature: 'Temperature' };
const PRIORITY = { pm25: 90, pm10: 80, co2: 70, nox: 60, voc: 50, humidity: 20 };
const UNITS = { pm25: 'µg/m³', pm10: 'µg/m³', pm1: 'µg/m³', pm4: 'µg/m³', co2: 'ppm', voc: '', nox: '', humidity: '%', temperature: '°C' };
const DAY_MS = 24 * 60 * 60 * 1000;

function mergePolicy(policy = {}) {
  const sources = { ...DEFAULT_POLICY.sources, ...policy.sources };
  if (policy.profile === 'practical' && !policy.sources?.healthCanadaHumidity) sources.healthCanadaHumidity = sources.epaHumidity;
  return { ...DEFAULT_POLICY, ...policy, thresholds: { ...DEFAULT_POLICY.thresholds, ...policy.thresholds }, gasBands: { ...DEFAULT_POLICY.gasBands, ...policy.gasBands }, sources };
}

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceFor(key, policy) {
  if (key === 'pm25' || key === 'pm10') return policy.sources.whoParticles;
  if (key === 'co2') return policy.sources.healthCanadaCo2;
  if (key === 'voc' || key === 'nox') return policy.sources.sensirionGas;
  if (key === 'humidity') return policy.sources.healthCanadaHumidity;
  return { reference: 'Measurement context', referenceUrl: null, basis: key === 'pm1' || key === 'pm4' ? 'Displayed for context and trends; no PM₁ or PM₄ health cutoff is inferred.' : 'Temperature is displayed for context; no comfort or health classification is inferred.' };
}

function validUnit(key, unit) {
  const u = String(unit ?? '').trim().toLowerCase().replaceAll('μ', 'u').replaceAll('µ', 'u').replaceAll('³', '3').replaceAll('^', '').replaceAll(' ', '');
  if (key.startsWith('pm')) return u === 'ug/m3';
  if (key === 'co2') return u === 'ppm';
  if (key === 'voc' || key === 'nox') return ['', 'index', 'points', 'indexpoints', 'vocindex', 'vocindexpoints', 'noxindex', 'noxindexpoints'].includes(u) && !(key === 'voc' && u.startsWith('nox')) && !(key === 'nox' && u.startsWith('voc'));
  if (key === 'humidity') return ['%', '%rh', 'rh%'].includes(u);
  if (key === 'temperature') return ['°c', 'c', 'celsius', '°f', 'f', 'fahrenheit'].includes(u);
  return false;
}

/** A last_updated timestamp alone says nothing about freshness of unchanged HA states. */
export function normalizeReading(key, reading, { now = Date.now(), policy = {} } = {}) {
  const p = mergePolicy(policy);
  const source = sourceFor(key, p);
  const result = { key, value: null, unit: UNITS[key] ?? null, status: 'invalid', reason: '', ...source };
  if (reading?.entityId) result.entityId = reading.entityId;
  if (!KNOWN.includes(key)) return { ...result, reason: 'Unsupported measurement type.' };
  if (!reading || reading.available === false) return { ...result, reason: 'Sensor is unavailable.' };
  let value = numeric(reading.value);
  if (value === null) return { ...result, reason: 'A finite numeric reading is required.' };
  if (!validUnit(key, reading.unit)) return { ...result, reason: `Unexpected unit for ${LABELS[key]}.` };
  if (key === 'temperature' && /^(°?f|fahrenheit)$/i.test(String(reading.unit).trim())) value = (value - 32) * 5 / 9;
  if (key !== 'temperature' && value < 0) return { ...result, reason: 'Negative readings are invalid.' };
  if (key === 'co2' && value === 0) return { ...result, reason: 'Zero CO₂ is not a plausible ambient reading; the sensor may not be ready.' };
  if (key === 'humidity' && value > 100) return { ...result, reason: 'Relative humidity must be between 0 and 100%.' };
  if ((key === 'voc' || key === 'nox') && (value < 1 || value > 500)) return { ...result, reason: value === 0 ? 'Index is not ready; the sensor may be warming up.' : 'Sensirion indices must be between 1 and 500.' };
  const reported = timestamp(reading.lastReported);
  if (reported !== null && reported > now + p.clockSkewToleranceMs) return { ...result, reason: 'The explicit last-reported timestamp is implausibly far in the future.' };
  const stale = reported !== null && now - reported > p.staleAfterMs;
  return { ...result, value, status: stale ? 'stale' : 'ok', reason: stale ? 'The explicit last-reported timestamp is old.' : key === 'pm1' || key === 'pm4' ? 'Context and trend only.' : key === 'voc' || key === 'nox' ? 'Relative to the sensor’s recent learned background.' : 'Current reading available.' };
}

/** Strict time-weighted mean over every complete, aligned statistics bucket. */
export function rollingAverage(rows = [], { now = Date.now(), periodMs = DAY_MS, bucketMs = DEFAULT_POLICY.bucketMs } = {}) {
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - periodMs;
  const expectedBuckets = periodMs / bucketMs;
  const buckets = new Map();
  const conflicts = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const from = timestamp(row?.start);
    const to = row?.end === undefined ? (from === null ? null : from + bucketMs) : timestamp(row.end);
    const mean = numeric(row?.mean);
    if (from === null || to === null || mean === null || mean < 0 || from < start || to > end || to - from !== bucketMs || from % bucketMs !== 0) continue;
    if (buckets.has(from) && buckets.get(from) !== mean) conflicts.add(from);
    else buckets.set(from, mean);
  }
  for (const conflict of conflicts) buckets.delete(conflict);
  const complete = Number.isInteger(expectedBuckets) && buckets.size === expectedBuckets;
  const coverage = { complete, availableBuckets: buckets.size, expectedBuckets, fraction: buckets.size / expectedBuckets, start, end, bucketMs };
  return { average: complete ? [...buckets.values()].reduce((mean, value, index) => mean + (value - mean) / (index + 1), 0) : null, coverage };
}

function flagFor(reading, severity, categoryKey, headline, advice, confirmed, reason, basis = reading.basis) {
  return { key: reading.key, severity, categoryKey, headline, advice, confirmed, reason, basis, reference: reading.reference, referenceUrl: reading.referenceUrl };
}

function isUsable(reading) { return reading.status !== 'invalid' && reading.status !== 'stale'; }

/** Evaluate only supplied/expected readings; missing sensors never become zero values. */
export function evaluateGuidance({ now = Date.now(), readings = {}, samples = {}, policy = {} } = {}) {
  const p = mergePolicy(policy);
  if (p.profile === 'practical') return evaluatePractical({ now, readings, samples, policy: p });
  const normalized = Object.entries(readings ?? {}).map(([key, reading]) => normalizeReading(key, reading, { now, policy: p }));
  const flags = [];
  const coverage = {};
  const particlesAdvice = 'Reduce particle sources such as smoke or cooking; use suitable particle filtration. Ventilate if outdoor conditions permit.';
  const co2Advice = 'Increase fresh-air ventilation if outdoor conditions permit; check ventilation if levels remain elevated.';
  const gasAdvice = 'Check and reduce sources such as cooking, cleaning products or combustion. Ventilate if outdoor conditions permit.';
  for (const reading of normalized) {
    const { key, value } = reading;
    const currentUsable = isUsable(reading);
    if (['pm25', 'pm10', 'co2'].includes(key)) {
      // Historical means remain evidence when the live value disappears, but their
      // measurement unit must still be known before comparing them to a guideline.
      if (!validUnit(key, readings[key]?.unit)) continue;
      const history = rollingAverage(samples[key], { now, bucketMs: DEFAULT_POLICY.bucketMs });
      coverage[key] = history.coverage;
      reading.coverage = history.coverage;
      if (history.coverage.complete) reading.average24h = history.average;
      const threshold = p.thresholds[key];
      const latest = rollingAverage(samples[key], { now, periodMs: p.bucketMs, bucketMs: p.bucketMs });
      // Configurable live screening must never change the agency comparison value.
      const dailyHigh = history.average !== null && history.average > DEFAULT_POLICY.thresholds[key];
      const currentHigh = currentUsable && value >= threshold;
      if (!dailyHigh && !currentHigh) continue;
      const confirmed = dailyHigh || (currentHigh && latest.average !== null && latest.average >= threshold);
      const reason = dailyHigh ? 'Complete 24-hour average is above the guideline value.' : confirmed ? 'Current reading and latest complete 5-minute mean meet the screening threshold.' : 'Current reading meets the screening threshold; recent complete statistics do not confirm the trend.';
      if (currentUsable) reading.status = confirmed ? 'flag' : 'watch';
      reading.reason = currentUsable ? reason : `${reading.reason} ${reason}`;
      const label = LABELS[key];
      const headline = dailyHigh ? `${label} 24-hour average elevated` : confirmed ? `${label} is elevated` : `Watch ${label}`;
      const basis = dailyHigh ? reading.basis : `${reading.basis} ${reason}`;
      flags.push(flagFor(reading, confirmed ? 2 : 1, `${key}_${dailyHigh ? '24h' : 'screening'}`, headline, key === 'co2' ? co2Advice : particlesAdvice, confirmed, reason, basis));
    } else if (currentUsable && (key === 'voc' || key === 'nox')) {
      const level = p.gasBands[key].filter(threshold => value >= threshold).length;
      if (!level) continue;
      const latest = rollingAverage(samples[key], { now, periodMs: p.bucketMs, bucketMs: p.bucketMs });
      // Statistics containing startup zeros or out-of-range indices cannot confirm a gas event.
      const confirmed = latest.average !== null && latest.average >= p.gasBands[key][0] && latest.average <= 500;
      const strength = ['', '', 'Strong ', 'Very strong '][level];
      const reason = confirmed ? 'Current index and latest complete 5-minute mean show a relative gas event.' : 'Current relative gas event; recent complete statistics do not confirm the trend.';
      reading.status = confirmed ? 'flag' : 'watch';
      reading.reason = reason;
      flags.push(flagFor(reading, level, `${key}_event`, `${confirmed ? '' : 'Watch: '}${strength}${key === 'voc' ? 'VOC' : 'NOx'} event`, gasAdvice, confirmed, reason));
    } else if (currentUsable && key === 'humidity') {
      const low = value < p.thresholds.humidityLow;
      const high = value > p.thresholds.humidityHigh;
      if (!low && !high) continue;
      const history = rollingAverage(samples[key], { now, periodMs: p.humidityWindowMs, bucketMs: p.bucketMs });
      coverage[key] = history.coverage;
      reading.coverage = history.coverage;
      const means = (Array.isArray(samples[key]) ? samples[key] : []).filter(row => {
        const start = timestamp(row?.start);
        return start !== null && start >= history.coverage.start && start < history.coverage.end;
      }).map(row => numeric(row.mean));
      const confirmed = history.coverage.complete && means.length > 0 && means.every(mean => mean !== null && mean <= 100 && (low ? mean < p.thresholds.humidityLow : mean > p.thresholds.humidityHigh));
      const minutes = p.humidityWindowMs / 60000;
      const reason = confirmed ? `Current humidity and every complete 5-minute mean in the last ${minutes} minutes are outside the target range.` : `Current humidity is outside the target range; a complete ${minutes}-minute trend is not confirmed.`;
      const advice = low ? 'Consider carefully managed humidification if needed; avoid window condensation.' : 'Reduce moisture sources; use exhaust fans or a dehumidifier as appropriate. Ventilate if outdoor conditions permit.';
      reading.status = confirmed ? 'flag' : 'watch';
      reading.reason = reason;
      flags.push(flagFor(reading, 1, `humidity_${low ? 'low' : 'high'}`, `${confirmed ? '' : 'Watch: '}${low ? 'Air is dry' : 'Humidity elevated'}`, advice, confirmed, reason));
    }
  }
  // Relative gas-event strength is not clinically comparable to pollutant exposure.
  // Prefer confirmed evidence, then a stable measurement/action priority.
  flags.sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || (PRIORITY[b.key] ?? 0) - (PRIORITY[a.key] ?? 0));
  const usable = normalized.filter(isUsable);
  const partial = normalized.length === 0 || usable.length !== normalized.length;
  const driver = flags[0] ?? null;
  const hasConfirmed = flags.some(flag => flag.confirmed);
  const hasParticles = flags.some(flag => ['pm25', 'pm10'].includes(flag.key));
  const hasCo2 = flags.some(flag => flag.key === 'co2');
  const hasGas = flags.some(flag => ['voc', 'nox'].includes(flag.key));
  const humidityLow = flags.some(flag => flag.categoryKey === 'humidity_low');
  const humidityHigh = flags.some(flag => flag.categoryKey === 'humidity_high');
  const actionTypes = [hasParticles, hasCo2, hasGas, humidityLow || humidityHigh].filter(Boolean).length;
  let headline = driver?.headline ?? (usable.length === 0 ? 'Waiting for readings' : partial ? 'Limited sensor data' : 'No sensor flags');
  if (actionTypes > 1) headline = hasConfirmed ? 'Several readings elevated' : 'Watch several readings';
  if (driver && partial) headline += ' · partial data';
  let advice = driver?.advice ?? (usable.length === 0 ? 'Check sensor availability and measurement units.' : partial ? 'Some expected readings are unavailable or unusable; review the available measurements.' : 'Keep pollutant sources low and maintain ventilation. These measurements do not certify that every pollutant is low.');
  if (actionTypes > 1) {
    const actions = [];
    if (hasParticles && hasGas) actions.push('Reduce particle and gas sources such as smoke, cooking, cleaning products or combustion.');
    else if (hasParticles) actions.push('Reduce particle sources such as smoke or cooking.');
    else if (hasGas) actions.push('Check and reduce gas sources such as cooking, cleaning products or combustion.');
    if (hasParticles) actions.push('Use suitable particle filtration.');
    if (hasCo2) actions.push('Increase fresh-air ventilation if outdoor conditions permit; check ventilation if levels remain elevated.');
    else if (hasParticles || hasGas) actions.push('Ventilate if outdoor conditions permit.');
    if (hasParticles && hasCo2) actions.push('Particle filtration does not remove CO₂.');
    if (humidityHigh) actions.push('Reduce moisture sources; use exhaust fans or a dehumidifier as appropriate.');
    if (humidityLow) actions.push('Consider carefully managed humidification if needed; avoid window condensation.');
    advice = actions.join(' ');
  }
  return { headline, advice, driver: driver?.key ?? null, severity: driver?.severity ?? 0, categoryKey: driver?.categoryKey ?? (usable.length === 0 ? 'waiting' : partial ? 'partial' : 'normal'), mood: hasConfirmed ? 'act' : driver ? 'watch' : usable.length === 0 ? 'waiting' : partial ? 'watch' : 'calm', partial, coverage, readings: normalized, flags };
}

/** A practical trend requires valid source units and every complete recorded
 * five-minute mean, not merely an elevated average or an isolated live pulse. */
function practicalWindow(rows, key, unit, now, minutes, predicate = () => true) {
  const source = Array.isArray(rows) ? rows : [];
  const invalidStarts = new Set(source.filter(row => normalizeReading(key,
    { value: row?.mean, unit }).status === 'invalid').map(row => timestamp(row?.start)));
  const valid = source.filter(row => !invalidStarts.has(timestamp(row?.start)) &&
    normalizeReading(key, { value: row?.mean, unit }).status === 'ok');
  const history = rollingAverage(valid, { now, periodMs: minutes * 60000, bucketMs: DEFAULT_POLICY.bucketMs });
  const recent = valid.filter(row => {
    const start = timestamp(row?.start);
    return start !== null && start >= history.coverage.start && start < history.coverage.end;
  });
  const confirmed = history.coverage.complete && recent.length >= history.coverage.expectedBuckets &&
    recent.every(row => predicate(numeric(row.mean)));
  return { ...history, confirmed };
}

function practicalAdvice(flags, driver) {
  if (flags.length < 2) return driver?.advice;
  const particles = flags.some(flag => ['pm25', 'pm10'].includes(flag.key));
  const gas = flags.some(flag => ['voc', 'nox'].includes(flag.key));
  const co2 = flags.some(flag => flag.key === 'co2');
  const humidity = flags.some(flag => flag.key === 'humidity');
  const actions = [];
  if (particles && gas) actions.push('Reduce particle and gas sources such as smoke, cooking, cleaning products or combustion.');
  else if (particles) actions.push('Reduce particle sources such as smoke or cooking.');
  else if (gas) actions.push('Check and reduce gas sources such as cooking, cleaning products or combustion.');
  if (particles) actions.push('Use suitable particle filtration.');
  if (co2) actions.push('Increase fresh-air ventilation if outdoor conditions permit; check ventilation if levels remain elevated.');
  else if (particles || gas) actions.push('Ventilate if outdoor conditions permit.');
  if (particles && co2) actions.push('Particle filtration does not remove CO₂.');
  if (humidity) actions.push('Reduce moisture sources; use exhaust fans or a dehumidifier as appropriate.');
  return actions.join(' ');
}

function evaluatePractical({ now, readings, samples, policy }) {
  const normalized = Object.entries(readings ?? {}).map(([key, value]) => normalizeReading(key, value, { now, policy }));
  const flags = [];
  const coverage = {};
  const rules = DEFAULT_POLICY.practical;
  const particlesAdvice = 'Reduce particle sources such as smoke or cooking; use suitable particle filtration. Ventilate if outdoor conditions permit.';
  const co2Advice = 'Increase fresh-air ventilation if outdoor conditions permit; check ventilation if levels remain elevated.';
  const gasAdvice = 'Check and reduce sources such as cooking, cleaning products or combustion. Ventilate if outdoor conditions permit.';
  for (const reading of normalized) {
    const { key, value } = reading;
    const currentUsable = isUsable(reading);
    const source = readings[key];
    if (!validUnit(key, source?.unit)) continue;
    const dailyMetric = ['pm25', 'pm10', 'co2'].includes(key);
    if (dailyMetric) {
      const history = practicalWindow(samples[key], key, source.unit, now, 24 * 60);
      coverage[key] = history.coverage;
      reading.coverage = history.coverage;
      if (history.coverage.complete) reading.average24h = history.average;
      if (history.average !== null && history.average > DEFAULT_POLICY.thresholds[key]) {
        const reason = 'Complete recorded 24-hour average is above the guideline; this is a daily advisory, not an acute or emergency classification.';
        reading.reason = currentUsable ? reason : `${reading.reason} ${reason}`;
        if (currentUsable) reading.status = 'watch';
        flags.push({ ...flagFor(reading, 1, `${key}_24h`, `${LABELS[key]} daily average above guideline`,
          key === 'co2' ? co2Advice : particlesAdvice, true, reason), advisory: true, kind: 'daily_advisory' });
      }
    }
    if (!currentUsable) continue; // Missing/stale current evidence cannot confirm a live attention gate.
    if (rules.gates[key]) {
      let accepted = null;
      let reached = false;
      for (const gate of rules.gates[key]) {
        const above = number => gate.exclusive ? number > gate.threshold : number >= gate.threshold;
        if (!above(value)) continue;
        reached = true;
        const history = practicalWindow(samples[key], key, source.unit, now, gate.minutes, above);
        reading.persistence = { minutes: gate.minutes, threshold: gate.threshold, exclusive: !!gate.exclusive,
          coverage: history.coverage, confirmed: history.confirmed };
        if (history.confirmed) { accepted = gate; break; }
      }
      if (accepted) {
        const relative = key === 'voc' || key === 'nox';
        const reason = `Current reading and every complete recorded 5-minute mean in the last ${accepted.minutes} minutes meet the local attention gate (${accepted.exclusive ? '>' : '≥'}${accepted.threshold}${reading.unit ? ` ${reading.unit}` : ''}). Sampled means are not proof of continuous exposure.`;
        const basis = `${key === 'co2' ? policy.sources.hseVentilation.basis : reading.basis} ${reason} This is a local attention rule, not an agency acute-health limit.${relative ? ' The index is a relative event signal, not a gas concentration or health-risk score.' : ''}`;
        const reference = key === 'co2' ? policy.sources.hseVentilation : reading;
        const headline = relative ? `Persistent relative ${key === 'voc' ? 'VOC' : 'NOx'} event` : `${LABELS[key]} persistently elevated`;
        reading.status = 'flag';
        reading.reason = `${reading.reason} ${reason}`;
        flags.push({ ...flagFor({ ...reading, reference: reference.reference, referenceUrl: reference.referenceUrl },
          accepted.severity, `${key}_persistent`, headline, key === 'co2' ? co2Advice : relative ? gasAdvice : particlesAdvice,
          true, reason, basis), advisory: false, kind: 'attention' });
      } else {
        const routine = dailyMetric ? value >= DEFAULT_POLICY.thresholds[key] : value >= DEFAULT_POLICY.gasBands[key][0];
        if (reached || routine) {
          if (reading.status === 'ok') reading.status = 'info';
          reading.reason += reached ? ' Checking recent trend; no persistence yet. No live attention flag is raised.' :
            ' Below the practical live attention gate; this current reading is informational. Daily averages are evaluated separately where a guideline exists.';
        }
      }
    } else if (key === 'humidity') {
      const rule = rules.humidity;
      const attention = value > rule.attentionHigh;
      const quietHigh = value > rule.advisoryHigh;
      const quietLow = value < rule.advisoryLow;
      if (!attention && !quietHigh && !quietLow) continue;
      const boundary = attention ? rule.attentionHigh : quietLow ? rule.advisoryLow : rule.advisoryHigh;
      const predicate = number => quietLow ? number < boundary : number > boundary;
      const history = practicalWindow(samples[key], key, source.unit, now, rule.minutes, predicate);
      coverage[key] = history.coverage;
      reading.coverage = history.coverage;
      reading.persistence = { minutes: rule.minutes, threshold: boundary, exclusive: true,
        coverage: history.coverage, confirmed: history.confirmed };
      if (attention && history.confirmed) {
        const reason = `Current humidity and every complete recorded 5-minute mean in the last ${rule.minutes} minutes are above ${rule.attentionHigh}%. This is a local moisture-attention rule, not an exposure limit.`;
        reading.status = 'flag';
        reading.reason = reason;
        flags.push({ ...flagFor(reading, 2, 'humidity_persistent_high', 'Humidity persistently high',
          'Reduce moisture sources; use exhaust fans or a dehumidifier as appropriate. Ventilate if outdoor conditions permit.',
          true, reason, `${reading.basis} ${reason}`), advisory: false, kind: 'attention' });
      } else {
        const quietHistory = attention && !history.confirmed ? practicalWindow(samples[key], key,
          source.unit, now, rule.minutes, number => number > rule.advisoryHigh) : history;
        reading.status = 'info';
        reading.reason = quietHistory.confirmed ? quietLow ?
          `Quiet dryness advisory: current humidity and every complete recorded 5-minute mean in the last ${rule.minutes} minutes are below ${rule.advisoryLow}%. Consider carefully managed humidification if needed; avoid window condensation. This does not raise a headline attention flag.` :
          `Quiet moisture advisory: current humidity and every complete recorded 5-minute mean in the last ${rule.minutes} minutes are above ${rule.advisoryHigh}%. Reduce moisture sources and watch for condensation. This does not raise a headline attention flag.` :
          'Checking recent humidity trend; no persistence yet. No headline attention flag is raised.';
      }
    }
  }
  // Live attention comes before lower-priority daily advisories. The stable
  // measurement order is an action priority, not a comparison of health risks.
  flags.sort((a, b) => Number(a.advisory) - Number(b.advisory) || (PRIORITY[b.key] ?? 0) - (PRIORITY[a.key] ?? 0));
  const live = flags.filter(flag => !flag.advisory);
  const usable = normalized.filter(isUsable);
  const partial = normalized.length === 0 || usable.length !== normalized.length;
  const driver = flags[0] ?? null;
  let headline = driver?.headline ?? (usable.length === 0 ? 'Waiting for readings' : partial ? 'Limited sensor data' : 'No current attention flags');
  if (live.length > 1) headline = 'Several persistent issues';
  else if (!live.length && flags.length > 1) headline = 'Several daily averages above guideline';
  if (driver && partial) headline += ' · partial data';
  const advice = practicalAdvice(flags, driver) ?? (usable.length === 0 ? 'Check sensor availability and measurement units.' : partial ?
    'Some expected readings are unavailable or unusable; review the available measurements.' :
    'No persistent attention rule is currently met. Maintain ventilation and source control; these readings do not certify that every pollutant is low.');
  return { headline, advice, driver: driver?.key ?? null,
    severity: live.length ? Math.max(...live.map(flag => flag.severity)) : driver?.severity ?? 0,
    categoryKey: driver?.categoryKey ?? (usable.length === 0 ? 'waiting' : partial ? 'partial' : 'normal'),
    mood: live.length ? 'act' : driver ? 'watch' : usable.length === 0 ? 'waiting' : partial ? 'watch' : 'calm',
    partial, coverage, readings: normalized, flags, profile: 'practical' };
}
