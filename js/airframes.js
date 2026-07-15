// Airframe presets and energy physics.
//
// Hover power comes from actuator-disc momentum theory:
//     P_ideal = (m·g)^(3/2) / sqrt(2·rho·A_total)
// divided by a lumped efficiency (prop figure of merit × motor × ESC ≈ 0.55
// for a decent hobby-grade multirotor). Forward flight adds parasite drag as
// a cubic term. Endurance is NOT a preset number — it falls out of
// battery Wh / hover W, and lands within a couple of minutes of the real
// aircrafts' published figures, which is the point.

const AIR_RHO = 1.225;      // kg/m^3, sea level
const G = 9.81;
const POWERTRAIN_EFF = 0.55; // prop FM x motor x ESC, hobby grade
const BATT_USABLE_FRAC = 0.80; // land before the pack is truly empty

const AIRFRAMES = [
  {
    id: 'micro',
    name: 'Sub-250 g micro quad',
    massKg: 0.249,
    rotorRadiusM: 0.05,
    nRotors: 4,
    batteryWh: 18.9,        // ~2450 mAh 2S Li-ion pack
    maxSpeedMs: 13,
    note: 'DJI-Mini-class. Legal-to-fly-anywhere weight, surprisingly long legs, but a kite in any real wind.',
  },
  {
    id: 'q450',
    name: '450-class quad (1.6 kg)',
    massKg: 1.6,
    rotorRadiusM: 0.12,     // 9.5" props
    nRotors: 4,
    batteryWh: 77,          // 4S 5200 mAh LiPo
    maxSpeedMs: 14,
    note: 'The classic DIY research platform (F450 + Pixhawk). What most swarm papers actually fly.',
  },
  {
    id: 'x8',
    name: 'Endurance X8 (2.9 kg)',
    massKg: 2.9,
    rotorRadiusM: 0.14,
    nRotors: 8,
    batteryWh: 240,         // Li-ion endurance pack
    maxSpeedMs: 16,
    note: 'Coaxial octo with a fat Li-ion pack. Slow to react, flies for the better part of an hour.',
  },
];

function discAreaM2(af) {
  return af.nRotors * Math.PI * af.rotorRadiusM * af.rotorRadiusM;
}

function hoverPowerW(af) {
  const thrustN = af.massKg * G;
  const pIdeal = Math.pow(thrustN, 1.5) / Math.sqrt(2 * AIR_RHO * discAreaM2(af));
  return pIdeal / POWERTRAIN_EFF;
}

// Electrical power at a given airspeed. Mild dip at low speed (translational
// lift), cubic parasite-drag rise toward max speed — the classic U-shape,
// simplified.
function flightPowerW(af, vAirMs) {
  const u = Math.min(1.3, Math.abs(vAirMs) / af.maxSpeedMs);
  return hoverPowerW(af) * (1 - 0.18 * u + 0.55 * u * u * u);
}

function usableWh(af) {
  return af.batteryWh * BATT_USABLE_FRAC;
}

function hoverEnduranceMin(af) {
  return usableWh(af) / hoverPowerW(af) * 60;
}

// UMD-lite export so the physics is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AIRFRAMES, discAreaM2, hoverPowerW, flightPowerW, usableWh, hoverEnduranceMin, AIR_RHO, POWERTRAIN_EFF, BATT_USABLE_FRAC };
}
