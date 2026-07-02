#!/usr/bin/env bash
# Guided setup for the Wireshark GUI Wrapper on Debian/Ubuntu-based Linux.
# This script only *checks* your system and *asks* before installing or
# changing anything - it will not run sudo commands without your OK.
set -euo pipefail

echo "== Wireshark GUI Wrapper setup =="

need_install=()

if ! command -v python3 >/dev/null 2>&1; then
    need_install+=("python3")
fi

if ! python3 -c "import tkinter" >/dev/null 2>&1; then
    need_install+=("python3-tk")
fi

if ! command -v tshark >/dev/null 2>&1; then
    need_install+=("tshark")
fi

if ! command -v wireshark >/dev/null 2>&1; then
    echo "Note: full 'wireshark' app not found (optional, used by 'Open in Wireshark')."
    need_install+=("wireshark")
fi

if [ ${#need_install[@]} -gt 0 ]; then
    echo "Missing packages: ${need_install[*]}"
    if command -v apt >/dev/null 2>&1; then
        read -r -p "Install them now with apt? [y/N] " reply
        if [[ "$reply" =~ ^[Yy]$ ]]; then
            sudo apt update
            sudo apt install -y "${need_install[@]}"
        else
            echo "Skipping install. Install the packages above manually before running the app."
        fi
    else
        echo "apt not found - please install the packages above using your distro's package manager."
    fi
else
    echo "All required packages are already installed."
fi

echo
echo "Capturing packets normally requires root, or your user being in the"
echo "'wireshark' group with dumpcap permissions set up. To capture without"
echo "sudo every time, you can run:"
echo "  sudo dpkg-reconfigure wireshark-common   # choose 'Yes'"
echo "  sudo usermod -aG wireshark \$USER"
echo "then log out and back in."
echo
echo "Setup check complete. Run the app with:"
echo "  python3 $(dirname "$0")/wireshark_gui.py"
echo "(or 'sudo python3 wireshark_gui.py' if you skipped the group setup above)"
