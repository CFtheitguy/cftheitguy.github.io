# Wireshark GUI Wrapper

A minimal point-and-click app for capturing and viewing network traffic
on Linux, without needing to know any command-line syntax. It runs
`tshark` (Wireshark's capture engine) for you behind a simple window with
Start/Stop, a filter box, and a live packet table - and a button to open
the full Wireshark app on the same capture whenever you want to dig deeper.

Everything runs **locally on your own computer**. Nothing is uploaded
anywhere.

## Requirements

- Linux with Python 3 (comes with Tkinter on most distros)
- `tshark` (installed with Wireshark, or via `wireshark-common`/`tshark` package)
- Optional: the full `wireshark` app, for the "Open in Wireshark" button

## Setup

1. Download this folder (or the whole repo) to your Linux computer.
2. Run the guided setup, which checks for missing packages and asks
   before installing anything:

   ```bash
   ./install.sh
   ```

3. Launch the app:

   ```bash
   python3 wireshark_gui.py
   ```

## Capturing without sudo every time

Packet capture normally needs root. To allow your regular user account
to capture (recommended, instead of running the GUI as root):

```bash
sudo dpkg-reconfigure wireshark-common   # choose "Yes"
sudo usermod -aG wireshark $USER
```

Then log out and back in. `install.sh` prints these same steps.

If you'd rather not set that up, just run the app with `sudo python3
wireshark_gui.py`.

## Using the app

1. Pick a network interface from the dropdown (e.g. `eth0`, `wlan0`).
2. Optionally type a filter using normal Wireshark filter syntax, e.g.
   `tcp.port == 443` or `http`.
3. Click **Start** to begin capturing; **Stop** to end it.
4. Use **Save As...** to export the capture as a `.pcapng` file, or
   **Open in Wireshark** to inspect it in the full Wireshark app.

## Only capture traffic you're authorized to monitor

Use this tool only on networks and devices you own or have explicit
permission to monitor.
