# Drone swarm relay simulator

A browser-based simulation of a drone swarm that keeps itself connected to a
ground station by **turning its own members into radio relays** — the way a
flock of birds would solve a comms problem. Fly the mission far enough away
and drones peel off to bridge the link; kill a relay and the swarm heals;
run the battery down and drones excuse themselves and fly home.

No build step, no dependencies. Open `index.html` from any static server.

```
python -m http.server 8000
# then open http://localhost:8000
```

## Why it's interesting

Most swarm demos are animations: an all-knowing script moves dots around.
This one is a **distributed system**. There are three separate worlds that
only communicate through simulated radio packets:

- **Truth** — actual positions, batteries, and RF physics
- **C2's beliefs** — built *only* from telemetry packets that physically
  arrived, hop by hop, at the ground station
- **Each drone's beliefs** — the last order packet it received, and how long
  ago it last heard from C2

Every command and telemetry report is a packet that routes through the relay
chain with real per-hop airtime, gets lost to fading, and simply never
arrives if no route exists. When you kill a mid-chain relay, C2 doesn't
"know" — it notices the telemetry silence a few seconds later, strikes the
drone off its roster, and re-plans with whatever it can still reach.
Meanwhile the stranded far drones run their own onboard failsafe ladder:
**hold position → fly toward home until contact returns → get re-tasked.**
Chains heal end-to-end without any component having the full picture.

## The radio model (and its honesty)

Every radio preset is a real product with datasheet numbers — TX power,
receiver sensitivity, frequency, air rate, and the vendor's claimed
line-of-sight range (sources in [RADIOS.md](RADIOS.md)).

Free-space path loss alone would predict absurd ranges (a 100 mW SiK radio
"reaches" 290 km in free space; in the field it does 300 m near the ground).
So the model uses **log-distance path loss with a per-radio exponent
calibrated so the link margin hits exactly 0 dB at the vendor's rated LOS
range**. That single fitted parameter absorbs ground reflection, Fresnel
losses, and antenna reality. On top of that sit:

- **Log-normal shadowing** — an Ornstein-Uhlenbeck dB offset per link
  (σ = 2.5 dB open field → 6.5 dB urban), so links breathe and flicker
- **Packet error curve** — success probability is logistic in margin
  (50% at +2 dB, ~95% at +6 dB), with per-hop link-layer retries
- **3D slant range** and a **4/3-Earth radio horizon** — beyond
  `4.12(√h₁+√h₂) km` the planet blocks the link no matter the power
- **Shared-channel contention** — every transmission (and retry) occupies
  the one frequency; C2 traffic overhead visibly eats chain throughput
- **Regulatory duty cycle** (EU868 LoRa preset) — throttles telemetry and
  command rates; failsafe timeouts scale to match, like PX4's `COM_DL_LOSS_T`

**What this is:** a planning-grade sandbox whose numbers stay anchored to
real hardware behavior. **What this is not:** an RF certification tool. The
calibrated exponent is a modeling choice, stated here so you can judge it.

## The energy model

No endurance sliders. Airframes are defined by mass, rotor disc area, and
battery watt-hours; hover power comes from actuator-disc momentum theory at
a lumped 0.55 powertrain efficiency, forward flight adds a cubic drag term,
and endurance *emerges* — within a couple of minutes of the real aircraft
each preset is modeled on (sub-250 g micro ≈ 36 min, 450-class ≈ 22 min,
endurance X8 ≈ 46 min). Drones run wind-aware smart-RTH: energy to get home
is continuously re-estimated, and they leave while they still can.

Wind is a ground-frame/air-frame split: speed limits and power draw are paid
in airspeed, so holding a relay slot in a 10 m/s wind costs real watts, and
a 16 m/s gale blows a 14 m/s quad backwards.

## Things to try

1. **Kill a relay** (click it, then *Kill*) — watch C2 lose telemetry,
   re-plan, and the chain heal.
2. **Switch radio to LoRa EU868** — kilometres of range, but the duty cycle
   stretches command rounds to ~40 s and the swarm gets visibly sluggish.
3. **Set environment to Urban** — usable range collapses to 20%, links
   flicker, more relays get pulled off the mission.
4. **RFD900x at 30 m altitude vs 120 m** — the radio horizon, not the power
   budget, is the binding constraint at 40 km scale.
5. **Crank wind to 12 m/s** — upwind legs crawl, relays burn battery holding
   station, RTB triggers early.

## Architecture

```
js/radios.js     radio presets (datasheet values + sources) & link physics
js/airframes.js  airframe presets & momentum-theory energy model
js/net.js        packet network: routing, per-hop airtime, fading, retries
js/swarm.js      C2 planner, drone onboard logic, failsafes, motion
js/render.js     canvas map: links, packets, range rings, wind, scale bar
js/main.js       UI wiring, sim loop, camera
test/            physics unit tests (node --test)
```

Plain ES5-ish JavaScript, zero dependencies, deterministic under a seeded
RNG (same seed → bit-identical run, which is what makes the tests possible).

## Tests

```
node --test
```

## Roadmap

- Terrain / obstacle line-of-sight blocking
- Broadcast C2 mode (one packet orders the whole swarm — what LoRa C2
  actually does)
- Spare drones auto-launching to replace battery-RTB relays
- Packet capture export for protocol debugging
- PX4/ArduPilot SITL bridge: same planner, real autopilot firmware

## License

MIT — see [LICENSE](LICENSE).
