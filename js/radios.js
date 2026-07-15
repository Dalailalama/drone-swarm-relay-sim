// Radio hardware database — real modules used for drone C2 / telemetry links.
// Numbers come from vendor datasheets; rangeLosM is the practical line-of-sight
// range the vendor claims / the community reproduces with the stock antennas
// listed, near ground level. Free-space math alone wildly overestimates range,
// so the RSSI model below is calibrated per-preset: path-loss exponent `n` is
// solved so link margin reaches the fade floor exactly at rangeLosM.

const RADIOS = [
  {
    id: 'sik-v3',
    name: 'Holybro SiK V3 telemetry',
    freqMHz: 915,
    txDbm: 20,            // 100 mW
    sensDbm: -117,        // at 64 kbps air rate
    antGainDbi: 2,        // stock duck antenna, each end
    airRateKbps: 64,
    rangeLosM: 300,       // Holybro spec: ~300 m with stock antennas
    note: 'The default MAVLink telemetry radio. Cheap (~$40/pair), 300 m stock — antenna upgrades stretch it to a few km.',
  },
  {
    id: 'rfd900x',
    name: 'RFD900x long range',
    freqMHz: 915,
    txDbm: 30,            // 1 W
    sensDbm: -105,
    antGainDbi: 2,        // dipoles
    airRateKbps: 224,     // configurable 12–224 kbps
    rangeLosM: 40000,     // RFDesign datasheet: >40 km LOS with dipoles
    note: 'The serious option. 1 W, 40+ km line of sight. What long-range fixed-wing and BVLOS people actually fly.',
  },
  {
    id: 'espnow',
    name: 'ESP32 ESP-NOW (2.4 GHz)',
    freqMHz: 2400,
    txDbm: 20,
    sensDbm: -98,         // at 1 Mbps
    antGainDbi: 2,
    airRateKbps: 1000,
    rangeLosM: 300,       // community open-field tests: ~200-480 m
    note: 'Hobby-swarm favorite: a $5 chip on every drone, connectionless broadcast, trivially meshes. Short legs though.',
  },
  {
    id: 'elrs24',
    name: 'ExpressLRS 2.4 GHz (100 mW)',
    freqMHz: 2400,
    txDbm: 20,
    sensDbm: -108,        // SX1280 LoRa mode, 150 Hz packet rate
    antGainDbi: 2,
    airRateKbps: 5,       // usable MAVLink telemetry throughput, not RF rate
    rangeLosM: 10000,     // routinely proven 10+ km at 100 mW / 150 Hz
    note: 'RC-control link repurposed for C2. Astonishing range per milliwatt, but only a few kbps of telemetry fits through.',
  },
  {
    id: 'lora868',
    name: 'LoRa SX1276 (EU868, SF10)',
    freqMHz: 869,
    txDbm: 20,
    sensDbm: -132,        // SF10 / BW125
    antGainDbi: 2,
    airRateKbps: 1,       // ~980 bps at SF10/125
    rangeLosM: 5000,      // typical near-ground open-field result
    dutyCycle: 0.1,       // 869.4-869.65 MHz sub-band: 10% duty limit by law
    note: 'Kilometres of range on milliwatts, but ~1 kbps and a legal duty-cycle cap — commands and heartbeats only, and not many of them.',
  },
  {
    id: 'xbee900',
    name: 'XBee-PRO 900HP',
    freqMHz: 900,
    txDbm: 24,            // 250 mW
    sensDbm: -101,        // at 200 kbps
    antGainDbi: 2.1,
    airRateKbps: 200,
    rangeLosM: 6500,      // Digi datasheet: 4 mi LOS with 2.1 dBi dipoles
    note: 'Industrial mesh radio with DigiMesh built into the firmware — relaying is native, not something you write.',
  },
];

// Environment multipliers applied to the calibrated range. LOS datasheet
// figures assume clear line of sight; trees / buildings eat radio fast.
// shadowSigmaDb: how wildly the signal wanders as drones move through the
// environment (log-normal shadowing std dev — measured values run ~2-3 dB
// rural to ~6-8 dB dense urban).
const ENVIRONMENTS = [
  { id: 'open',     name: 'Open field (clear LOS)', factor: 1.0,  shadowSigmaDb: 2.5 },
  { id: 'suburban', name: 'Suburban / light trees', factor: 0.45, shadowSigmaDb: 4.5 },
  { id: 'urban',    name: 'Urban / dense obstacles', factor: 0.2, shadowSigmaDb: 6.5 },
];

// --- Link physics -----------------------------------------------------------
// Log-distance path loss: PL(d) = PL(1m) + 10·n·log10(d)
// PL(1m) from Friis at 1 m: 32.44 + 20·log10(f_MHz) - 60
// `n` is calibrated so RSSI(rangeLosM) == sensDbm  (margin 0 at rated range).

function pl1m(freqMHz) {
  return 32.44 + 20 * Math.log10(freqMHz) - 60;
}

function pathLossExponent(radio) {
  const budget = radio.txDbm + 2 * radio.antGainDbi - radio.sensDbm; // dB available
  return (budget - pl1m(radio.freqMHz)) / (10 * Math.log10(radio.rangeLosM));
}

// RSSI in dBm at distance d metres (d >= 1).
function rssiAt(radio, envFactor, dMetres) {
  const d = Math.max(1, dMetres / envFactor); // environment shrinks effective range
  const n = pathLossExponent(radio);
  const pl = pl1m(radio.freqMHz) + 10 * n * Math.log10(d);
  return radio.txDbm + 2 * radio.antGainDbi - pl;
}

// Link margin in dB above the receiver sensitivity floor.
function linkMarginDb(radio, envFactor, dMetres) {
  return rssiAt(radio, envFactor, dMetres) - radio.sensDbm;
}

// Usable planning range: where margin hits the fade reserve (default 6 dB —
// you never plan a link at 0 dB margin; multipath fading will drop it).
const FADE_MARGIN_DB = 6;

function usableRangeM(radio, envFactor) {
  const n = pathLossExponent(radio);
  const budget = radio.txDbm + 2 * radio.antGainDbi - radio.sensDbm - FADE_MARGIN_DB;
  const d = Math.pow(10, (budget - pl1m(radio.freqMHz)) / (10 * n));
  return d * envFactor;
}

// Rough end-to-end throughput across a relay chain: each store-and-forward
// hop on a single shared channel divides airtime, so capacity ~ rate / hops.
function chainThroughputKbps(radio, hops) {
  return radio.airRateKbps / Math.max(1, hops);
}

// Radio horizon between two antennas (4/3-Earth model): beyond this distance
// the planet itself blocks the path, no matter how much power you have.
//     d_km ≈ 4.12 · (√h1 + √h2)   with h in metres
function radioHorizonM(h1M, h2M) {
  return 4120 * (Math.sqrt(Math.max(0, h1M)) + Math.sqrt(Math.max(0, h2M)));
}

// Probability a single packet transmission succeeds, given the link's mean
// margin above sensitivity. Logistic curve: ~16% at 0 dB, 50% at 2 dB,
// ~95% at 6 dB — the reason nobody plans a link at 0 dB margin.
function pktSuccessProb(marginDb) {
  return 1 / (1 + Math.exp(-(marginDb - 2) / 1.2));
}
