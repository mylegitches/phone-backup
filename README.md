# ADB Phone Backup Wizard

A local web app for backing up and managing Android phones via ADB (Android Debug Bridge). No cloud, no accounts — everything runs on your computer and talks directly to your phone.

## What it does

**Setup Wizard** — walks you through installing ADB on Windows, macOS, or Linux, enabling Developer Options on your phone, and pairing via USB or Wi-Fi. Step-by-step, OS-aware instructions with a one-click "Check ADB" verifier.

**Job Builder** — create named backup jobs that map phone folders to PC destinations. Mix and match:
- `/sdcard/DCIM` → your Photos folder
- `/sdcard/WhatsApp` → your backup drive
- `/sdcard/Download` → anywhere you like

Save multiple jobs (e.g. "Mom's Phone", "Weekly Full Backup") and run them on demand.

**Live Backup Runner** — runs your job with a live terminal showing `adb pull` output and per-folder progress bars.

**Device Tools** — one-click shortcuts for common ADB tricks:

| Tool | What it does |
|------|-------------|
| Screenshot | Captures and downloads a PNG from your phone |
| Screen Record | Records the screen and downloads the video |
| Mirror Screen | Instructions + command for [scrcpy](https://github.com/Genymobile/scrcpy) |
| Sideload APK | Installs an APK from your computer onto your phone |
| Push File | Sends any file from your computer to a phone path |
| Extract APK | Pulls an installed app's APK off the phone |
| Wireless ADB (Android 11+) | Pair and connect over Wi-Fi with a pairing code |
| Legacy Wi-Fi ADB | Enable TCP/IP mode, then connect wirelessly |
| Clipboard Sync | Send text from your PC directly to your phone's clipboard |
| Reboot | Reboot normally, to bootloader, or to recovery |
| Battery Info | Level, health, temperature, charging status |
| Device Info | Model, Android version, build number |
| Storage Usage | Disk space breakdown (`df -h`) |
| Dark Mode Toggle | Enable or disable dark mode instantly |
| Font Scale | Adjust system font size (0.85× – 1.30×) |
| Screen Density | Override DPI or reset to default |
| Input Text | Type text into your phone from the PC keyboard |
| Key Events | Send Home, Back, Power, Volume, etc. |

**App Manager** — list all installed apps and take action without digging through Settings:
- Clear app data (fix stuck or corrupted apps)
- Disable / re-enable system apps (remove bloatware without root)
- Uninstall apps (user 0 — no root needed)
- Grant permissions an app won't ask for itself

---

## Requirements

- Python 3.10+
- Android Platform Tools (ADB) — the wizard helps you install this

## Setup

```bash
pip install -r requirements.txt
python app.py
```

Open your browser to **http://localhost:5000** and follow the Setup Wizard.

---

## Quick Start: First Backup

1. Run `python app.py` and open http://localhost:5000
2. Click **Setup Wizard** and follow the 5 steps to install ADB and connect your phone
3. Click **Job Builder** → New Job
4. Add source/destination mappings (e.g. `/sdcard/DCIM` → `C:\Backups\Photos`)
5. Save the job, then click **Run Backup**
6. Watch live progress in the terminal panel

---

## Connecting Your Phone

### USB (simplest)
1. Plug phone into computer with a USB cable
2. On the phone's notification bar, change USB mode to **File Transfer (MTP)**
3. Accept the "Allow USB debugging?" prompt on the phone
4. Click **Detect Device** in the wizard

### Wi-Fi — Android 11+ (no cable needed after first time)
1. On phone: **Settings → Developer Options → Wireless Debugging → Pair device with pairing code**
2. Note the IP address, pairing port, and 6-digit code
3. Enter them in the wizard's Wi-Fi tab and click Pair

### Wi-Fi — older Android
1. Connect phone via USB first and confirm it's detected
2. In the wizard, click **Enable TCP/IP mode**
3. Unplug USB, find your phone's IP in Settings → About → Status
4. Click **Connect**

---

## Linux: USB Permissions (udev rules)

On Linux you may need udev rules so your user account can talk to Android devices without `sudo`:

```bash
# Ubuntu/Debian
sudo apt install android-sdk-platform-tools-common

# Or install the community udev rules:
# https://github.com/M0Rf30/android-udev-rules
```

After installing, replug the cable and re-run `adb devices`.

---

## Data & Privacy

- All data stays on your computer. Nothing is sent to any server.
- Job configs are saved in `data/jobs.json`.
- Settings (ADB path override, etc.) are saved in `data/settings.json`.

---

## Tips

- **`adb backup` is deprecated in Android 12+** — use `adb pull` mappings for media files. The backup method is available for older devices.
- **Multiple phones**: set a Device Serial on each job so the right job always targets the right phone. Get the serial from the device list in the wizard.
- **Scheduled backups**: run `python app.py` headlessly and trigger jobs via the API (`POST /api/run/<job_id>`). The SSE stream endpoint works from scripts too.
