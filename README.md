# Air Quality Guidance Card

A Home Assistant dashboard card that keeps the artwork and recorded-history views of [keranm/air-quality-scene-card](https://github.com/keranm/air-quality-scene-card), while giving the headline and mascot guidance from the available readings on the device. Fork version **2.0.2**, based on upstream **1.3.1**. MIT attribution and the original bundle are retained.

The headline can respond to PM2.5, PM10, CO₂, relative VOC/NOx events and humidity. PM1, PM4 and temperature remain useful context without invented health cutoffs. A hidden chip still participates in guidance. “No sensor flags” means no configured rule is currently flagged; it is **not a composite AQI, health score or assurance that every pollutant is low**.

The 24-hour bar-chart tooltips show the date and exact start–end time of each rolling 30-minute window, including seconds and the local timezone. A bar summarizes recorded statistics within that interval; it is not an individual sensor sample. Compact axis labels remain unchanged.

## Install alongside the original

Add `https://github.com/JeremyRitchie/air-quality-guidance-card` as a HACS custom **Dashboard** repository. Download version 2.0.2 and reload the browser. HACS uses the explicit `air-quality-guidance-card.js` filename in `hacs.json`.

The new type is `custom:air-quality-guidance-card`, with a distinct editor. Keep the original resource if other views still use `custom:air-quality-scene-card`; there is no load-order conflict. The original `dist/air-quality-scene-card.js` remains unchanged for reference/rollback, but the resource to register for this fork is **`dist/air-quality-guidance-card.js`**.

Manual alternative: copy the new bundle to `/config/www/air-quality-guidance-card.js`, register `/local/air-quality-guidance-card.js?v=2.0.2` as a JavaScript module, and reload the browser. No backend integration or HA restart is required.

```yaml
type: custom:air-quality-guidance-card
entity: sensor.example_pm2_5
metric: pm25
name: Indoor Air Quality
guidance: all_available
# Explicit mappings override discovery from the same HA device.
co2: sensor.example_carbon_dioxide
pm10: sensor.example_pm10
pm1: sensor.example_pm1
pm4: sensor.example_pm4
voc: sensor.example_voc_index
nox: sensor.example_nox_index
temperature: sensor.example_temperature
humidity: sensor.example_humidity
chips: [temperature, humidity, co2, voc, nox]
```

`entity` and `metric` still select the big numeric reading, its unit, and the primary history charts. `guidance` is `all_available` by default; `primary` restores a primary-only scene headline. The visual editor retains YAML-only settings. Optional `guidance_policy` overrides are documented by `DEFAULT_POLICY` in `src/guidance.js`; agency 24-hour comparison values remain fixed when local live-screening thresholds change.

## Practical attention profile

To keep routine changes from taking over the headline, opt in per card:

```yaml
guidance: all_available
guidance_policy:
  profile: practical
```

The original evidence-aware profile remains the default for compatibility. Practical mode distinguishes routine trends, persistent attention cues and complete daily-reference advisories. These operational gates are **local display choices, not agency safe/unsafe or acute-health limits**:

* **PM2.5:** six complete five-minute means at or above 35 µg/m³, or two at or above 75. **PM10:** six at or above 100, or two at or above 150. The compatible current reading must still meet the same gate.
* **CO₂:** six complete five-minute means above 1,500 ppm, or two at or above 2,000, plus a current reading meeting that gate. [HSE](https://www.hse.gov.uk/ventilation/using-co2-monitors.htm) identifies consistently high CO₂ as a workplace ventilation indicator; the timing and fast gate here are local choices, not a residential exposure limit.
* **VOC/NOx indices:** six complete five-minute means at or above VOC 250 / NOx 150, or two at or above VOC 400 / NOx 300, plus a matching current value. These use Sensirion example control bands for **relative events**, with locally chosen persistence. They are not pollutant concentrations or a medical risk score.
* **Humidity:** a current reading above 65% and twelve complete five-minute means above 65% produce an attention cue. Sustained readings above 60%, or below 25%, remain quiet moisture/comfort advisories. A bedroom at 56% produces no humidity warning. [EPA](https://www.epa.gov/mold/mold-course-chapter-9) recommends below 60%, ideally 30–50%; the 65%, 25% and one-hour tolerance choices are local, not agency thresholds.
* **Daily references remain separate:** all 288 complete five-minute means are still required for WHO PM2.5 >15 / PM10 >45 µg/m³ and Health Canada CO₂ >1,000 ppm comparisons. These stay lower-priority daily advisories even if current readings have improved; the practical live gates never replace them.

Every expected five-minute mean must meet a persistence gate; a single spike cannot pull a window average across it. Missing intervals do not establish persistence. Say “six elevated five-minute means,” not “every instant stayed elevated.” Short cooking or shower peaks stay visible in the measurements and trends without an attention headline. A prolonged strong event can still warrant source control even when cooking caused it. PM1, PM4 and temperature remain context only.

“No current attention flags” means no local persistent rule is active; it does not certify safe air. Missing sensors and incomplete recorder history remain explicit. The card does not identify the pollutant source or infer that a source is harmless. The [EPA indoor-smoke guide, section 5.5](https://nepis.epa.gov/Exe/ZyPURL.cgi?Dockey=P101HCVK.txt) supports smoothing erratic short readings; it does not prescribe these exact local gates.

## Default profile and measurement interpretation

* **Particles:** WHO 2021 24-hour guideline concentrations are PM2.5 15 µg/m³ and PM10 45 µg/m³. A guideline comparison requires all **288 aligned, complete five-minute mean buckets** in the last 24 hours. Current readings at these values are local screening cues, not WHO instantaneous limits. PM1 and PM4 do not borrow the PM2.5 health scale.
* **CO₂:** Health Canada recommends 1,000 ppm as a 24-hour average. Current elevation is separately labelled screening information. Suitable particle filtration does not remove CO₂; advice distinguishes source control, filtration and fresh-air ventilation when outdoor conditions permit.
* **VOC/NOx:** only unitless Sensirion indices are accepted, not TVOC ppb, NO₂ concentration or an AQI. Manufacturer example event bands are VOC 150/250/400 and NOx 20/150/300. They show relative event strength, **not clinical risk categories**. Learned backgrounds adapt; low indices do not establish pollutant absence. No physical sensor warm-up timer is inferred from HA connection time or `last_updated`. An index of zero is treated as not ready.
* **Humidity:** 30–50% RH comes from Health Canada moisture guidance. The complete 30-minute trend is a local display choice. Cold surfaces may require lower indoor humidity to avoid condensation. Temperature is context only.
* **Evidence and gaps:** a current value alone produces provisional/watch wording. A recent complete five-minute mean can confirm a sampled trend, which is not proof of continuous exposure. Complete 24-hour evidence remains useful even if the current reading is unavailable. Missing, stale, nonfinite and incompatible-unit readings are not converted into zeros or reassuring flags. `last_updated` alone is never used to declare an unchanged sensor stale.

The drawer explains the driver, available/missing readings, recorded coverage and sources. Historical colour bands are retained as **visual context**, not an official AQI or validated continuous exposure estimate. The old “cigarettes smoked” metaphor and comparison of a short average against an annual guideline have been removed.

Primary references:

* [WHO global air quality guidelines, 2021](https://www.who.int/publications/i/item/9789240034228)
* [Health Canada residential CO₂ guideline](https://www.canada.ca/en/health-canada/services/publications/healthy-living/residential-indoor-air-quality-guidelines-carbon-dioxide.html)
* [Health Canada moisture and mould guidance](https://www.canada.ca/en/health-canada/services/publications/healthy-living/addressing-moisture-mould-your-home.html)
* [Health Canada indoor air improvement guidance](https://www.canada.ca/en/health-canada/services/air-quality/improve-indoor-air-quality-in-your-home.html)
* [Sensirion VOC/NOx integration note](https://sensirion.com/media/documents/ACD82D45/6294DFC0/Info_Note_Integration_VOC_NOx_Sensor.pdf)
* [Sensirion SEN5x engineering guidance](https://sensirion.com/en/media/documents/25AB572C/62B463AA/Sensirion_Engineering_Guidelines_SEN5x.pdf)

## Statistics, privacy and lifecycle

While the card is visible, it requests one batched HA recorder query at most every five minutes for PM2.5, PM10, CO₂, humidity, VOC and NOx five-minute statistics. That request covers one aligned 24-hour window, not ten days. Opening the drawer separately loads the original longer history views. Recorder failures leave averages unavailable; an old async response cannot populate a changed card configuration. Charts begin empty and fill as HA records the new device.

All reads stay inside the existing authenticated HA connection. The card calls no device service, creates no entities/automations/notifications and sends no measurements to outside servers. Reference links open only when selected. Timers, observers, keyboard listeners and owned body-scroll locks are cleaned up on disconnect. Close is a 44px target, Escape closes, and the original `.scene`, `.overlay`, `.backdrop` and `.sheet` selectors remain available for themes.

Theme integration: a fixed overlay can be trapped by `isolation:isolate`, transforms, filters or containment on a structural ancestor. Keep **transparent structural wrappers** free of those stacking boundaries; ordinary leaf glass surfaces can remain. The drawer needs an opaque surface and an overlay above the dashboard/HA toolbar. Verify both desktop and phone hit-testing after a theme change. Do not mask a stacking failure with transparency or test by clicking a real device behind it.

## Develop and verify

Node.js 22 or newer; no external packages or build dependencies:

```sh
npm run build
npm test
npm run check
```

The pure engine is `src/guidance.js`; the card integration is `src/air-quality-guidance-card.js`. `scripts/build.mjs` deterministically inlines them into a single browser module. Do not hand-edit the new bundle. The original upstream bundle stays untouched.

For local visual checks, serve the repository (`python3 -m http.server 8765`) and open `http://localhost:8765/test/fixture.html`. It contains only generic fabricated example entities and local statistics. Its normal/high-CO₂/gas/missing scenarios exercise 108px and 132px cards, a 320px phone width, and the drawer without Home Assistant or hardware commands.

Before release, check all tests, reproducible bundle, native history, partial/offline states, compact text, 44px close/links, phone/desktop stacking and cleanup after removal. Rollback is simply switching the card type/resource to the preserved original, or restoring a saved dashboard configuration. Do not publish or replace an existing resource before reviewing the change.
