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

echo "run_ardupilot_sitl.sh: launching $N ArduCopter SITL instance(s)"
echo ""

for ((i = 0; i < N; i++)); do
    PORT=$((BASE_PORT + 10 * i))
    echo "  instance $i -> MAVLink forwarded to udp:127.0.0.1:${PORT} (bridge.py listens here as udpin)"

    # --no-mavproxy: we don't need the interactive MAVProxy console, just
    # the raw MAVLink stream forwarded to the bridge.
    # --out=udp:127.0.0.1:PORT: forwards (in addition to SITL's own default
    # links) a MAVLink stream to our bridge's udpin listener for this vehicle.
    setsid "$SIM_VEHICLE" -v ArduCopter -I"$i" --no-mavproxy \
        --out="udp:127.0.0.1:${PORT}" \
        >"sitl_instance_${i}.log" 2>&1 &
    PIDS+=("$!")

    # Stagger startup a little; launching many SITL instances at once can
    # thrash disk/CPU and cause spurious startup failures.
    sleep 3
done

echo ""
echo "All $N instance(s) launched. MAVLink output ports:"
for ((i = 0; i < N; i++)); do
    echo "  vehicle $i: udp:127.0.0.1:$((BASE_PORT + 10 * i))"
done
echo ""
echo "Logs: sitl_instance_<i>.log in the current directory."
echo "Press Ctrl+C to stop all instances."
echo ""

wait
