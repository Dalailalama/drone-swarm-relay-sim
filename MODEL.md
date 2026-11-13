# Simulation Physics & Modeling Specification (MODEL.md)

This document provides a concise, rigorous mathematical and physical specification of the models implemented in the drone swarm relay simulator: coordinate systems, radio frequency (RF) propagation, network scheduling, aerodynamics and power consumption, navigation drift, and known model limitations. Every formula below is the one the code runs; the source file is named next to each so the two can be checked against each other.

---

## 1. Units and Conventions

All internal calculations use standard SI and telemetry units:

| Quantity | Unit | Symbol | Notes |
|---|---|---|---|
| Distance / Displacement | Metres | $\text{m}$ | Local Cartesian frame |
| Velocity / Speed | Metres per second | $\text{m/s}$ | Ground speed $V_g$, airspeed $V_a$ |
| Acceleration | Metres per second squared | $\text{m/s}^2$ | Capped by airframe limits |
| Time / Timestep | Seconds | $\text{s}$ | Canonical $\Delta t = 0.05\,\text{s}$ (20 Hz) |
| RF Power / EIRP | Decibel-milliwatts | $\text{dBm}$ | Transmitter output + antenna gain |
| Link Margin / Loss / Gain | Decibels | $\text{dB}$ | Relative power ratio |
| Interference Power | Decibel-milliwatts | $\text{dBm}$ | Interference floor from source ERP (converted to EIRP); thermal noise is implicit in the datasheet sensitivity |
| Electrical Energy | Watt-hours | $\text{Wh}$ | Usable battery energy (80% of the nominal pack) |
| Electrical Power | Watts | $\text{W}$ | Total power draw from battery |
| Mass | Grams / Kilograms | $\text{g}$ / $\text{kg}$ | All-Up Weight (AUW) |
| Geographic Coordinates | Degrees | $^{\circ}$ | WGS-84 decimal latitude and longitude |
| Height Above Ellipsoid | Metres | $\text{m HAE}$ | GPS vertical datum |

---

## 2. Coordinate Frames & Transformations

The simulator interacts with three distinct reference frames:

```
                  +-------------------------------+
                  |  WGS-84 (Lat, Lon, HAE)       |
                  +---------------+---------------+
                                  |
                   Equirectangular local projection
                                  |
                                  v
+-----------------------------+       +-----------------------------+
| Sim Frame (Local Canvas)    |       | Autopilot / MAVLink (NED)   |
| X: East (+X)                |<----->| X: North (+X)               |
| Y: South (+Y)               |       | Y: East (+Y)                |
| Z: Altitude AGL (+Z)        |       | Z: Down (-Z)                |
+-----------------------------+       +-----------------------------+
```

### 2.1 Sim World Frame
- **Origin $(0, 0)$**: the default Command and Control (C2) ground station location (the operator can move C2 afterwards).
- **X-axis**: Points **East** ($+x$).
- **Y-axis**: Points **South** ($+y$) to align with standard 2D canvas top-down coordinates.
- **Z-axis**: Height Above Ground Level (AGL) in metres ($+z$ is up).

### 2.2 Autopilot / MAVLink Frame (NED)
The autopilot (ArduCopter, the only firmware the SITL bridge supports) operates in North-East-Down (NED):
$$\begin{aligned}
x_{\text{NED}} &= -y_{\text{sim}} \quad (\text{North}) \\
y_{\text{NED}} &= +x_{\text{sim}} \quad (\text{East}) \\
z_{\text{NED}} &= -z_{\text{sim}} \quad (\text{Down})
\end{aligned}$$

### 2.3 Geographic Frame (WGS-84)
OSM import, the tile basemap and TAK share one local projection (`geoMetresPerDeg` in `js/osm.js`): equirectangular about an anchor point $(\phi_0, \lambda_0)$, scaled by the WGS-84 meridian radius $M$ and prime-vertical radius $N$ at the anchor's latitude:
$$\begin{aligned}
\Delta \phi &= -\frac{y_{\text{sim}}}{M(\phi_0)} \cdot \frac{180}{\pi} \\
\Delta \lambda &= \frac{x_{\text{sim}}}{N(\phi_0) \cos(\phi_0)} \cdot \frac{180}{\pi}
\end{aligned}
\qquad
M = \frac{a(1 - e^2)}{(1 - e^2 \sin^2\phi_0)^{3/2}}, \quad N = \frac{a}{(1 - e^2 \sin^2\phi_0)^{1/2}}$$
with $a = 6\,378\,137\,\text{m}$ and $e^2 = 6.69437999014 \times 10^{-3}$. Longitude differences are wrapped to $[-180°, 180°)$, so areas across the antimeridian work. The error is under 1 m within about 3 km of the anchor and grows with distance from it.

---

## 3. Radio Frequency (RF) Propagation Model

### 3.1 Path Loss and the Calibrated Exponent
Source: `js/radios.js`, `js/fleet.js`. Over 3D slant distance $d = \sqrt{(x_1 - x_2)^2 + (y_1 - y_2)^2 + (z_1 - z_2)^2}$, a datasheet preset receives

$$P_{\text{rx}}(d) = P_{\text{tx}} + G_{\text{tx}} + G_{\text{rx}} - \text{PL}_{1\text{m}}(f) - 10\, n_r \log_{10}\!\left(\max\left(1, \frac{d}{\eta}\right)\right)$$

where:
- $P_{\text{tx}}$: Transmitter power ($\text{dBm}$); $G_{\text{tx}}, G_{\text{rx}}$: antenna gains ($\text{dBi}$).
- $\text{PL}_{1\text{m}}(f) = 32.44 + 20 \log_{10}(f_{\text{MHz}}) - 60$: Friis free-space loss at 1 m.
- $\eta$: environment range factor (open 1.0, suburban 0.45, urban 0.2). It divides the distance, which is the same as a $10\, n_r \log_{10}(1/\eta)\,\text{dB}$ penalty. The exponent does not change with the environment.
- $n_r$: the preset's path-loss exponent, solved so that the margin is exactly 0 dB at the vendor's rated line-of-sight range $R_{\text{LOS}}$ in open terrain:
  $$n_r = \frac{P_{\text{tx}} + 2G - S_{\text{rx}} - \text{PL}_{1\text{m}}(f)}{10 \log_{10} R_{\text{LOS}}}$$
  It is a range-calibration fit, not channel physics: the bundled presets come out between about 2.1 and 3.9 (`pathLossExponent(radio)`), not 2.0.
- A field-calibrated preset (§3.7) carries a fitted exponent $n_{\text{fit}}$ and 1 m reference power $P_{\text{ref}}$ instead: $P_{\text{rx}} = P_{\text{ref}} - 10\, n_{\text{fit}} \log_{10}(\max(1, d/\eta)) + (G_{\text{rx}} - G_{\text{tx}})$.

The **path-loss margin** is $M_{\text{PL}} = P_{\text{rx}} - S_{\text{rx}}$, with $S_{\text{rx}}$ the receiver's datasheet sensitivity. Thermal noise has no separate term: it is already inside $S_{\text{rx}}$.

**Mixed fleets** (`js/fleet.js`): two radios can link only if they share the preset's `air` protocol key (a preset without one links only to its own id) and their frequencies are within 150 MHz. A link between different radios uses the larger of the two exponents in both directions, $n_{ab} = \max(n_a, n_b)$, so its path loss stays reciprocal. Each direction uses the transmitter's own power, frequency or fitted intercept and both antenna gains, and the link carries the worse direction.

### 3.2 Live Link Margin
Source: `liveMarginDb` in `js/swarm.js`. Routing, packet delivery and the hop display all use one margin:

$$M = \min_{\text{dir}}\left(P_{\text{rx,dir}} - S_{\text{rx}} - I_{\text{rx}}\right) + F_{\text{link}}(t) - L_{\text{LPI}}$$

- $L_{\text{LPI}} = 3\,\text{dB}$ when LPI/LPD mode is on, otherwise 0. With LPI on, hop planning pays the same 3 dB, so planned hops are shorter.
- $F_{\text{link}}(t)$: the link's shadowing offset (§3.4).
- $I_{\text{rx}}$: the interference penalty at the receiver of that direction (§3.3). Each receiver's interference degrades only the direction it hears.

### 3.3 Interference Sources
Source: `interferenceFloorDbm`, `floorPenaltyDb` and `jammerDenialRadiusM` in `js/swarm.js`. An interference source is a band-wide barrage emitter at height `altM` (default 15 m) above the ground. Its `erpDbm` is ERP, referenced to a half-wave dipole, so it is converted to EIRP (+2.15 dB) and heard through the receiver's own antenna. The interference floor at a receiver is

$$N_j = 10 \log_{10} \sum_{\text{sources}} 10^{\left(\text{ERP}_j + 2.15 + G_{\text{rx}} - G_{\text{agility}} - \text{PL}_r(d_j)\right)/10} + \text{SIR}_{\text{req}}$$

- $\text{PL}_r(d_j) = \text{PL}_{\text{ref}} + 10\, n \log_{10}(\max(1, d_j / \eta))$ over the source's slant range $d_j$, with the link's shared exponent $n$. $\text{PL}_{\text{ref}}$ is $\text{PL}_{1\text{m}}(f)$ for datasheet presets; for a field-calibrated preset it is the measured channel's 1 m loss $P_{\text{tx}} + 2G - P_{\text{ref}}$ (`refLossDb`), shared by every emitter on that channel.
- A source more than 150 MHz from the receiver's frequency, or whose path to the receiver is blocked by terrain, is skipped.
- $G_{\text{agility}}$: the preset's `hopGainDb` when spectrum agility is on, plus 6 dB when LPI mode is on. `hopGainDb` (12–16 dB on the agile presets) is a modelling estimate; no vendor publishes such a figure (see [RADIOS.md](RADIOS.md)).
- $\text{SIR}_{\text{req}}$: the preset's required signal-to-interference ratio `jamSirDb`, default +10 dB (FSK-class radios); the LoRa preset uses −15 dB.

Noise and interference add in milliwatts, so the receiver's effective sensitivity is $10 \log_{10}(10^{S_{\text{rx}}/10} + 10^{N_j/10})$ and the penalty is

$$I_{\text{rx}} = 10 \log_{10}\left(1 + 10^{(N_j - S_{\text{rx}})/10}\right)$$

which is 3.01 dB where the floor equals the sensitivity, and 0 with no source heard. The red zone drawn on the map is that 3 dB contour for one source over flat ground, using the chain radio's own exponent. No receiver selectivity or CW blocking is modelled.

### 3.4 Shadowing
Source: `fadeDb` and `stepFades` in `js/net.js`. Each link carries a time-driven Ornstein-Uhlenbeck offset

$$dF = -\frac{F}{\tau}\,dt + \sigma \sqrt{\frac{2\,dt}{\tau}}\;\mathcal{N}(0, 1), \qquad \tau = 10\,\text{s}$$

with the environment's stationary standard deviation $\sigma$ (open 2.5 dB, suburban 4.5 dB, urban 6.5 dB). A new link starts with a draw from that stationary distribution, so it carries the full $\sigma$ from birth. A link unused for 30 s is forgotten. The process depends on time, not on distance travelled (it is not the Gudmundson distance-correlated model).

### 3.5 Radio Horizon and Line of Sight (LOS)
The radio horizon over a 4/3 Earth (`radioHorizonM`):
$$d_{\text{horizon}} = \sqrt{2 k R_E h_1} + \sqrt{2 k R_E h_2} \approx 4120 \left(\sqrt{h_1} + \sqrt{h_2}\right)\,\text{m}$$
with antenna heights $h$ in metres. A link whose ground distance exceeds $d_{\text{horizon}}$, or which is blocked by terrain or buildings, has $M = -\infty$. The LOS test (`losBlocked` in `js/terrain.js`) requires a clearance of 0.6 of the first Fresnel zone at the lower of the two radios' frequencies, shrinking to zero at the antennas. The test is binary: the up-to-6 dB diffraction loss of a partly obstructed zone is not modelled.

### 3.6 Packet Error Rate (PER) Curve
The success probability of one transmission attempt (`pktSuccessProb`) is logistic in the margin:
$$P_{\text{succ}}(M) = \frac{1}{1 + \exp\left(-\frac{M - 2}{1.2}\right)}$$
That is about 16% at 0 dB, 50% at 2 dB and 97% at 6 dB. Separately, a hop with $M \le 0$ (or an undefined margin) never delivers; that hard gate, not the curve, is what makes delivery zero beyond the rated range. Datasheet sensitivity is quoted at a low error rate, so the rated range (margin 0) is the model's ~84%-loss edge ([RADIOS.md](RADIOS.md)). Unicast hops get up to 2 link-layer retries; a broadcast copy gets one roll.

Planning uses a 6 dB fade reserve: the usable hop range is where $M_{\text{PL}}$ falls to 6 dB (plus the LPI cost when it is on), and the routing cost of a link is $\text{ETX} = 1 / \max(0.05, P_{\text{succ}}(M - 6))$.

### 3.7 Field Calibration
Source: `js/calibrate.js`. A CSV of RSSI against distance is fitted by least squares to $n_{\text{fit}}$ and $P_{\text{ref}}$ (with RMSE, R² and a 95% confidence interval on $n$). The fit is refused when the distances span less than half a decade, when the 95% interval on $n$ is wider than ±0.5, when $n$ is outside 1.2–6.5, or when $P_{\text{ref}}$ is outside −120 to +40 dBm. Rows with a distance but no RSSI (blank, `lost`, `nan`, `-` and similar) are lost packets: they are fitted as left-censored below the base radio's sensitivity, together with a fitted distance-independent loss rate.

---

## 4. Shared Channel & Network Model

Source: `js/net.js`.

1. **Channels**: a radio's channel is its preset's `band` if set, otherwise its frequency bucket (`sub1g` below 1500 MHz, `2.4g` below 3000 MHz, `5g` above). Each channel is one swarm-wide, collision-free timeline (`chanBusyUntil`). Transmissions on a channel are perfectly serialized, so there are no collisions, no hidden-terminal loss and no spatial reuse: two drones 10 km apart on the same channel still take turns. Spectrum agility affects only the jamming margin (§3.3), not the channel.
2. **Airtime Accounting**: Packet transmission airtime:
   $$t_{\text{air}} = \frac{\text{bytes} \times 8}{\text{airRateKbps} \times 1000}$$
   Every attempt, retries included, holds the channel and the sender's transmit clock for $t_{\text{air}}$. C2 keeps a separate transmit clock per radio unit in a mixed fleet.
3. **Commit-at-Transmission**: Packet outcomes (RF margin, liveness of endpoints, interference) are evaluated when the packet departs the antenna, not when queued. Nothing reserves the channel in advance.
4. **Duty Cycle Throttling**: a preset with a duty limit makes its transmitter rest after each transmission:
   $$t_{\text{quiet}} = t_{\text{air}} \times \frac{1 - \text{duty}}{\text{duty}}$$
   The only regulated preset is LoRa EU868, at 10% duty in the 869.4–869.65 MHz sub-band (most other EU868 sub-bands are limited to 1%).
5. **Routing**: links are costed by ETX (§3.6). Unicast traffic to and from C2 follows one damped C2-rooted shortest-path tree, refreshed every 0.5 s and rebuilt at once when a node dies or launches; C2 order tables are flooded as broadcasts.
6. **Video**: a video chunk is admitted only if the channel backlog is at most 1 s and the backlog plus its airtime on every hop of its route is at most 2 s.
7. **Control pacing**: C2 announces its telemetry and command cadence in every order. A drone times its telemetry, its link-loss failsafe (3 × the command interval) and its tether staleness from the last cadence it received.

---

## 5. Aerodynamics and Battery Energy Model

Source: `js/airframes.js`, `updateBattery` in `js/swarm.js`.

### 5.1 Power Consumption
Hover power comes from actuator-disc momentum theory, divided by a lumped powertrain efficiency:

$$P_{\text{hover}} = \frac{\kappa\,(m g)^{3/2}}{\eta_{\text{pt}} \sqrt{2 \rho A}}$$

- Air density $\rho = 1.225\,\text{kg/m}^3$, mass $m$, gravity $g = 9.81\,\text{m/s}^2$.
- $A$: swept disc area, rotor count × $\pi r^2$. A coaxial airframe (the X8) counts its stacked pairs as one disc each and takes $\kappa = 1.281/\sqrt{2} \approx 0.906$ (Leishman, equal-thrust coaxial); otherwise $\kappa = 1$.
- $\eta_{\text{pt}}$: lumped efficiency (prop figure of merit × motor × ESC), 0.55 by default. A preset can carry its own: the micro uses 0.24, fitted to the DJI Mini 4 Pro's published 30 min hover, which also absorbs its camera, gimbal and video link draw. There is no separate avionics term.

Forward flight is level-flight momentum theory at airspeed $V = \min(1.3\,V_{\max}, \lVert \mathbf{v}_g - \mathbf{w} \rVert)$ (ground velocity minus wind):

$$\begin{aligned}
D &= \tfrac{1}{2} \rho\, C_D A\, V^2, \qquad T = \sqrt{(mg)^2 + D^2}, \qquad v_h^2 = \frac{T}{2 \rho A}, \qquad v_i^2 = \frac{2 v_h^4}{V^2 + \sqrt{V^4 + 4 v_h^4}} \\
P_{\text{elec}} &= P_{\text{hover}} \left(\text{FM} \cdot \frac{T\, v_i}{m g\, v_{h0}} + 1 - \text{FM}\right) + \frac{\text{FM} \cdot D\, V}{\eta_{\text{pt}}}
\end{aligned}$$

with $v_{h0} = \sqrt{mg / (2 \rho A)}$ the hover inflow and figure of merit $\text{FM} = 0.65$. $C_D A$ is the preset's `dragAreaM2`: micro 0.0155 m² (fitted to the DJI page's 34 min at 21.6 km/h), q450 0.04 m² and X8 0.05 m² (estimates). Induced power falls with airspeed (translational lift) while parasite power rises with $V^3$, so moderate wind can lower power below hover; power exceeds hover only toward maximum speed. At $V = 0$, $P_{\text{elec}} = P_{\text{hover}}$.

### 5.2 Battery Depletion
The pack starts at its usable energy, 80% of the nominal pack (`BATT_USABLE_FRAC`):
$$E(0) = E_{\text{usable}} = 0.8\,E_{\text{nominal}}, \qquad E(t) = E_{\text{usable}} - \int_0^t \frac{P_{\text{elec}}(\tau)}{3600}\,d\tau$$
$$\text{batteryPct}(t) = 100 \times \frac{E(t)}{E_{\text{usable}}}$$
So 100% on screen is 80% of the nominal pack. When $E$ reaches 0 the vehicle is down (lost), with 20% of the nominal energy still in the pack. Hover endurance is $E_{\text{usable}} / P_{\text{hover}}$: about 24 min for the micro, 22 min for the q450 and 36 min for the X8 (`hoverEnduranceMin`).

### 5.3 Smart-RTH and Order Feasibility
The ground speed along a leg with unit direction $\hat{\mathbf{u}}$ crabs out the crosswind:
$$V_{g} = \mathbf{w} \cdot \hat{\mathbf{u}} + \sqrt{V_{\max}^2 - w_{\perp}^2}$$
A leg with $w_\perp \ge V_{\max}$ has $V_g = 0$. The smart-RTH check treats a home leg with $V_g \le 0.05\,\text{m/s}$ as unflyable; the order check (below) rejects any leg with $V_g < 0.5\,\text{m/s}$. Each tick a flying drone (modes ok, hold, relink, rtl) compares its energy with the home leg, flown from its believed position to the base it last learned:
$$E \le P_{\text{elec}}(V_{\max}) \cdot \frac{d_{\text{home}}}{V_{g,\text{home}}} \cdot \frac{1.3}{3600} + 0.07\,E_{\text{usable}} \implies \text{RTB}$$
An unflyable home leg counts as infinite cost and triggers RTB at once. The home leg is billed at the maximum-speed power with a 1.3 margin (`BATTERY.homeMargin`) plus a reserve of 7% of usable energy. Before accepting an order, a drone adds the outbound leg to the same sum (commitment rule) and declines the order if a leg is unflyable or the energy is short. Both checks use the true wind vector: no onboard wind estimate is modelled.

---

## 6. Navigation and Belief Drift (GPS-Denied)

Source: `js/gpsnav.js`.

- **Nominal GNSS**: the navigation belief $\mathbf{x}_{\text{bel}}$ snaps to the truth $\mathbf{x}_{\text{true}}$, and the drone tracks the wind. Each position report adds Gaussian GPS noise ($\sigma = 1.5\,\text{m}$).
- **GNSS-Denied Zone**: the vehicle dead-reckons. Its belief integrates its airspeed plus the wind estimate frozen when GNSS was lost, plus a drift velocity that follows an Ornstein-Uhlenbeck process:
  $$\mathbf{x}_{\text{bel}}(t + \Delta t) = \mathbf{x}_{\text{bel}}(t) + \left(\mathbf{v}_g + (\hat{\mathbf{w}}_{\text{frozen}} - \mathbf{w}) + \mathbf{v}_{\text{drift}}\right) \Delta t$$
  $$\mathbf{v}_{\text{drift}}(t + \Delta t) = \mathbf{v}_{\text{drift}}(t) - \frac{\mathbf{v}_{\text{drift}}}{\tau}\Delta t + \sigma_{\text{drift}} \sqrt{\frac{2\,\Delta t}{\tau}}\;\mathcal{N}(0, 1)$$
  with $\sigma_{\text{drift}} = 1.2\,\text{m/s}$ per axis and $\tau = 25\,\text{s}$. With a constant wind the wind terms cancel; a wind that changes during the outage becomes navigation error the drone cannot see. The vehicle steers by $\mathbf{x}_{\text{bel}}$, so it misses its slot by its navigation error, and its telemetry carries the belief and a `gps: 'denied'` flag.

---

## 7. Model Scope & Limitations

The simulation strikes a deliberate balance between physical fidelity and 20 Hz real-time performance in standard web browsers:

1. **Point-Mass Kinematics**: Drones are modeled as point masses with an acceleration limit (4 m/s²) and an airspeed bound. Attitude (pitch/roll) and full 6-DOF rigid body rotational dynamics are omitted.
2. **Local Planar Earth**: Terrain and distances assume flat earth with curvature horizon clipping. Earth ellipsoidal geometry is projected locally without geodesics.
3. **Statistical RF Environment**: Large-scale fading is the per-link time-driven Ornstein-Uhlenbeck shadowing of §3.4; fast multipath (Rayleigh) fading is not modelled, and neither is diffraction around a partly blocked Fresnel zone (§3.5). Thermal noise is implicit in the datasheet sensitivity, and interference sources are band-wide barrage emitters with no receiver selectivity.
4. **Shared Channel**: each channel is one perfectly serialized swarm-wide timeline (§4): no collisions, no hidden terminals, no spatial reuse.
5. **Micro-Meteorology**: Wind is one spatially uniform, constant vector (the operator can change it); there are no gusts, building wakes or updrafts. Drone-side energy planning and the relink transit allowance read the true wind vector.
6. **Battery**: a constant-energy pack with no voltage sag, C-rate dependence, temperature derating or ageing. The usable 80% of the nominal pack is a hard cutoff that equals vehicle loss, and the smart-RTH reserve is 7% of usable energy plus the 1.3 margin on a maximum-speed home leg. Drones hold a commanded height above ground, and climbs and descents cost no energy.
7. **Autopilot Abstraction**: In built-in simulation mode, autopilot firmware loops are abstracted to waypoint tracking. In external mode, real firmware (ArduCopter SITL; the bridge refuses PX4) executes the true inner-loop flight dynamics via MAVLink.
