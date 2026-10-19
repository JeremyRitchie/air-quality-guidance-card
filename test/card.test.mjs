import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const registry = new Map([['air-quality-scene-card', class Original {}]]);
globalThis.HTMLElement = class { isConnected = true; };
globalThis.customElements = { get:key=>registry.get(key), define:(key,value)=>registry.set(key,value) };
globalThis.window = { customCards:[], addEventListener(){}, removeEventListener(){} };
globalThis.document = { visibilityState:'visible', body:{style:{overflow:''}},
  addEventListener(){}, removeEventListener(){}, activeElement:null };
const { AirQualityGuidanceCard: Card, AirQualityGuidanceCardEditor: Editor } =
  await import('../src/air-quality-guidance-card.js');
const unit = {pm25:'µg/m³',pm10:'µg/m³',pm1:'µg/m³',pm4:'µg/m³',co2:'ppm',voc:'',nox:'',humidity:'%',temperature:'°C'};
const entity = key=>'sensor.example_'+key;
function makeCard(values={pm25:2,co2:700,voc:80,nox:1,humidity:40,temperature:21,pm10:5,pm1:1,pm4:3}) {
  const card=new Card();
  card.setConfig({entity:entity('pm25'),metric:'pm25',chips:['temperature'],
    ...Object.fromEntries(Object.keys(values).filter(k=>k!=='pm25').map(k=>[k,entity(k)]))});
  card._hass={states:Object.fromEntries(Object.entries(values).map(([key,value])=>[entity(key),
    {state:String(value),last_updated:new Date().toISOString(),attributes:{unit_of_measurement:unit[key]}}])), entities:{}, callWS:async()=>({})};
  return card;
}
function fakeRoot() {
  const nodes=new Map();
  for(const key of ['.scene','.name','.pm-label','.pm-unit','.pm-value','.category','.guidance','.mascot','.chips','.overlay'])
    nodes.set(key,{textContent:'',innerHTML:'',hidden:key==='.overlay',dataset:{},style:{setProperty(){}},title:''});
  return {querySelector:key=>nodes.get(key),nodes};
}
function renderDrawer(card) {
  const root=fakeRoot();const overlay=root.nodes.get('.overlay');
  overlay.querySelector=()=>({addEventListener(){},scrollTop:0,focus(){},innerHTML:''});
  card.shadowRoot=root;card._render24hChart=()=>{};card._renderHeatmap=()=>{};
  card._renderOverlay();return overlay.innerHTML;
}

test('fork registers separately without replacing original card',()=>{
  assert.ok(registry.get('air-quality-scene-card'));
  assert.equal(registry.get('air-quality-guidance-card'),Card);
  assert.ok(registry.get('air-quality-guidance-card-editor'));
});

test('secondary hidden CO2 drives guidance while primary history remains PM2.5',()=>{
  const card=makeCard({pm25:2,co2:1800});
  const result=card._evaluateGuidance();
  assert.equal(result.driver,'co2');
  assert.equal(card._categoryFor(2).label,'Good');
  assert.equal(card._metric().key,'pm25');
  assert.deepEqual(card._chipKeys(card._metric()),['temperature']);
  assert.equal(card._readingMetric('pm1').categories.length,1);
  assert.equal(card._readingMetric('pm1').categories[0].label,'PM1');
});

test('missing primary does not hide valid secondary guidance; blanks are not zero',()=>{
  const card=makeCard({pm25:2,co2:1800,humidity:40});
  delete card._hass.states[entity('pm25')];
  card.shadowRoot=fakeRoot();
  card._update();
  assert.equal(card._guidance.driver,'co2');
  assert.equal(card._guidance.partial,true);
  assert.equal(card.shadowRoot.nodes.get('.pm-value').textContent,'–');
  card._hass.states[entity('co2')].state='';
  card._config.chips=['co2'];
  card._update();
  assert.equal(card.shadowRoot.nodes.get('.chips').innerHTML,'');
});

test('timestamp provenance and missing expected sensor are forwarded honestly',()=>{
  const card=makeCard({pm25:2,co2:700});
  card._hass.states[entity('co2')].last_updated='2001-01-01T00:00:00Z';
  const readings=card._guidanceReadings();
  assert.equal(readings.co2.lastReported,undefined);
  assert.equal(readings.co2.lastUpdated,'2001-01-01T00:00:00Z');
  assert.equal(card._evaluateGuidance().readings.find(x=>x.key==='co2').status,'ok');
  delete card._hass.states[entity('co2')];
  assert.equal(card._guidanceReadings().co2.available,false);
});

test('same-primary config edit invalidates related bindings and history caches',()=>{
  const card=makeCard({pm25:2,co2:700});
  card._relatedIds();
  card._stats={short:[{mean:999}]};
  card.setConfig({entity:entity('pm25'),co2:'sensor.other_co2'});
  card._relatedIds();
  assert.equal(card._related.co2,'sensor.other_co2');
  assert.equal(card._stats,null);
  assert.equal(card._fingerprint,null);
  assert.deepEqual(card._guidanceSamples,{});
});

test('background fetch is one aligned 24-hour batch, cached for five minutes',async()=>{
  const card=makeCard();let calls=[];
  card._hass.callWS=async message=>{calls.push(message);return {};};
  await card._refreshGuidanceStats();await card._refreshGuidanceStats();
  assert.equal(calls.length,1);
  assert.equal(calls[0].type,'recorder/statistics_during_period');
  assert.equal(calls[0].period,'5minute');
  assert.equal(calls[0].statistic_ids.length,6);
  assert.equal(Date.parse(calls[0].end_time)%300000,0);
  assert.equal(Date.parse(calls[0].end_time)-Date.parse(calls[0].start_time),86400000);
  assert.ok(!calls[0].statistic_ids.includes(entity('pm1')));
});

test('failed batch clears claimed averages; old asynchronous response cannot cross config',async()=>{
  const card=makeCard();card._guidanceSamples={pm25:[{mean:999}]};
  card._hass.callWS=async()=>{throw Error('offline');};
  await card._refreshGuidanceStats();
  assert.deepEqual(card._guidanceSamples,{});assert.equal(card._guidanceStatsError,true);
  let resolve;card._guidanceStatsAt=0;
  card._hass.callWS=()=>new Promise(done=>resolve=done);
  const pending=card._refreshGuidanceStats();await Promise.resolve();
  card.setConfig({entity:'sensor.other_pm25',metric:'pm25'});
  resolve({[entity('pm25')]:[{mean:999}]});await pending;
  assert.deepEqual(card._guidanceSamples,{});
});

test('visual editor keeps YAML guidance policy and unrelated card-mod settings',()=>{
  const editor=new Editor();editor._config={guidance_policy:{thresholds:{co2:1200}},card_mod:{style:'custom'},co2:entity('co2')};
  const saved=editor._configFromForm({entity:entity('pm25'),metric:'pm25',chips_mode:'auto',guidance:'all_available'});
  assert.equal(saved.type,'custom:air-quality-guidance-card');
  assert.equal(saved.guidance_policy.thresholds.co2,1200);
  assert.equal(saved.card_mod.style,'custom');assert.equal(saved.co2,entity('co2'));
});

test('drawer guidance names actual readings, coverage and safe authoritative links',()=>{
  const card=makeCard();const result=card._evaluateGuidance();const html=card._guidanceDetails(result);
  assert.match(html,/CO₂/);assert.match(html,/0 \/ 288/);
  assert.match(html,/not a composite AQI/);assert.match(html,/https:\/\/www\.who\.int/);
  assert.doesNotMatch(html,/javascript:/);
});

test('disconnect restores owned scroll lock and removes modal state',()=>{
  const card=makeCard();const overlay={hidden:false},tooltip={hidden:false};
  card.shadowRoot={querySelector:s=>s==='.overlay'?overlay:tooltip};
  card._previousOverflow='auto';document.body.style.overflow='hidden';Card._openCard=card;
  card._refreshTimer=setInterval(()=>{},60000);card.disconnectedCallback();
  assert.equal(overlay.hidden,true);assert.equal(document.body.style.overflow,'auto');assert.equal(Card._openCard,null);
});

test('browser source contains only recorder reads, no device service commands',async()=>{
  const source=await readFile(new URL('../src/air-quality-guidance-card.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/callService|type:\s*["']call_service|climate\.|fan\.|light\.turn/);
  assert.doesNotMatch(source,/Cigarettes smoked|WHO annual guideline/);
  assert.match(source,/width: 44px; height: 44px/);
});

test('partial data with no active flag has a neutral scene rather than green',()=>{
  const card=makeCard({pm25:2,co2:700});delete card._hass.states[entity('pm25')];
  card.shadowRoot=fakeRoot();card._update();
  assert.equal(card._guidance.headline,'Limited sensor data');
  assert.equal(card.shadowRoot.nodes.get('.scene').dataset.category,'offline');
});

test('invalid, wrong-unit and stale current values never display under plausible units',()=>{
  const card=makeCard({pm25:2,co2:700,humidity:40});card.shadowRoot=fakeRoot();
  card._hass.states[entity('pm25')].state='-1';card._update();
  assert.equal(card.shadowRoot.nodes.get('.pm-value').textContent,'–');
  card._hass.states[entity('pm25')].state='900';card._hass.states[entity('pm25')].attributes.unit_of_measurement='ppm';
  card._config.chips=['co2'];card._hass.states[entity('co2')].attributes.unit_of_measurement='µg/m³';card._update();
  assert.equal(card.shadowRoot.nodes.get('.pm-value').textContent,'–');assert.equal(card.shadowRoot.nodes.get('.chips').innerHTML,'');
  card._hass.states[entity('pm25')].attributes.unit_of_measurement='µg/m³';card._hass.states[entity('pm25')].last_reported='2001-01-01T00:00:00Z';card._update();
  assert.equal(card.shadowRoot.nodes.get('.pm-value').textContent,'–');
});

test('PM0.3 context stays outside guidance but can be shown as an honest chip',()=>{
  const card=makeCard({pm25:2});card._config.pm03=entity('pm03');card._config.chips=['pm03'];
  card._hass.states[entity('pm03')]={state:'42',attributes:{unit_of_measurement:'particles/L'}};
  card.shadowRoot=fakeRoot();card._update();
  assert.equal(card._guidanceReadings().pm03,undefined);assert.equal(card._guidance.partial,false);
  assert.match(card.shadowRoot.nodes.get('.chips').innerHTML,/42/);
});

test('drawer headline follows elevated secondary guidance with primary number separate',()=>{
  const card=makeCard({pm25:2,co2:1800});const html=renderDrawer(card);
  assert.match(html,/<div class="sheet-cat">Watch CO₂<\/div>/);
  assert.doesNotMatch(html,/<div class="sheet-cat">Good<\/div>/);
  assert.match(html,/<div class="sheet-pm">.*<b>2<\/b> µg\/m³<\/div>/);
  assert.match(html,/Current: 1800 ppm/);
});

test('missing primary keeps valid secondary charts and a truthful drawer headline',()=>{
  const card=makeCard({pm25:2,co2:1800,humidity:40});delete card._hass.states[entity('pm25')];
  const html=renderDrawer(card);
  assert.match(html,/<div class="sheet-cat">Watch CO₂ · partial data<\/div>/);
  assert.match(html,/data-reading="co2"/);assert.match(html,/data-reading="humidity"/);
  assert.match(html,/<div class="sheet-pm">.*<b>–<\/b>/);
});

test('drawer recorded mean ignores invalid rows and parses numeric means',()=>{
  const card=makeCard({pm25:2});const start=Date.now()-600000;
  card._stats={short:[{start,mean:'10'},{start:start+300000,mean:'30'},
    {start:start+300000,mean:'bad'},{start:start+300000,mean:''}],hourly:[],daily:[]};
  const html=renderDrawer(card);
  assert.match(html,/<div class="tile-title">Last 24 h<\/div>\s*<div class="tile-value">20 µg\/m³<\/div>/);
  const guidance=card._evaluateGuidance();guidance.readings[0].average24h=12;
  assert.match(card._guidanceDetails(guidance),/24 h mean: 12 µg\/m³/);
});

test('legacy primary-only mode stays offline when its selected reading is unavailable',()=>{
  const card=makeCard({pm25:2,co2:1800});card._config.guidance='primary';
  delete card._hass.states[entity('pm25')];card.shadowRoot=fakeRoot();card._update();
  assert.equal(card.shadowRoot.nodes.get('.category').textContent,'Offline');
  assert.equal(card.shadowRoot.nodes.get('.scene').dataset.category,'offline');
  assert.equal(card.shadowRoot.nodes.get('.guidance').textContent,'');
});

test('modal focus wraps over visible summary and excludes collapsed reference links',async()=>{
  const card=makeCard();let onKey,prevented=0,focused=[];
  const close={getClientRects:()=>[{}],focus:()=>focused.push('close')};
  const summary={getClientRects:()=>[{}],focus:()=>focused.push('summary')};
  const hiddenLink={getClientRects:()=>[],focus:()=>focused.push('hidden link')};
  const overlay={hidden:true,querySelector:s=>s==='.close'?close:null,
    querySelectorAll:selector=>selector.includes('summary')?[close,summary,hiddenLink]:[close,hiddenLink]};
  card.shadowRoot={activeElement:summary,querySelector:s=>s==='.overlay'?overlay:null};
  card._renderOverlay=()=>{};card._loadStats=async()=>{};
  const add=window.addEventListener;window.addEventListener=(type,listener)=>{if(type==='keydown')onKey=listener;};
  try {
    await card._openOverlay();focused=[];
    onKey({key:'Tab',shiftKey:false,preventDefault:()=>prevented++});
    assert.deepEqual(focused,['close']);assert.equal(prevented,1);
    card.shadowRoot.activeElement=close;
    onKey({key:'Tab',shiftKey:true,preventDefault:()=>prevented++});
    assert.deepEqual(focused,['close','summary']);assert.equal(prevented,2);
  } finally {card._closeOverlay();window.addEventListener=add;}
});

test('history tooltip is above the opaque modal overlay',()=>{
  const overlay=Number(Card.styles.match(/\.overlay\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  const tooltip=Number(Card.styles.match(/\.tooltip\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  assert.ok(overlay>0);assert.ok(tooltip>overlay);
});

test('incompatible history is neither fetched nor displayed under a false metric unit',async()=>{
  const card=makeCard({pm25:2,co2:700});let ids=[];
  card._hass.states[entity('pm25')].attributes.unit_of_measurement='ppm';
  card._hass.callWS=async request=>{ids.push(...request.statistic_ids);return {};};
  await card._loadStats();
  assert.ok(!ids.includes(entity('pm25')));assert.ok(ids.includes(entity('co2')));
  card._stats={short:[{start:Date.now()-300000,mean:500,max:500}],hourly:[],daily:[]};
  const html=renderDrawer(card);
  assert.match(html,/Primary history is unavailable/);assert.doesNotMatch(html,/500/);
});

test('compatible recorded history remains available when the current sensor is unavailable',async()=>{
  const card=makeCard({pm25:2});let ids=[];
  card._hass.states[entity('pm25')].state='unavailable';
  card._hass.callWS=async request=>{ids.push(...request.statistic_ids);return {[entity('pm25')]:[{start:Date.now()-600000,mean:12,max:15}]};};
  await card._loadStats();assert.equal(ids.filter(id=>id===entity('pm25')).length,3);
  const html=renderDrawer(card);
  assert.doesNotMatch(html,/Primary history is unavailable/);
  assert.match(html,/<div class="tile-value">12 µg\/m³<\/div>/);
});
