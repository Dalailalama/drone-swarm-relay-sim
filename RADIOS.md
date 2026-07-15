# Radio preset sources

Every preset in [js/radios.js](js/radios.js) uses vendor datasheet values.
The rated LOS range is what the vendor claims (or the community reliably
reproduces) with the stock antennas listed, near ground level — it is the
calibration anchor for the path-loss model.

| Preset | Freq | TX | RX sens | Air rate | Rated LOS | Source |
|---|---|---|---|---|---|---|
| Holybro SiK V3 telemetry | 915 MHz | 20 dBm | −117 dBm | 64 kbps | 300 m | [Holybro docs](https://docs.holybro.com/telemetry-radio/sik-telemetry-radio) |
| RFD900x long range | 915 MHz | 30 dBm | −105 dBm | 224 kbps | 40 km | [RFDesign](https://rfdesign.com.au/products/rfd900x-modem/) |
| ESP32 ESP-NOW | 2.4 GHz | 20 dBm | −98 dBm | 1 Mbps | 300 m | [Espressif](https://www.espressif.com/en/solutions/low-power-solutions/esp-now) |
| ExpressLRS 2.4 GHz (100 mW) | 2.4 GHz | 20 dBm | −108 dBm | ~5 kbps telemetry | 10 km | [ExpressLRS docs](https://www.expresslrs.org/info/signal-health/) |
| LoRa SX1276 (EU868, SF10) | 869 MHz | 20 dBm | −132 dBm | ~1 kbps | 5 km | [Semtech SX1276](https://www.semtech.com/products/wireless-rf/lora-connect/sx1276) |
| XBee-PRO 900HP | 900 MHz | 24 dBm | −101 dBm | 200 kbps | 6.5 km | [Digi](https://www.digi.com/products/embedded-systems/digi-xbee/rf-modules/sub-1-ghz-rf-modules/xbee-pro-900hp) |

Notes and judgment calls:

- **SiK V3**: sensitivity −117 dBm is at the 64 kbps air rate. Rated range
  is with the stock duck antennas; the community routinely gets several km
  with better antennas — model that by editing `rangeLosM`.
- **RFD900x**: air rate is configurable 12–224 kbps; sensitivity varies with
  rate. The preset uses the high-rate figures with the >40 km claim, which
  RFDesign states for dipole antennas.
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

Corrections and additional radios are very welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). A preset PR must cite a datasheet or a
reproducible field test.
