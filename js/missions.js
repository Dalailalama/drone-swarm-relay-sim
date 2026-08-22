// The vertical mission library — one-click templates for the industries this
// capability sells into. Each template is plain data: a scenario (same shape
// as everything applyScenario eats) plus optional MOVEMENT dynamics and an
// operator checklist, because a vertical is a workflow, not just geometry.
//
// Dynamics are what make these real rather than re-badged demos:
//   - convoy escort:  the GROUND STATION drives (baseVel) — the chain
//                     re-plans live behind a moving command vehicle.
//   - wildfire front: the OBJECTIVE drifts downwind (targetVel) — the flock
//                     follows a moving fire line instead of a fixed point.

const MISSION_LIBRARY = [
  {
    id: 'sar-grid',
    vertical: 'Search & rescue',
    title: 'SAR — grid search beyond ridgeline',
    blurb: 'Lost hiker past the ridge that kills handheld radio. Micro drones sweep the far valley while SiK relays chain over the saddle; every drone runs smart-RTH so nobody strands the team.',
    checklist: [
      'Mark last-known-position as the objective (drag the target).',
      'Keep Coverage map ON — red cells are where the missing drone heard silence.',
      'Watch C2 contact KPI; a falling count means the chain needs another relay.',
      'After-action report exports the searched-vs-silent map for the incident log.',
    ],
    dynamics: null,
    scenario: {
      version: 1, name: 'SAR grid search',
      radio: 'sik-v3', env: 'suburban', airframe: 'micro',
      count: 14, altitudeM: 65, spacingPct: 75,
      terrain: 'rolling', seed: 5201,
      base: { x: 0, y: 0 }, target: { x: 760, y: -190 },
      windSpd: 2, windDir: 200,
      corridor: true, broadcast: true, coverage: true,
    },
  },
  {
    id: 'wildfire-overwatch',
    vertical: 'Wildfire / infrastructure overwatch',
    title: 'Wildfire — persistent front watch',
    blurb: 'An endurance X8 ring watches a fire front that creeps downwind for the whole sortie. The objective DRIFTS — the flock follows it, relays re-slot on the rotating line, and the link never has to move by surprise.',
    checklist: [
      'Endurance airframes only — swap swaps cost coverage minutes.',
      'Wind matters twice: it moves the front AND burns hover watts holding station.',
      'Video backhaul shows what the chain can actually carry to the command post.',
      'Raise altitude if the smoke layer (terrain) cuts line of sight.',
    ],
    dynamics: { targetVelMps: { x: -1.6, y: 0.9 }, baseVelMps: null },
    scenario: {
      version: 1, name: 'Wildfire front overwatch',
      radio: 'rfd900x', env: 'open', airframe: 'x8',
      count: 8, altitudeM: 110, spacingPct: 85,
      terrain: 'rolling', seed: 5202,
      base: { x: 0, y: 0 }, target: { x: 4200, y: -900 },
      windSpd: 4, windDir: 205,
      corridor: true, broadcast: true, coverage: true,
      videoBackhaul: true, videoKbps: 300,
    },
  },
  {
    id: 'pipeline-linear',
    vertical: 'Linear inspection',
    title: 'Pipeline — 5 km linear inspection',
    blurb: 'Beyond-line-of-sight inspection along a corridor: corridor routing converges every transit onto the relay spine, so a solo inspector drone stays commandable for kilometres of pipe, rail, or powerline.',
    checklist: [
      'Corridor routing ON is the point of this mission — try switching it off to compare.',
      'Hop spacing below 80% buys margin against morning fade dips.',
      'One streamer at a time: video turns rotate along the segment being flown.',
      'Export packet capture with the report — vendors love an honest trace.',
    ],
    dynamics: null,
    scenario: {
      version: 1, name: 'Pipeline linear inspection',
      radio: 'rfd900x', env: 'suburban', airframe: 'q450',
      count: 10, altitudeM: 90, spacingPct: 72,
      terrain: 'flat', seed: 5203,
      base: { x: 0, y: 0 }, target: { x: 5000, y: -300 },
      windSpd: 3, windDir: 270,
      corridor: true, broadcast: true, coverage: true,
      videoBackhaul: true, videoKbps: 600,
    },
  },
  {
    id: 'convoy-escort',
    vertical: 'Convoy / mobile command escort',
    title: 'Convoy — moving command post escort',
    blurb: 'The ground station itself drives at road speed. Watch the operator marker crawl across the map while the wing re-forms the chain BEHIND it in real time — the same live re-planning you get from dragging the C2 marker, now on a clock. This is the clip that sells BVLOS escort.',
    checklist: [
      'The square (C2) is driving — the chain re-plans behind it continuously.',
      'Relay wing carries the backhaul; tactical micros fly screen ahead of the vehicle.',
      'If contact degrades, slow is a decision: drag speed by pausing the sim.',
      'GPS-denial pockets ahead? Add an outage zone on the route and rehearse the handover.',
    ],
    dynamics: { baseVelMps: { x: 6.5, y: -1.4 }, targetVelMps: null },
    scenario: {
      version: 1, name: 'Convoy escort, moving command post',
      radio: 'sik-v3', env: 'suburban', airframe: 'micro',
      hetero: true, relayWing: 3, relayAirframe: 'x8', relayRadio: 'rfd900x',
      count: 10, altitudeM: 70, spacingPct: 78,
      terrain: 'rolling', seed: 5204,
      base: { x: 0, y: 0 }, target: { x: 1400, y: -300 },
      windSpd: 2, windDir: 90,
      corridor: true, broadcast: true, coverage: true,
      videoBackhaul: true, videoKbps: 250,
    },
  },
  {
    id: 'perimeter-patrol',
    vertical: 'Perimeter & event security',
    title: 'Perimeter — wide-ring site patrol',
    blurb: 'A large fleet holds a persistent surveillance ring over a site with zero infrastructure — ports, camps, substations. Dense mesh means every drone routes for every other: kill any node and the ring heals around it.',
    checklist: [
      'High counts stress the channel — watch Channel busy % with video on.',
      'Broadcast C2 keeps order packets to ONE flooded frame regardless of fleet size.',
      'Kill two drones opposite each other to prove self-healing has no single point.',
      'ESP-NOW radios keep per-unit cost at $5; range is the trade.',
    ],
    dynamics: null,
    scenario: {
      version: 1, name: 'Perimeter patrol ring',
      radio: 'espnow', env: 'open', airframe: 'micro',
      count: 24, altitudeM: 55, spacingPct: 70,
      terrain: 'flat', seed: 5205,
      base: { x: 0, y: 0 }, target: { x: 240, y: -60 },
      windSpd: 1, windDir: 45,
      corridor: false, broadcast: true, coverage: true,
    },
  },
];

// UMD-lite export so the manifest is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MISSION_LIBRARY };
}
