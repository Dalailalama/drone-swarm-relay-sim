#!/usr/bin/env bash
# run_ardupilot_sitl.sh - convenience launcher for N ArduCopter SITL instances.
#
# This is meant to be run by a human on a Linux box (e.g. the acg-kali-style
# test VM) that already has ArduPilot set up, NOT something exercised in CI
# or from the Windows dev host. It just saves typing out N `sim_vehicle.py`
# invocations with the right instance numbers / output ports by hand.
#
# Prerequisites:
#   - ArduPilot cloned and built (https://ardupilot.org/dev/docs/building-setup-linux.html)
#   - Tools/autotest/sim_vehicle.py on your PATH, or run this script from
#     inside your ArduPilot checkout so the relative path below resolves.
#     (Adjust SIM_VEHICLE below if your layout differs.)
#   - Python deps sim_vehicle.py itself needs (MAVProxy, etc.) already
#     installed, per the ArduPilot SITL setup docs.
#
# What it does: launches N ArduCopter SITL instances (instance numbers
# 0..N-1), each forwarding its MAVLink stream via --out=udp:127.0.0.1:PORT
# to a distinct UDP port that bridge.py listens on (udpin) for that vehicle.
# Port for instance i = 14550 + 10*i, matching bridge.py's default
# --mav-base-port=14550 assumption (see the comment in bridge.py's module
# docstring for why this spacing was chosen).
#
# ArduCopter is built ONCE up front and every instance starts with -N (no
# rebuild): parallel sim_vehicle.py rebuilds in the shared build dir used to
# collide and kill instances at startup (#9). Each instance also runs in its
# own directory ($SITL_RUN_DIR/inst<i>, default ./sitl_runs) so parameters
# (eeprom.bin), dataflash logs and terrain data aren't shared, and the script
# exits non-zero, naming the log, if any instance fails to come up.
# ArduPilot's console output goes to /tmp/ArduCopter.log (sim_vehicle.py
# names that file per vehicle type, so instances share it).
#
# Usage:
#   ./run_ardupilot_sitl.sh [N]      # N defaults to 3
#
# Then, in another terminal:
#   pip install -r requirements.txt
#   python bridge.py --count N
#
set -euo pipefail

N="${1:-3}"
BASE_PORT=14550

# Adjust this if sim_vehicle.py isn't already on PATH.
SIM_VEHICLE="${SIM_VEHICLE:-sim_vehicle.py}"
RUN_DIR="${SITL_RUN_DIR:-$PWD/sitl_runs}"

PIDS=()

cleanup() {
    echo ""
    echo "run_ardupilot_sitl.sh: caught exit, stopping all SITL instances..."
    for pid in "${PIDS[@]:-}"; do
        # Each sim_vehicle.py spawns child processes (SITL binary, MAVProxy
        # if enabled); killing the process group is more reliable than
        # killing just the launcher PID. "|| true" so a stray already-dead
        # PID doesn't abort the cleanup loop.
        kill -TERM -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
    echo "run_ardupilot_sitl.sh: done."
}
trap cleanup EXIT INT TERM

SV_PATH="$(command -v "$SIM_VEHICLE" || true)"
if [ -z "$SV_PATH" ]; then
    echo "run_ardupilot_sitl.sh: $SIM_VEHICLE not found; add ArduPilot's Tools/autotest to PATH or set SIM_VEHICLE" >&2
    exit 1
fi
AP_ROOT="$(cd "$(dirname "$SV_PATH")/../.." && pwd)"

echo "run_ardupilot_sitl.sh: building ArduCopter SITL once in $AP_ROOT (log: sitl_build.log)"
if ! (cd "$AP_ROOT" && ./waf configure --board sitl && ./waf copter) >sitl_build.log 2>&1; then
    tail -20 sitl_build.log >&2
    echo "run_ardupilot_sitl.sh: build failed" >&2
    exit 1
fi

echo "run_ardupilot_sitl.sh: launching $N ArduCopter SITL instance(s)"
echo ""
mkdir -p "$RUN_DIR"

for ((i = 0; i < N; i++)); do
    PORT=$((BASE_PORT + 10 * i))
    echo "  instance $i -> MAVLink forwarded to udp:127.0.0.1:${PORT} (bridge.py listens here as udpin), dir $RUN_DIR/inst$i"

    # -N: already built above, never rebuild per instance.
    # --use-dir: this instance's own eeprom.bin, logs and terrain cache.
    # --no-mavproxy: we don't need the interactive MAVProxy console, just
    # the raw MAVLink stream forwarded to the bridge.
    # -A "--serial0=udpclient:127.0.0.1:${PORT}": direct serial link to bridge's
    # udpin listener without depending on MAVProxy routing.
    setsid "$SIM_VEHICLE" -v ArduCopter -I"$i" -N --no-mavproxy --use-dir "$RUN_DIR/inst$i" \
        -A "--serial0=udpclient:127.0.0.1:${PORT}" \
        >"sitl_instance_${i}.log" 2>&1 &
    PIDS+=("$!")
    sleep 1
done

# sim_vehicle.py stays in the foreground for as long as its SITL binary
# runs, so a launcher that has already exited is a dead instance.
sleep 8
FAILED=0
for ((i = 0; i < N; i++)); do
    if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
        echo "  instance $i FAILED to start; tail of sitl_instance_${i}.log:" >&2
        tail -5 "sitl_instance_${i}.log" >&2 || true
        FAILED=1
    fi
done
if [ "$FAILED" -ne 0 ]; then
    echo "run_ardupilot_sitl.sh: not all instances started; stopping the rest" >&2
    exit 1
fi

echo ""
echo "All $N instance(s) running. MAVLink output ports:"
for ((i = 0; i < N; i++)); do
    echo "  vehicle $i: udp:127.0.0.1:$((BASE_PORT + 10 * i))"
done
echo ""
echo "Logs: sitl_instance_<i>.log in the current directory."
echo "Press Ctrl+C to stop all instances."
echo ""

wait
