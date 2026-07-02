#!/usr/bin/env python3
"""Simple point-and-click GUI for capturing and viewing network traffic
via tshark (Wireshark's command-line engine) - no terminal commands needed.

Run with:  python3 wireshark_gui.py
"""

import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import tkinter as tk
from tkinter import ttk, messagebox, filedialog

TSHARK = shutil.which("tshark")
WIRESHARK = shutil.which("wireshark")

# (tshark field name, column header)
FIELDS = [
    ("frame.number", "No."),
    ("frame.time_relative", "Time"),
    ("ip.src", "Source"),
    ("ip.dst", "Destination"),
    ("_ws.col.Protocol", "Protocol"),
    ("frame.len", "Length"),
    ("_ws.col.Info", "Info"),
]

MAX_ROWS = 5000


def list_interfaces():
    """Return a list of (id, description) capture interfaces via `tshark -D`."""
    if not TSHARK:
        return []
    try:
        out = subprocess.run(
            [TSHARK, "-D"], capture_output=True, text=True, timeout=10, check=True
        ).stdout
    except Exception:
        return []
    interfaces = []
    for line in out.splitlines():
        line = line.strip()
        if not line or "." not in line:
            continue
        _, rest = line.split(".", 1)
        rest = rest.strip()
        name = rest.split(" ", 1)[0]
        interfaces.append((name, rest))
    return interfaces


class WiresharkGUI(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Wireshark GUI Wrapper")
        self.geometry("1000x600")

        self.proc = None
        self.reader_thread = None
        self.line_queue = queue.Queue()
        self.row_count = 0
        self.capture_file = os.path.join(
            tempfile.gettempdir(), "wireshark_gui_capture.pcapng"
        )

        self._build_ui()
        self._check_prereqs()
        self._poll_queue()

    # ---------- UI ----------
    def _build_ui(self):
        top = ttk.Frame(self, padding=8)
        top.pack(side=tk.TOP, fill=tk.X)

        ttk.Label(top, text="Interface:").pack(side=tk.LEFT)
        self.iface_var = tk.StringVar()
        self.iface_combo = ttk.Combobox(
            top, textvariable=self.iface_var, width=30, state="readonly"
        )
        self.iface_combo.pack(side=tk.LEFT, padx=(4, 10))
        self._refresh_interfaces()

        ttk.Button(top, text="Refresh", command=self._refresh_interfaces).pack(
            side=tk.LEFT, padx=(0, 10)
        )

        ttk.Label(top, text="Filter:").pack(side=tk.LEFT)
        self.filter_var = tk.StringVar()
        filter_entry = ttk.Entry(top, textvariable=self.filter_var, width=30)
        filter_entry.pack(side=tk.LEFT, padx=(4, 10))
        filter_entry.insert(0, "e.g. tcp.port == 443")

        self.start_btn = ttk.Button(top, text="Start", command=self.start_capture)
        self.start_btn.pack(side=tk.LEFT, padx=4)
        self.stop_btn = ttk.Button(
            top, text="Stop", command=self.stop_capture, state=tk.DISABLED
        )
        self.stop_btn.pack(side=tk.LEFT, padx=4)
        ttk.Button(top, text="Clear", command=self.clear_list).pack(
            side=tk.LEFT, padx=4
        )
        ttk.Button(top, text="Save As...", command=self.save_as).pack(
            side=tk.LEFT, padx=4
        )
        ttk.Button(
            top, text="Open in Wireshark", command=self.open_in_wireshark
        ).pack(side=tk.LEFT, padx=4)

        columns = [c[0] for c in FIELDS]
        self.tree = ttk.Treeview(self, columns=columns, show="headings")
        for field, header in FIELDS:
            self.tree.heading(field, text=header)
            width = 90 if field in ("frame.number", "frame.len") else 150
            if field == "_ws.col.Info":
                width = 350
            self.tree.column(field, width=width, anchor=tk.W)
        self.tree.pack(fill=tk.BOTH, expand=True, padx=8, pady=(0, 8))

        vsb = ttk.Scrollbar(self.tree, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        vsb.pack(side=tk.RIGHT, fill=tk.Y)

        self.status_var = tk.StringVar(value="Ready.")
        ttk.Label(self, textvariable=self.status_var, anchor=tk.W, padding=4).pack(
            side=tk.BOTTOM, fill=tk.X
        )

        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _check_prereqs(self):
        if not TSHARK:
            messagebox.showerror(
                "tshark not found",
                "This tool needs Wireshark's 'tshark' command-line engine.\n\n"
                "Install it first, e.g.:\n"
                "  sudo apt install wireshark-common tshark\n\n"
                "See install.sh in this folder for a guided setup.",
            )
            self.start_btn.config(state=tk.DISABLED)

    def _refresh_interfaces(self):
        interfaces = list_interfaces()
        values = [f"{name} ({desc})" if desc else name for name, desc in interfaces]
        self.iface_combo["values"] = values
        if values and not self.iface_var.get():
            self.iface_combo.current(0)

    # ---------- Capture control ----------
    def start_capture(self):
        if self.proc is not None:
            return
        if not TSHARK:
            messagebox.showerror("Missing tshark", "tshark is not installed.")
            return

        choice = self.iface_var.get()
        if not choice:
            messagebox.showwarning("No interface", "Please choose a network interface.")
            return
        iface = choice.split(" ", 1)[0]

        display_filter = self.filter_var.get().strip()
        if display_filter.startswith("e.g."):
            display_filter = ""

        cmd = [TSHARK, "-i", iface, "-l", "-n", "-P", "-T", "fields"]
        for field, _ in FIELDS:
            cmd += ["-e", field]
        cmd += ["-E", "separator=\t", "-E", "occurrence=f"]
        if display_filter:
            cmd += ["-Y", display_filter]
        cmd += ["-w", self.capture_file]

        try:
            self.proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except Exception as exc:
            messagebox.showerror("Failed to start capture", str(exc))
            self.proc = None
            return

        self.reader_thread = threading.Thread(target=self._read_output, daemon=True)
        self.reader_thread.start()

        self.start_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.NORMAL)
        self.status_var.set(f"Capturing on {iface}...")

    def stop_capture(self):
        if self.proc is None:
            return
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.proc = None
        self.start_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.DISABLED)
        self.status_var.set(f"Stopped. {self.row_count} packets captured.")

    def _read_output(self):
        proc = self.proc
        if proc is None or proc.stdout is None:
            return
        for line in proc.stdout:
            self.line_queue.put(line.rstrip("\n"))
        if proc.stderr is not None:
            err = proc.stderr.read()
            if err and "Capturing on" not in err:
                self.line_queue.put(f"__ERROR__{err.strip()}")

    def _poll_queue(self):
        try:
            while True:
                line = self.line_queue.get_nowait()
                if line.startswith("__ERROR__"):
                    self.status_var.set(line[len("__ERROR__") :][:200])
                    continue
                self._add_row(line)
        except queue.Empty:
            pass
        self.after(150, self._poll_queue)

    def _add_row(self, line):
        parts = line.split("\t")
        if len(parts) < len(FIELDS):
            parts += [""] * (len(FIELDS) - len(parts))
        self.tree.insert("", tk.END, values=parts)
        self.row_count += 1
        if self.row_count % 20 == 0:
            self.status_var.set(f"Capturing... {self.row_count} packets")
        children = self.tree.get_children()
        if len(children) > MAX_ROWS:
            for old in children[: len(children) - MAX_ROWS]:
                self.tree.delete(old)

    def clear_list(self):
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.row_count = 0
        self.status_var.set("Cleared.")

    # ---------- File actions ----------
    def save_as(self):
        if not os.path.exists(self.capture_file):
            messagebox.showinfo("No capture", "Start and stop a capture first.")
            return
        dest = filedialog.asksaveasfilename(
            defaultextension=".pcapng",
            filetypes=[("Wireshark capture", "*.pcapng"), ("All files", "*.*")],
        )
        if dest:
            shutil.copy(self.capture_file, dest)
            self.status_var.set(f"Saved to {dest}")

    def open_in_wireshark(self):
        if not os.path.exists(self.capture_file):
            messagebox.showinfo("No capture", "Start and stop a capture first.")
            return
        if not WIRESHARK:
            messagebox.showerror(
                "Wireshark not found",
                "The full Wireshark app isn't installed.\n"
                "Install it with: sudo apt install wireshark",
            )
            return
        subprocess.Popen([WIRESHARK, self.capture_file])

    def _on_close(self):
        self.stop_capture()
        self.destroy()


def main():
    if sys.platform not in ("linux", "linux2"):
        print("This tool is designed for Linux.")
    app = WiresharkGUI()
    app.mainloop()


if __name__ == "__main__":
    main()
