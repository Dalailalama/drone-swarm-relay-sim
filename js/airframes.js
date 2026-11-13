// Airframe presets and energy physics.
//
// Hover power comes from actuator-disc momentum theory:
//     P_ideal = (m·g)^(3/2) / sqrt(2·rho·A_total)
// divided by a lumped efficiency (prop figure of merit × motor × ESC ≈ 0.55
// for a decent hobby-grade multirotor; a preset can carry its own
// powertrainEff). Forward flight is level-flight momentum theory: induced
// power falls with airspeed, parasite drag on each preset's dragAreaM2 rises
// with its cube (see flightPowerW). Endurance is NOT a preset number — it
// falls out of battery Wh / hover W.
// The micro is calibrated to a published spec (DJI Mini 4 Pro, 30 min hover);
// the q450 and X8 are class-typical builds with no single reference aircraft.

const AIR_RHO = 1.225;      // kg/m^3, sea level
const G = 9.81;
const POWERTRAIN_EFF = 0.55; // default prop FM x motor x ESC, hobby grade
const BATT_USABLE_FRAC = 0.80; // land before the pack is truly empty
// Coaxial stacks: both rotors sweep ONE disc, and the lower rotor works in the
// upper's contracted wake. Momentum theory (Leishman, Principles of Helicopter
// Aerodynamics, 2nd ed., sec. 3.6, equal-thrust coaxial) puts induced power at
// 1.281x the same rotors running isolated, i.e. 1.281/sqrt(2) = 0.906x one
// shared disc carrying the whole thrust. Measured coaxial rigs often do a
// little better (~1.16x isolated), so this is mildly pessimistic.
const COAX_KAPPA_INT = 1.281 / Math.SQRT2;
// Hover figure of merit: the share of hover shaft power that is induced
// (momentum-theory) power; the rest is blade profile drag. Small fixed-pitch
// props run about 0.5-0.7. It sits inside the lumped efficiency above
// (0.55 ≈ 0.65 FM × ~0.85 motor·ESC) and only matters in forward flight,
// where induced power falls with airspeed and profile power does not.
const ROTOR_FM = 0.65;

const AIRFRAMES = [
  {
    id: 'micro',
    name: 'Sub-250 g micro quad',
    massKg: 0.249,
    rotorRadiusM: 0.076,    // 6030F props, 6.0 in
    nRotors: 4,
    batteryWh: 18.96,       // 2590 mAh x 7.32 V Li-ion
    // Whole-aircraft figure fitted to the spec's 30 min hover (100% to 0%):
    // https://www.dji.com/mini-4-pro/specs. Small props and motors are less
    // efficient, and camera, gimbal and video link draw from the same pack.
    powertrainEff: 0.24,
    // Fitted to the same page's 34 min max flight time, flown at a constant
    // 21.6 km/h: the one cited point on its forward-flight power curve.
    dragAreaM2: 0.0155,
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
    dragAreaM2: 0.04,       // estimate: frame, arms and pack at Cd ~1
    maxSpeedMs: 14,
    note: 'The classic DIY research platform (F450 + Pixhawk). What most swarm papers actually fly.',
  },
  {
    id: 'x8',
    name: 'Endurance X8 (2.9 kg)',
    massKg: 2.9,
    rotorRadiusM: 0.14,
    nRotors: 8,
    coaxial: true,          // 4 arms x 2 stacked rotors
    batteryWh: 240,        // Li-ion endurance pack
    dragAreaM2: 0.05,       // estimate: bigger frame and pack at Cd ~1
    maxSpeedMs: 16,
    note: 'Coaxial octo with a fat Li-ion pack. Slow to react, flies for over half an hour.',
  },
];

// Swept disc area: a coaxial stack's two rotors share one disc.
function discAreaM2(af) {
  const discs = af.coaxial ? af.nRotors / 2 : af.nRotors;
  return discs * Math.PI * af.rotorRadiusM * af.rotorRadiusM;
}

function hoverPowerW(af) {
  const thrustN = af.massKg * G;
  const pIdeal = Math.pow(thrustN, 1.5) / Math.sqrt(2 * AIR_RHO * discAreaM2(af));
  return pIdeal * (af.coaxial ? COAX_KAPPA_INT : 1) / (af.powertrainEff || POWERTRAIN_EFF);
}

// Electrical power at a given airspeed: level-flight momentum theory with no
// fitted shape constants (audit EN-3). Parasite drag D = ½·rho·CdA·V² tilts
// the rotors so they carry T = sqrt(W² + D²). Glauert's forward-flight inflow
//     vi⁴ + V²·vi² = vh⁴,   vh² = T / (2·rho·A)
// has the closed form vi² = 2·vh⁴ / (V² + sqrt(V⁴ + 4·vh⁴)), so induced power
// T·vi falls as the disc takes in clean air (translational lift) while
// parasite power D·V climbs with V³ — the U-shaped curve, its minimum near
// half to two-thirds of max speed. Profile power stays at its hover share.
// Ideal inflow overstates the induced saving a little (rotor-to-rotor wake
// interference, profile growth); the visible pessimism for that lives in
// BATTERY.homeMargin. Equals hoverPowerW at V = 0.
function flightPowerW(af, vAirMs) {
  const v = Math.min(1.3 * af.maxSpeedMs, Math.abs(vAirMs));
  const w = af.massKg * G;
  const area = discAreaM2(af);
  const drag = 0.5 * AIR_RHO * af.dragAreaM2 * v * v;
  const thrust = Math.sqrt(w * w + drag * drag);
  const vh2 = thrust / (2 * AIR_RHO * area);
  const vi = Math.sqrt(2 * vh2 * vh2 / (v * v + Math.sqrt(v * v * v * v + 4 * vh2 * vh2)));
  const inducedRel = thrust * vi / (w * Math.sqrt(w / (2 * AIR_RHO * area))); // vs hover
  // Parasite power goes through motor and ESC only (efficiency / FM).
  return hoverPowerW(af) * (ROTOR_FM * inducedRel + (1 - ROTOR_FM)) +
    drag * v * ROTOR_FM / (af.powertrainEff || POWERTRAIN_EFF);
}

function usableWh(af) {
  return af.batteryWh * BATT_USABLE_FRAC;
}

function hoverEnduranceMin(af) {
  return usableWh(af) / hoverPowerW(af) * 60;
}

// UMD-lite export so the physics is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AIRFRAMES, discAreaM2, hoverPowerW, flightPowerW, usableWh, hoverEnduranceMin, AIR_RHO, POWERTRAIN_EFF, BATT_USABLE_FRAC, COAX_KAPPA_INT, ROTOR_FM };
}
