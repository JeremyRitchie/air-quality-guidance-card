import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, evaluateGuidance, normalizeReading, rollingAverage } from '../src/guidance.js';

const BUCKET = 5 * 60 * 1000;
const NOW = Date.parse('2026-10-19T12:03:00Z');
const END = Math.floor(NOW / BUCKET) * BUCKET;
const reading = (value, unit, extra = {}) => ({ value, unit, ...extra });
const buckets = (mean, count = 288) => Array.from({ length: count }, (_, i) => ({ start: END - (count - i) * BUCKET, mean }));
const evaluate = (readings, samples = {}, extra = {}) => evaluateGuidance({ now: NOW, readings, samples, ...extra });

test('normal readings use neutral language and relative gas baselines', () => {
  const result = evaluate({ pm25: reading(4, 'µg/m³'), pm10: reading(8, 'μg/m³'), co2: reading(650, 'ppm'), voc: reading(100, ''), nox: reading(1, ''), humidity: reading(45, '%') });
  assert.equal(result.headline, 'No sensor flags');
  assert.equal(result.severity, 0);
  assert.equal(result.partial, false);
  assert.equal(result.flags.length, 0);
  assert.match(result.readings.find(r => r.key === 'nox').basis, /not gas concentrations or health exposure limits/);
  assert.doesNotMatch(result.headline, /safe|healthy|hazard/i);
});

test('blank, nonfinite, boolean and negative values never become reassuring zeros', () => {
  for (const value of ['', ' ', null, undefined, false, NaN, Infinity, -1, 'unknown', 'unavailable']) {
    const result = evaluate({ pm25: reading(value, 'µg/m³') });
    assert.equal(result.headline, 'Waiting for readings', String(value));
    assert.equal(result.readings[0].status, 'invalid');
  }
  assert.equal(normalizeReading('pm25', reading('0', 'ug/m3')).value, 0);
});

test('measurement units are validated; unitless indices cannot be ppb or AQI', () => {
  for (const [key, value, unit] of [['pm25', 12, 'ppm'], ['co2', 600, 'µg/m³'], ['voc', 150, 'ppb'], ['nox', 30, 'µg/m³'], ['humidity', 45, '°C']]) {
    assert.equal(evaluate({ [key]: reading(value, unit) }).readings[0].status, 'invalid');
  }
  for (const value of [0, 501]) assert.equal(evaluate({ nox: reading(value, '') }).readings[0].status, 'invalid');
  assert.match(evaluate({ voc: reading(0, '') }).readings[0].reason, /warming up/);
  assert.equal(evaluate({ humidity: reading(101, '%') }).readings[0].status, 'invalid');
});

test('an unchanged HA state is not stale merely because last_updated is old', () => {
  const old = new Date(NOW - 10 * 86400000).toISOString();
  assert.equal(evaluate({ co2: reading(600, 'ppm', { lastUpdated: old }) }).readings[0].status, 'ok');
  assert.equal(evaluate({ co2: reading(600, 'ppm', { lastReported: old }) }).readings[0].status, 'stale');
  assert.equal(evaluate({ co2: reading(600, 'ppm', { lastUpdated: old, lastReported: NOW }) }).readings[0].status, 'ok');
});

test('CO₂ zero is an invalid ambient reading while zero particle readings remain valid', () => {
  const co2 = evaluate({ co2: reading(0, 'ppm') });
  assert.equal(co2.readings[0].status, 'invalid');
  assert.equal(co2.headline, 'Waiting for readings');
  for (const key of ['pm25', 'pm10', 'pm1', 'pm4']) {
    const result = evaluate({ [key]: reading(0, 'µg/m³') });
    assert.equal(result.readings[0].status, 'ok');
    assert.equal(result.readings[0].value, 0);
  }
});

test('explicit future reporting timestamps allow five minutes of clock skew, not unlimited freshness', () => {
  assert.equal(evaluate({ co2: reading(600, 'ppm', { lastReported: NOW + 5 * 60000 }) }).readings[0].status, 'ok');
  const future = evaluate({ co2: reading(600, 'ppm', { lastReported: NOW + 5 * 60000 + 1 }) });
  assert.equal(future.readings[0].status, 'invalid');
  assert.match(future.readings[0].reason, /future/);
  assert.equal(evaluate({ co2: reading(600, 'ppm', { lastUpdated: NOW + 86400000 }) }).readings[0].status, 'ok');
});

test('temperature in Fahrenheit converts to context without an air-quality cutoff', () => {
  const result = evaluate({ temperature: reading(77, '°F') });
  assert.equal(result.readings[0].value, 25);
  assert.equal(result.readings[0].unit, '°C');
  assert.equal(result.flags.length, 0);
  for (const [value, unit] of [[-5, '°C'], [23, '°F']]) {
    const cold = evaluate({ temperature: reading(value, unit) });
    assert.equal(cold.readings[0].value, -5);
    assert.equal(cold.readings[0].status, 'ok');
    assert.equal(cold.flags.length, 0);
  }
});

test('PM₁ and PM₄ remain context even at a very high value', () => {
  const result = evaluate({ pm1: reading(999, 'µg/m³'), pm4: reading(999, 'µg/m³') });
  assert.equal(result.flags.length, 0);
  for (const item of result.readings) assert.match(item.basis, /context and trends/);
});

test('a complete 24-hour window has all 288 aligned five-minute buckets', () => {
  const result = rollingAverage(buckets(18), { now: NOW });
  assert.equal(result.average, 18);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.expectedBuckets, 288);
  assert.equal(result.coverage.end, END);
  assert.equal(result.coverage.start, END - 86400000);
  const iso = buckets(18).map(row => ({ ...row, start: new Date(row.start).toISOString(), end: new Date(row.start + BUCKET).toISOString() }));
  assert.equal(rollingAverage(iso, { now: NOW }).average, 18);
});

test('a single gap, overlapping bucket or wrong interval prevents a 24-hour claim', () => {
  for (const change of [rows => rows.splice(22, 1), rows => { rows[22].start += 1000; }, rows => { rows[22].end = rows[22].start + BUCKET * 2; }, rows => { rows[22].mean = NaN; }]) {
    const rows = buckets(30);
    change(rows);
    const result = evaluate({ pm25: reading(30, 'µg/m³') }, { pm25: rows });
    assert.equal(result.coverage.pm25.complete, false);
    assert.equal(result.readings[0].average24h, undefined);
    assert.notEqual(result.categoryKey, 'pm25_24h');
  }
});

test('partial or future buckets never fill missing coverage', () => {
  const rows = buckets(100).slice(1);
  rows.push({ start: END, mean: 100 });
  const result = rollingAverage(rows, { now: NOW });
  assert.equal(result.coverage.availableBuckets, 287);
  assert.equal(result.average, null);
});

test('identical duplicates are harmless, conflicting duplicates invalidate their bucket', () => {
  const rows = buckets(20);
  assert.equal(rollingAverage([...rows, rows[0]], { now: NOW }).coverage.complete, true);
  const result = rollingAverage([...rows, { ...rows[0], mean: 200 }], { now: NOW });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.availableBuckets, 287);
});

test('WHO and Health Canada comparisons use strict greater-than on complete 24-hour means', () => {
  for (const [key, threshold, unit] of [['pm25', 15, 'µg/m³'], ['pm10', 45, 'µg/m³'], ['co2', 1000, 'ppm']]) {
    const at = evaluate({ [key]: reading(threshold, unit) }, { [key]: buckets(threshold) });
    assert.equal(at.categoryKey, `${key}_screening`);
    const above = evaluate({ [key]: reading(0, unit) }, { [key]: buckets(threshold + 1) });
    assert.equal(above.categoryKey, `${key}_24h`);
    assert.equal(above.readings[0].average24h, threshold + 1);
    assert.match(above.headline, /24-hour average/);
  }
});

test('live screening uses inclusive boundaries without claiming an instantaneous agency limit', () => {
  for (const [key, threshold, unit] of [['pm25', 15, 'µg/m³'], ['pm10', 45, 'µg/m³'], ['co2', 1000, 'ppm']]) {
    assert.equal(evaluate({ [key]: reading(threshold - 0.01, unit) }).flags.length, 0);
    const at = evaluate({ [key]: reading(threshold, unit) });
    assert.equal(at.mood, 'watch');
    assert.equal(at.flags[0].confirmed, false);
    assert.match(at.flags[0].basis, /screening/i);
    assert.doesNotMatch(at.headline, /guideline|danger|unsafe/i);
  }
});

test('a customized live screening threshold never changes the agency 24-hour guideline', () => {
  const result = evaluate({ co2: reading(850, 'ppm') }, { co2: buckets(850) }, { policy: { thresholds: { co2: 800 } } });
  assert.equal(result.categoryKey, 'co2_screening');
  assert.doesNotMatch(result.headline, /24-hour/);
});

test('current plus latest complete mean confirms a trend, never continuous exposure', () => {
  const result = evaluate({ co2: reading(1100, 'ppm') }, { co2: buckets(1050, 1) });
  assert.equal(result.flags[0].confirmed, true);
  assert.equal(result.mood, 'act');
  assert.match(result.flags[0].reason, /latest complete 5-minute mean/);
  assert.doesNotMatch(result.flags[0].reason, /continuously|exposure|for 5 minutes/i);
});

test('an old high bucket or a low latest mean cannot confirm a current event', () => {
  const old = [{ start: END - 2 * BUCKET, mean: 1300 }];
  const low = buckets(700, 1);
  assert.equal(evaluate({ co2: reading(1100, 'ppm') }, { co2: old }).flags[0].confirmed, false);
  assert.equal(evaluate({ co2: reading(1100, 'ppm') }, { co2: low }).flags[0].confirmed, false);
});

test('high CO₂ remains the driver when PM₂.₅ is low and advice never suggests a filter fixes CO₂', () => {
  const result = evaluate({ co2: reading(1400, 'ppm'), pm25: reading(2, 'µg/m³') });
  assert.equal(result.driver, 'co2');
  assert.match(result.advice, /fresh-air ventilation/);
  assert.doesNotMatch(result.advice, /filtration|purifier/);
});

test('multiple drivers retain both actions and distinguish particle filtration from CO₂ removal', () => {
  const result = evaluate({ co2: reading(1400, 'ppm'), pm25: reading(30, 'µg/m³') });
  assert.deepEqual(new Set(result.flags.map(flag => flag.key)), new Set(['co2', 'pm25']));
  assert.match(result.advice, /particle filtration/);
  assert.match(result.advice, /filtration does not remove CO₂/);
});

test('a provisional very strong VOC event cannot suppress confirmed particle evidence or its action', () => {
  const result = evaluate({ pm25: reading(500, 'µg/m³'), voc: reading(400, '') }, { pm25: buckets(300) });
  assert.equal(result.driver, 'pm25');
  assert.equal(result.categoryKey, 'pm25_24h');
  assert.equal(result.mood, 'act');
  assert.equal(result.headline, 'Several readings elevated');
  assert.match(result.advice, /particle filtration/);
  assert.match(result.advice, /gas sources/);
  assert.equal(result.flags.find(flag => flag.key === 'voc').confirmed, false);
});

test('combined particle, CO₂ and NOx advice retains each needed action', () => {
  const result = evaluate({ pm25: reading(30, 'µg/m³'), co2: reading(1300, 'ppm'), nox: reading(300, '') }, { co2: buckets(1200, 1) });
  assert.equal(result.driver, 'co2');
  assert.equal(result.mood, 'act');
  assert.match(result.advice, /particle filtration/);
  assert.match(result.advice, /fresh-air ventilation if outdoor conditions permit/);
  assert.match(result.advice, /combustion/);
  assert.match(result.advice, /filtration does not remove CO₂/);
  assert.equal(result.flags.length, 3);
});

test('manufacturer gas bands are relative event strengths, with their own NOx baseline', () => {
  for (const [key, bands] of Object.entries(DEFAULT_POLICY.gasBands)) {
    assert.equal(evaluate({ [key]: reading(bands[0] - 0.1, '') }).flags.length, 0);
    for (let i = 0; i < bands.length; i++) {
      const result = evaluate({ [key]: reading(bands[i], '') });
      assert.equal(result.severity, i + 1);
      assert.equal(result.flags[0].confirmed, false);
      assert.match(result.flags[0].basis, /relative gas events/);
      assert.doesNotMatch(result.headline, /safe|hazard|NO₂|ppb|µg/i);
    }
  }
  const nox = evaluate({ nox: reading(20, '') }, { nox: buckets(20, 1) });
  assert.equal(nox.flags[0].confirmed, true);
  assert.equal(evaluate({ nox: reading(1, '') }).flags.length, 0);
});

test('humidity at 30% and 50% is unflagged; outside is provisional without complete history', () => {
  for (const value of [30, 50]) assert.equal(evaluate({ humidity: reading(value, '%') }).flags.length, 0);
  for (const value of [29.9, 50.1]) assert.equal(evaluate({ humidity: reading(value, '%') }).flags[0].confirmed, false);
});

test('humidity trend requires six valid outside-range means, not just an outside-range average', () => {
  const high = evaluate({ humidity: reading(60, '%') }, { humidity: buckets(60, 6) });
  assert.equal(high.flags[0].confirmed, true);
  const mixed = buckets(60, 6);
  mixed[2].mean = 45;
  assert.equal(evaluate({ humidity: reading(60, '%') }, { humidity: mixed }).flags[0].confirmed, false);
  assert.equal(evaluate({ humidity: reading(60, '%') }, { humidity: buckets(60, 5) }).flags[0].confirmed, false);
});

test('a known issue survives unavailable expected readings; all missing and partial data stay explicit', () => {
  const known = evaluate({ co2: reading(1300, 'ppm'), pm25: reading(null, 'µg/m³', { available: false }) });
  assert.equal(known.driver, 'co2');
  assert.equal(known.partial, true);
  assert.match(known.headline, /partial data/);
  assert.equal(evaluate({ co2: reading(600, 'ppm'), pm25: reading(null, 'µg/m³') }).headline, 'Limited sensor data');
  assert.equal(evaluate({}).headline, 'Waiting for readings');
});

test('complete PM/CO₂ history stays actionable when its current reading is unavailable, invalid or stale', () => {
  for (const [key, mean, unit] of [['pm25', 30, 'µg/m³'], ['pm10', 60, 'µg/m³'], ['co2', 1300, 'ppm']]) {
    for (const current of [reading(null, unit, { available: false }), reading('', unit), reading(mean, unit, { lastReported: NOW - 86400000 })]) {
      const result = evaluate({ [key]: current }, { [key]: buckets(mean) });
      assert.equal(result.driver, key);
      assert.equal(result.categoryKey, `${key}_24h`);
      assert.equal(result.partial, true);
      assert.match(result.headline, /24-hour average elevated · partial data/);
      assert.equal(result.mood, 'act');
      assert.equal(result.readings[0].average24h, mean);
      assert.ok(['invalid', 'stale'].includes(result.readings[0].status));
    }
  }
  const mixed = evaluate({ pm25: reading(null, 'µg/m³', { available: false }), co2: reading(600, 'ppm') }, { pm25: buckets(30) });
  assert.equal(mixed.driver, 'pm25');
  assert.match(mixed.headline, /partial data/);
});

test('historical means with an incompatible current sensor unit cannot support agency comparisons', () => {
  const result = evaluate({ pm25: reading(null, 'ppm', { available: false }) }, { pm25: buckets(30) });
  assert.equal(result.flags.length, 0);
  assert.equal(result.readings[0].average24h, undefined);
});

const practical = (readings, samples = {}) => evaluate(readings, samples, { policy: { profile: 'practical' } });

test('practical profile keeps routine variation and isolated spikes out of the headline', () => {
  for (const [key, value, unit] of [['pm25', 20, 'µg/m³'], ['pm10', 70, 'µg/m³'],
    ['co2', 1200, 'ppm'], ['voc', 180, ''], ['nox', 30, ''], ['humidity', 56, '%']]) {
    const result = practical({ [key]: reading(value, unit) });
    assert.equal(result.headline, 'No current attention flags', key);
    assert.equal(result.flags.length, 0, key);
    assert.equal(result.mood, 'calm', key);
  }
  const pulse = practical({ co2: reading(2500, 'ppm') }, { co2: buckets(2500, 1) });
  assert.equal(pulse.flags.length, 0);
  assert.equal(pulse.readings[0].status, 'info');
  assert.match(pulse.readings[0].reason, /Checking recent trend; no persistence yet/);
});

test('practical pollutant attention gates need every complete mean and current evidence', () => {
  for (const [key, slow, fast, unit, exclusive] of [['pm25', 35, 75, 'µg/m³', false],
    ['pm10', 100, 150, 'µg/m³', false], ['co2', 1500, 2000, 'ppm', true],
    ['voc', 250, 400, '', false], ['nox', 150, 300, '', false]]) {
    const value = slow + (exclusive ? 0.1 : 0);
    const slowResult = practical({ [key]: reading(value, unit) }, { [key]: buckets(value, 6) });
    assert.equal(slowResult.categoryKey, `${key}_persistent`, key);
    assert.equal(slowResult.severity, 2, key);
    assert.equal(slowResult.mood, 'act', key);
    const fastResult = practical({ [key]: reading(fast, unit) }, { [key]: buckets(fast, 2) });
    assert.equal(fastResult.severity, 3, key);
    assert.equal(fastResult.readings[0].persistence.minutes, 10, key);
    for (const rows of [buckets(value, 5), [...buckets(value, 6).slice(0, 2), ...buckets(value, 6).slice(3)],
      buckets(value, 6).map((row, index) => index === 2 ? { ...row, mean: slow - 1 } : row)]) {
      assert.equal(practical({ [key]: reading(value, unit) }, { [key]: rows }).flags.length, 0, key);
    }
    assert.equal(practical({ [key]: reading(slow - 0.1, unit) }, { [key]: buckets(value, 6) }).flags.length, 0, key);
    assert.equal(practical({ [key]: reading(fast, unit) }, { [key]: buckets(fast, 1) }).flags.length, 0, key);
  }
});

test('practical CO₂1500 slow boundary is exclusive, while2000 fast boundary is inclusive', () => {
  assert.equal(practical({ co2: reading(1500, 'ppm') }, { co2: buckets(1500, 6) }).flags.length, 0);
  assert.equal(practical({ co2: reading(1500.1, 'ppm') }, { co2: buckets(1500.1, 6) }).severity, 2);
  assert.equal(practical({ co2: reading(2000, 'ppm') }, { co2: buckets(2000, 2) }).severity, 3);
  assert.equal(practical({ co2: reading(1999.9, 'ppm') }, { co2: buckets(2000, 2) }).flags.length, 0);
});

test('practical trends reject stale, unavailable, invalid-unit and invalid historical readings', () => {
  for (const current of [reading(2500, 'ppm', { lastReported: NOW - 86400000 }),
    reading(null, 'ppm', { available: false }), reading(2500, 'µg/m³')]) {
    const result = practical({ co2: current }, { co2: buckets(2500, 2) });
    assert.equal(result.flags.length, 0);
    assert.equal(result.partial, true);
  }
  for (const key of ['voc', 'nox']) {
    const invalid = buckets(450, 2);invalid[0].mean = 501;
    assert.equal(practical({ [key]: reading(450, '') }, { [key]: invalid }).flags.length, 0);
    invalid[0].mean = 0;
    assert.equal(practical({ [key]: reading(450, '') }, { [key]: invalid }).flags.length, 0);
  }
  const duplicate = buckets(2500, 2);duplicate.push({ ...duplicate[0], mean: 900 });
  assert.equal(practical({ co2: reading(2500, 'ppm') }, { co2: duplicate }).flags.length, 0);
});

test('practical daily WHO and HC comparisons remain lower-priority advisories even after improvement', () => {
  for (const [key, threshold, current, unit] of [['pm25', 15, 2, 'µg/m³'],
    ['pm10', 45, 5, 'µg/m³'], ['co2', 1000, 600, 'ppm']]) {
    assert.equal(practical({ [key]: reading(current, unit) }, { [key]: buckets(threshold) }).flags.length, 0);
    for (const live of [reading(current, unit), reading(null, unit, { available: false })]) {
      const result = practical({ [key]: live }, { [key]: buckets(threshold + 1) });
      assert.equal(result.categoryKey, `${key}_24h`);
      assert.equal(result.severity, 1);
      assert.equal(result.mood, 'watch');
      assert.equal(result.flags[0].advisory, true);
      assert.match(result.headline, /daily average above guideline/);
      assert.match(result.flags[0].reason, /not an acute or emergency/);
    }
  }
  const gap = buckets(30).slice(1);
  assert.equal(practical({ pm25: reading(2, 'µg/m³') }, { pm25: gap }).flags.length, 0);
});

test('practical live attention outranks daily advice and combines the required actions', () => {
  const result = practical({ pm25: reading(2, 'µg/m³'), co2: reading(2000, 'ppm'), nox: reading(300, '') },
    { pm25: buckets(20), co2: buckets(2000, 2), nox: buckets(300, 2) });
  assert.equal(result.driver, 'co2');
  assert.equal(result.headline, 'Several persistent issues');
  assert.equal(result.mood, 'act');
  assert.equal(result.flags.length, 3);
  assert.match(result.advice, /particle filtration/);
  assert.match(result.advice, /filtration does not remove CO₂/);
  assert.match(result.advice, /combustion/);
  assert.match(result.flags.find(flag => flag.key === 'co2').basis, /workplace ventilation indicator/);
});

test('practical humidity56% is normal; only above65% across12means raises attention', () => {
  for (const value of [25, 30, 50, 56, 60]) {
    const result = practical({ humidity: reading(value, '%') }, { humidity: buckets(value, 12) });
    assert.equal(result.flags.length, 0, String(value));
    assert.equal(result.readings[0].status, 'ok', String(value));
  }
  const high = practical({ humidity: reading(65.1, '%') }, { humidity: buckets(65.1, 12) });
  assert.equal(high.categoryKey, 'humidity_persistent_high');assert.equal(high.severity, 2);
  assert.equal(practical({ humidity: reading(66, '%') }, { humidity: buckets(66, 11) }).flags.length, 0);
  const mixed = buckets(66, 12);mixed[2].mean = 65;
  assert.equal(practical({ humidity: reading(66, '%') }, { humidity: mixed }).flags.length, 0);
});

test('practical humidity moisture/dryness advisories stay quiet in readings only', () => {
  for (const value of [24.9, 60.1, 65]) {
    const result = practical({ humidity: reading(value, '%') }, { humidity: buckets(value, 12) });
    assert.equal(result.headline, 'No current attention flags');
    assert.equal(result.flags.length, 0);
    assert.equal(result.readings[0].status, 'info');
    assert.match(result.readings[0].reason, /Quiet .* advisory/);
  }
  const rising = practical({ humidity: reading(66, '%') }, { humidity: buckets(61, 12) });
  assert.equal(rising.flags.length, 0);assert.match(rising.readings[0].reason, /Quiet moisture advisory/);
  const incomplete = practical({ humidity: reading(20, '%') }, { humidity: buckets(20, 11) });
  assert.match(incomplete.readings[0].reason, /Checking recent humidity trend/);
});

test('practical relative gas flags remain event guidance rather than concentration or health scores', () => {
  const result = practical({ voc: reading(400, ''), nox: reading(300, '') },
    { voc: buckets(400, 2), nox: buckets(300, 2) });
  assert.equal(result.flags.length, 2);
  for (const flag of result.flags) {
    assert.match(flag.headline, /relative .* event/);
    assert.match(flag.basis, /not a gas concentration or health-risk score/);
    assert.doesNotMatch(flag.headline, /danger|unsafe|hazard|NO₂|ppb/i);
  }
});

test('practical missing data stay explicit and PM1/PM4/temperature remain context only', () => {
  assert.equal(practical({}).headline, 'Waiting for readings');
  const partial = practical({ pm25: reading(null, 'µg/m³'), co2: reading(800, 'ppm') });
  assert.equal(partial.headline, 'Limited sensor data');assert.equal(partial.partial, true);
  const context = practical({ pm1: reading(999, 'µg/m³'), pm4: reading(999, 'µg/m³'), temperature: reading(-5, '°C') });
  assert.equal(context.flags.length, 0);assert.equal(context.headline, 'No current attention flags');
});
