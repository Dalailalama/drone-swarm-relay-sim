# Simulation Physics & Modeling Specification (MODEL.md)

This document provides a concise, rigorous mathematical and physical specification of the models implemented in the drone swarm relay simulator: coordinate systems, radio frequency (RF) propagation, network scheduling, aerodynamics and power consumption, navigation drift, and known model limitations.

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
| Noise / Interference Power | Decibel-milliwatts | $\text{dBm}$ | Thermal noise floor + jammer ERP |
| Electrical Energy | Watt-hours | $\text{Wh}$ | Usable battery pack capacity |
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
- **Origin $(0, 0)$**: Command and Control (C2) ground station location.
- **X-axis**: Points **East** ($+x$).
- **Y-axis**: Points **South** ($+y$) to align with standard 2D canvas top-down coordinates.
- **Z-axis**: Height Above Ground Level (AGL) in metres ($+z$ is up).

### 2.2 Autopilot / MAVLink Frame (NED)
Autopilot firmware (ArduPilot / PX4) operates in North-East-Down (NED):
$$\begin{aligned}
x_{\text{NED}} &= -y_{\text{sim}} \quad (\text{North}) \\
y_{\text{NED}} &= +x_{\text{sim}} \quad (\text{East}) \\
z_{\text{NED}} &= -z_{\text{sim}} \quad (\text{Down})
\end{aligned}$$

### 2.3 Geographic Frame (WGS-84)
Local metric coordinates convert to WGS-84 relative to an anchor point $(\phi_0, \lambda_0)$ using equirectangular projection valid up to 50 km:
$$\begin{aligned}
\Delta \phi &= -\frac{y_{\text{sim}}}{R_E} \cdot \frac{180}{\pi} \\
\Delta \lambda &= \frac{x_{\text{sim}}}{R_E \cos(\phi_0)} \cdot \frac{180}{\pi}
\end{aligned}$$
where $R_E \approx 6,378,137\,\text{m}$ (WGS-84 equatorial radius).

---

## 3. Radio Frequency (RF) Propagation Model

### 3.1 Path Loss and Link Margin
The received signal strength $P_{\text{rx}}$ (in $\text{dBm}$) over 3D distance $d = \sqrt{(x_1 - x_2)^2 + (y_1 - y_2)^2 + (z_1 - z_2)^2}$ is:

$$P_{\text{rx}}(d) = P_{\text{tx}} + G_{\text{tx}} + G_{\text{rx}} - \text{FSPL}(d_0) - 10 n \log_{10}\left(\frac{d}{d_0}\right) - X_\sigma - L_{\text{prop}}$$

where:
- $P_{\text{tx}}$: Transmitter power ($\text{dBm}$).
- $G_{\text{tx}}, G_{\text{rx}}$: Antenna gains ($\text{dBi}$).
- $d_0 = 1\,\text{m}$: Reference distance.
- $\text{FSPL}(d_0) = 20 \log_{10}\left(\frac{4\pi d_0 f}{c}\right)$: Free-space path loss at 1 metre for carrier frequency $f$.
- $n$: Path loss exponent, scaled by environmental factor $\eta$:
  $$n = 2.0 + (1 - \eta) \cdot 1.6 \quad (\text{open: } \eta=1.0 \implies n=2.0; \text{ urban: } \eta=0.2 \implies n=3.28)$$
- $X_\sigma$: Zero-mean Gaussian shadow fading random variable with standard deviation $\sigma \in [2.5, 6.5]\,\text{dB}$.
- $L_{\text{prop}}$: Waveform penalty (e.g. $L_{\text{LPI}} = 3.0\,\text{dB}$ when Low Probability of Intercept spread spectrum is engaged).

The **Link Margin** $M$ in decibels relative to receiver sensitivity $S_{\text{rx}}$:
$$M = P_{\text{rx}} - S_{\text{rx}} - I_{\text{ext}}$$
where $I_{\text{ext}}$ is interference power from active jammers or co-channel emitters.

### 3.2 Radio Horizon and Line of Sight (LOS)
The geometric radio horizon distance over spherical earth with equivalent radius $k R_E$ ($k = 4/3$ for standard atmospheric refraction):
$$d_{\text{horizon}} = \sqrt{2 k R_E z_1} + \sqrt{2 k R_E z_2} \approx 4120 \left(\sqrt{z_1} + \sqrt{z_2}\right)\,\text{m}$$
Links exceeding $d_{\text{horizon}}$ or intercepted by digital elevation models / 3D building footprints are assigned $M = -\infty$.

### 3.3 Packet Error Rate (PER) Curve
Individual packet transmission success probability $P_{\text{succ}}$ is modeled as a sigmoid function of margin $M$:
$$P_{\text{succ}}(M) = \frac{1}{1 + \exp\left(-\frac{M - M_{\text{thresh}}}{\text{scale}}\right)}$$
For positive margins ($M \ge 10\,\text{dB}$), $P_{\text{succ}} \approx 1.0$. Around threshold ($M \approx 0\,\text{dB}$), packet delivery collapses to zero.

---

## 4. Shared Channel & Network Model

1. **Half-Duplex Contention**: A radio cannot transmit and receive simultaneously.
2. **Airtime Accounting**: Packet transmission airtime:
   $$t_{\text{air}} = \frac{\text{bytes} \times 8}{\text{airRateKbps} \times 1000}$$
   Airtime occupies the channel clock; overlapping transmissions on the same channel induce packet collisions unless frequency-hopping agility is enabled.
3. **Commit-at-Transmission**: Packet outcomes (RF margin, liveness of endpoints, interference) are evaluated when the packet departs the antenna, not when queued.
4. **Duty Cycle Throttling**: Radios operating on regulated bands (e.g. EU868 LoRa with 1% duty cycle) enforce minimum transmission gaps:
   $$t_{\text{quiet}} \ge t_{\text{air}} \times \left(\frac{1 - \text{duty}}{\text{duty}}\right)$$

---

## 5. Aerodynamics and Battery Energy Model

### 5.1 Power Consumption
Total instantaneous electrical power $P_{\text{elec}}$ consumed by an airframe in flight is modeled via actuator disk momentum theory plus parasite drag:

$$P_{\text{elec}} = \frac{P_{\text{ind}} + P_{\text{par}}}{\eta_{\text{power}}} + P_{\text{avionics}}$$

where:
- **Induced Hover Power** ($P_{\text{ind}}$):
  $$P_{\text{ind}} = \frac{(m g)^{3/2}}{\sqrt{2 \rho A_{\text{rotor}}}}$$
  with air density $\rho = 1.225\,\text{kg/m}^3$, total mass $m$, gravity $g = 9.80665\,\text{m/s}^2$, and rotor disk area $A_{\text{rotor}}$.
- **Parasite Drag Power** ($P_{\text{par}}$):
  $$P_{\text{par}} = \frac{1}{2} \rho C_D A_{\text{front}} V_a^3$$
  scaling with the cube of airspeed $V_a = \|\mathbf{v}_g - \mathbf{w}\|$ (ground velocity minus wind vector).
- $\eta_{\text{power}} \approx 0.55$: Lumped powertrain efficiency (ESC, motor, propulsive figure of merit).
- $P_{\text{avionics}}$: Baseline electrical draw of flight controller, sensors, and onboard telemetry radio ($3\text{--}8\,\text{W}$).

### 5.2 Battery Depletion
For a battery pack with nominal energy $E_0\,\text{Wh}$, remaining energy integrates power over time:
$$E(t) = E_0 - \int_0^t \frac{P_{\text{elec}}(\tau)}{3600}\,d\tau$$
$$\text{batteryPct}(t) = \max\left(0, 100 \times \frac{E(t)}{E_0}\right)$$

### 5.3 Smart-RTH Feasibility
Return-to-Home energy requirement $E_{\text{RTH}}$ is computed along the wind-adjusted return vector $\mathbf{d}_{\text{home}}$:
$$V_{\text{ground, return}} = \mathbf{V}_a \cdot \hat{\mathbf{d}}_{\text{home}} + \mathbf{w} \cdot \hat{\mathbf{d}}_{\text{home}}$$
If $V_{\text{ground, return}} \le 0$, the return leg is aerodynamically unflyable into headwind, and immediate emergency failsafe is declared.

---

## 6. Navigation and Belief Drift (GPS-Denied)

- **Nominal GNSS**: Truth coordinates $\mathbf{x}_{\text{true}}$ directly update navigation belief $\mathbf{x}_{\text{bel}}$.
- **GNSS-Denied Zone**: In jammed regions, the vehicle dead-reckons by integrating commanded velocity plus unobserved stochastic sensor drift:
  $$\mathbf{x}_{\text{bel}}(t + \Delta t) = \mathbf{x}_{\text{bel}}(t) + (\mathbf{v}_{\text{cmd}} + \mathbf{v}_{\text{drift}}) \Delta t$$
  $$\mathbf{v}_{\text{drift}}(t + \Delta t) = \mathbf{v}_{\text{drift}}(t) + \mathcal{N}(0, \sigma_{\text{drift}}^2) \Delta t$$
  The vehicle steers by $\mathbf{x}_{\text{bel}}$, causing physical trajectory divergence from intended slots.

---

## 7. Model Scope & Limitations

The simulation strikes a deliberate balance between physical fidelity and 20 Hz real-time performance in standard web browsers:

1. **Point-Mass Kinematics**: Drones are modeled as point masses with acceleration limits, pitch/roll tilt dynamics, and velocity bounds. Full 6-DOF rigid body rotational moments of inertia are omitted.
2. **Local Planar Earth**: Terrain and distances assume flat earth with curvature horizon clipping. Earth ellipsoidal geometry is projected locally without geodesics.
3. **Statistical RF Environment**: Multipath fast Rayleigh fading is represented through log-normal shadowing distributions rather than full electrodynamic boundary-element wave solvers.
4. **Micro-Meteorology**: Wind fields are modeled as spatially uniform vectors with temporal gusts; localized building wake vortices and updrafts are not simulated.
5. **Autopilot Abstraction**: In built-in simulation mode, autopilot firmware loops are abstracted to waypoint tracking. In external mode, real firmware (ArduPilot/PX4) executes the true inner-loop flight dynamics via MAVLink.
