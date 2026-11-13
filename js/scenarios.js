// The DDIL scenario pack — Denied, Disrupted, Intermittent, Limited-bandwidth.
//
// One-click, reproducible demonstrations of every comms-denial mode this
// simulator models, alone and combined. Each entry is plain data in exactly
// the shape of a saved scenario .json (js/main.js's applyScenario consumes
// both), so anything you tune here can be saved, shared, and reloaded — and
// anything a user saves could have been a member of this pack.
//
// Coordinates are absolute (base is always {0,0}) so every scenario is
// bit-reproducible regardless of which radio's range math would otherwise
// size the mission. Seeds pin the exact terrain.

const SCENARIO_PACK = [
  {
    id: 'ddil-denied',
    title: 'D — GPS-denied crossing',
    blurb: 'Long-range radios bridge the valley fine — but a GNSS dead zone sits astride the route. Watch the drones fly on dead reckoning, miss their slots by the size of their nav error, report poisoned positions, and C2 plan around the uncertainty.',
    scenario: {
      version: 1,
      name: 'DDIL: GPS-denied crossing',
      radio: 'rfd900x', env: 'open', airframe: 'q450',
      count: 8, altitudeM: 80, spacingPct: 80,
      terrain: 'rolling', seed: 4101,
      base: { x: 0, y: 0 }, target: { x: 3200, y: -700 },
      windSpd: 2, windDir: 90,
      corridor: true, broadcast: true, coverage: true,
      gpsZones: [{ x: 1600, y: -350, rM: 420, on: true }],
      jammers: [],
    },
  },
  {
    id: 'ddil-disrupted',
    title: 'D — Disrupted (jamming, agile chain)',
    blurb: 'A frequency-agile MANET chain runs into two emitters blocking the direct corridor. Spectrum agility sheds part of the denial; A* bends the chain around what remains. Toggle agility off mid-run to see the difference in link uptime.',
    scenario: {
      version: 1,
      name: 'DDIL: disrupted corridor',
      radio: 'doodle-rm', env: 'suburban', airframe: 'q450',
      count: 10, altitudeM: 70, spacingPct: 75,
      terrain: 'mixed', seed: 4102,
      base: { x: 0, y: 0 }, target: { x: 2600, y: -550 },
      windSpd: 0, windDir: 90,
      corridor: true, broadcast: true, coverage: true,
      spectrumAgility: true,
      // ~1.5 km and ~1.0 km denial discs with agility on. Once a jammer
      // arrived with its EIRP and the receive antenna gain (5.15 dB more),
      // 26/22 dBm put the ground station itself inside the first disc.
      jammers: [
        { x: 1100, y: -150, erpDbm: 21, band: 'all', altM: 15, on: true },
        { x: 1500, y: -480, erpDbm: 17, band: 'all', altM: 15, on: true },
      ],
    },
  },
  {
    id: 'ddil-intermittent',
    title: 'I — Intermittent (urban canyons)',
    blurb: 'Short-range SiK telemetry at 45 m AGL over a dense district: towers shadow hops, contact flickers, most of the fleet ends up holding the chain and failsafes fire. Try the altitude slider mid-run: with under 100 m of usable range, climbing lengthens the slant hop down to the 6 m ground mast as fast as it clears rooftops, so height is a trade here, not a cure.',
    // env 'suburban', not 'urban': the district's buildings are modelled
    // explicitly (line of sight), so the clutter factor covers only what they
    // don't. The urban factor on top left SiK 42 m of usable range — 18
    // relays for this span with 12 drones, so the objective was never reached.
    scenario: {
      version: 1,
      name: 'DDIL: intermittent urban link',
      radio: 'sik-v3', env: 'suburban', airframe: 'micro',
      count: 12, altitudeM: 45, spacingPct: 70,
      terrain: 'urban', cityDensity: 65, cityHeight: 35, seed: 4103,
      base: { x: 0, y: 0 }, target: { x: 520, y: -130 },
      windSpd: 0, windDir: 90,
      corridor: true, broadcast: true, coverage: true,
      jammers: [],
    },
  },
  {
    id: 'ddil-limited',
    title: 'L — Limited bandwidth (LoRa + video)',
    blurb: 'EU868 LoRa buys kilometres of range with milliwatts — and a legal duty cycle that stretches command rounds to tens of seconds. Switch video backhaul on and watch the scheduler starve: some physics only punishes you slowly.',
    scenario: {
      version: 1,
      name: 'DDIL: limited-bandwidth backhaul',
      radio: 'lora868', env: 'open', airframe: 'x8',
      count: 6, altitudeM: 90, spacingPct: 85,
      terrain: 'flat', seed: 4104,
      base: { x: 0, y: 0 }, target: { x: 3600, y: -800 },
      windSpd: 3, windDir: 180,
      corridor: true, broadcast: true, coverage: true,
      videoBackhaul: true, videoKbps: 500,
      jammers: [],
    },
  },
  {
    id: 'ddil-full',
    title: 'Full DDIL — everything at once',
    blurb: 'The flagship: an endurance X8 relay wing holds the backhaul while tactical micros on the same long-range telemetry work the objective; a jammer squats beside the corridor, GNSS dies over the target area, LPI/LPD waveforms are up, and payload video competes for the channel.',
    // The micros fly the wing's RFD900x. On 95 m SiK legs they lost C2 about
    // 250 m out and never crossed the 3.4 km to the wing's hand-off relay —
    // nor with the jammer, LPI, video or GNSS zone removed, or under the open
    // clutter factor — so only wing units ever reached the objective (audit
    // SCN-02). The planner covers the objective end of a tactical hop, not
    // the transit to it.
    scenario: {
      version: 1,
      name: 'DDIL: full combination',
      radio: 'rfd900x', env: 'suburban', airframe: 'micro',
      hetero: true, relayWing: 4, relayAirframe: 'x8', relayRadio: 'rfd900x',
      count: 12, altitudeM: 75, spacingPct: 78,
      terrain: 'rolling', seed: 4105,
      base: { x: 0, y: 0 }, target: { x: 3400, y: -750 },
      windSpd: 4, windDir: 120,
      corridor: true, broadcast: true, coverage: true,
      spectrumAgility: true, lpiMode: true,
      videoBackhaul: true, videoKbps: 300,
      gpsZones: [{ x: 3150, y: -720, rM: 330, on: true }],
      // 0 dBm denies a ~950 m disc of the wing's band beside the corridor
      // (~1.8 km with agility and LPI off), counting the jammer's EIRP and
      // the receive antenna gain. At 18 dBm the disc was 3.9 km — base,
      // objective and every detour — and on the compare tool's seeds
      // 101-105 the objective was reached late or never (audit SCN-02).
      jammers: [
        { x: 1700, y: -560, erpDbm: 0, band: 'all', altM: 15, on: true },
      ],
    },
  },
];

// UMD-lite export so the manifest is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SCENARIO_PACK };
}
