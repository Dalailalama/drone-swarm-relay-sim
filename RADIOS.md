# Radio preset sources

Every preset in [js/radios.js](js/radios.js) uses vendor datasheet values
where the vendor publishes them; anything marked *(estimate)* below is a
judgment call, explained in the notes.
The rated LOS range is what the vendor claims (or the community reliably
reproduces) with the stock antennas listed, near ground level — it is the
calibration anchor for the path-loss model.

| Preset | Freq | TX | RX sens | Air rate | Rated LOS | Source |
|---|---|---|---|---|---|---|
| Holybro SiK V3 telemetry | 915 MHz | 20 dBm | −105 dBm | 64 kbps | 300 m | [Holybro V3 spec](https://docs.holybro.com/radio/sik-telemetry-radio-v3) |
| RFD900x long range | 915 MHz | 30 dBm | −93 dBm | 224 kbps | 40 km | [x-Series datasheet V2.0](https://rfdesign.com.au/wp-content/uploads/x-Series-Datasheet-V2.0.pdf), [modems](https://rfdesign.com.au/modems/) |
| ESP32 ESP-NOW (2.4 GHz) | 2.4 GHz | 20 dBm | −98 dBm | 1 Mbps | 300 m | [Espressif](https://www.espressif.com/en/solutions/low-power-solutions/esp-now) |
| ExpressLRS 2.4 GHz (100 mW) | 2.4 GHz | 20 dBm | −108 dBm | ~5 kbps telemetry | 10 km | [ExpressLRS docs](https://www.expresslrs.org/info/signal-health/) |
| LoRa SX1276 (EU868, SF10) | 869 MHz | 20 dBm | −132 dBm | ~1 kbps | 5 km | [Semtech SX1276](https://www.semtech.com/products/wireless-rf/lora-connect/sx1276) |
| XBee-PRO 900HP | 900 MHz | 24 dBm | −101 dBm | 200 kbps | 6.5 km | [Digi](https://www.digi.com/products/embedded-systems/digi-xbee/rf-modules/sub-1-ghz-rf-modules/xbee-pro-900hp) |
| Silvus StreamCaster 4400E (MN-MIMO) | 2.2 GHz | 33 dBm | −102 dBm (5 MHz BW) | 40 Mbps (estimate) | 20 km (estimate) | [SC4400E datasheet](https://silvustechnologies.com/hubfs/Sr%20Silvus2026/PDF/StreamCaster-4400-SC4400E-Enhanced-Datasheet.pdf), [product page](https://silvustechnologies.com/products/streamcaster-4400/) |
| Doodle Labs Mesh Rider (2.4 GHz) | 2.45 GHz | 30 dBm (estimate) | −101 dBm (estimate) | 20 Mbps (estimate) | 12 km (estimate) | [Doodle Labs](https://doodlelabs.com/products/mesh-rider-radios/) |
| Rajant Kinetic Mesh (ES1) | 2.4 GHz | 29 dBm | −96 dBm (estimate) | 30 Mbps (estimate) | 8 km (estimate) | [ES1 spec sheet](https://secure.rajant.com/publicFiles/1479), [ES1 series](https://rajant.com/products/es1-series/) |

Notes and judgment calls:

- **SiK V3**: sensitivity −105 dBm is Holybro's figure at the default 64 kbps
  air rate (−121 dBm is only reached at 2 kbps). Rated range
  is with the stock duck antennas; the community routinely gets several km
  with better antennas — model that by editing `rangeLosM`.
- **RFD900x**: air rate is configurable 12–224 kbps; sensitivity varies with
  rate (x-Series datasheet V2.0, p32: −102 dBm at 12 kbps, −101 dBm at the
  64 kbps default, −93 dBm at 224 kbps). The preset uses the 224 kbps row
  and the datasheet's stock 3 dBi dipoles. RFDesign quotes the range as
  "40+km (depending on antennas, and settings)" — not tied to dipoles or to
  an air rate, so 40 km at 224 kbps is the optimistic end of that claim.
- **ESP-NOW**: Espressif doesn't publish an official range; 200–480 m open
  field is the consistently reproduced community figure at 1 Mbps. The
  preset uses 300 m.
- **ExpressLRS**: the RF link is an RC control link; `airRateKbps` here is
  usable MAVLink telemetry throughput, not the raw LoRa chip rate.
- **LoRa EU868**: the 10% duty cycle models the 869.4–869.65 MHz sub-band.
  Range at SF10 near the ground is heavily antenna- and siting-dependent;
  5 km is a typical open-field result, not a ceiling.
- **XBee-PRO 900HP**: Digi rates 6.5 km (4 mi) LOS with 2.1 dBi dipoles and
  up to 15.5 km with high-gain antennas at the 10 kbps rate.
- **Silvus StreamCaster 4400E**: the SC4400E datasheet gives −102 dBm at
  5 MHz bandwidth (−108 dBm at 1.25 MHz, optional) and "up to 100 Mbps
  (adaptive)"; TX 33 dBm is 2 W per chain of the SC4480's 8 W. A 40 Mbps
  air rate needs 20 MHz and a higher MCS than the published sensitivity,
  so pairing them is optimistic — the 40 Mbps and the 20 km range are
  estimates (Silvus publishes no range figure).
- **Doodle Labs Mesh Rider**: the cited page publishes no TX power,
  sensitivity, throughput or range, and per-model datasheets are not
  public. All RF fields (30 dBm, −101 dBm, 20 Mbps, 12 km) are estimates
  for a 1 W 2.4 GHz Mesh Rider until a datasheet is cited.
- **Rajant ES1**: the ES1 spec sheet (updated 08/26/2025) gives max TX
  29 dBm ± 2 dB and 2.4 GHz sensitivity from −99 dBm at 1 Mbps to −71 dBm
  at 300 Mbps. −96 dBm is a low-rate figure, optimistic for a 30 Mbps air
  rate — both are estimates, as is the 8 km range (no vendor figure).

Anti-jam gain (`hopGainDb`) is a modelling estimate, not a datasheet
figure — no vendor publishes a dB rejection number. It is the interference
the radio sheds versus a fixed-channel link:

- **ExpressLRS 2.4 GHz (100 mW)**: 12 dB (estimate) — FHSS across the band.
- **Silvus StreamCaster 4400E (MN-MIMO)**: 16 dB (estimate) — MIMO
  interference cancellation/avoidance (MAN-IC / MAN-IA). Silvus documents
  single-frequency TDD, not frequency hopping.
- **Doodle Labs Mesh Rider (2.4 GHz)**: 13 dB (estimate) — channel/band
  agility ("Sense" switches channels to route around jamming).

Corrections and additional radios are very welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). A preset PR must cite a datasheet or a
reproducible field test.
