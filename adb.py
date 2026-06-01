import subprocess
import shutil
import platform
import os
import json
from pathlib import Path


class AdbError(Exception):
    pass


def find_adb():
    settings_file = Path(__file__).parent / 'data' / 'settings.json'
    if settings_file.exists():
        try:
            with open(settings_file) as f:
                s = json.load(f)
            custom = s.get('adb_path', '').strip()
            if custom and Path(custom).exists():
                return custom
        except Exception:
            pass

    found = shutil.which('adb')
    if found:
        return found

    sys = platform.system()
    if sys == 'Windows':
        local = os.environ.get('LOCALAPPDATA', '')
        profile = os.environ.get('USERPROFILE', '')
        candidates = [
            os.path.join(local, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
            os.path.join(profile, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
            r'C:\platform-tools\adb.exe',
        ]
    elif sys == 'Darwin':
        home = os.path.expanduser('~')
        candidates = [
            os.path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
            '/opt/homebrew/bin/adb',
            '/usr/local/bin/adb',
        ]
    else:
        home = os.path.expanduser('~')
        candidates = [
            os.path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),
            '/usr/bin/adb',
            '/usr/local/bin/adb',
            '/usr/lib/android-sdk/platform-tools/adb',
        ]

    for p in candidates:
        if Path(p).exists():
            return p

    raise AdbError('ADB not found. Please install Android Platform Tools and make sure it is in your PATH.')


def _build_cmd(args):
    extra = {}
    if platform.system() == 'Windows':
        extra['creationflags'] = subprocess.CREATE_NO_WINDOW
    return [find_adb()] + list(args), extra


def run(args, timeout=30):
    try:
        cmd, extra = _build_cmd(args)
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=timeout,
            **extra,
        )
        return {
            'success': result.returncode == 0,
            'stdout': result.stdout,
            'stderr': result.stderr,
            'returncode': result.returncode,
        }
    except AdbError as e:
        return {'success': False, 'stdout': '', 'stderr': str(e), 'returncode': -1}
    except subprocess.TimeoutExpired:
        return {'success': False, 'stdout': '', 'stderr': 'Command timed out', 'returncode': -1}


def stream(args):
    """Yield output lines from a long-running adb command."""
    try:
        cmd, extra = _build_cmd(args)
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1,
            **extra,
        )
        for line in iter(proc.stdout.readline, ''):
            yield line.rstrip('\n\r')
        proc.stdout.close()
        proc.wait()
    except AdbError as e:
        yield f'ERROR: {e}'


def get_devices():
    result = run(['devices'])
    if not result['success'] and 'ADB not found' in result['stderr']:
        return {'error': result['stderr'], 'devices': []}
    devices = []
    for line in result['stdout'].splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) >= 2:
            devices.append({'serial': parts[0].strip(), 'state': parts[1].strip()})
    return {'devices': devices}


def get_platform_info():
    sys = platform.system()
    arch = platform.machine()

    adb_found = False
    adb_version = None
    adb_path_found = None
    try:
        p = find_adb()
        r = run(['version'])
        if r['success']:
            adb_found = True
            adb_path_found = p
            adb_version = r['stdout'].splitlines()[0] if r['stdout'] else ''
    except AdbError:
        pass

    if sys == 'Windows':
        return {
            'os': 'windows', 'arch': arch,
            'adb_found': adb_found, 'adb_version': adb_version, 'adb_path': adb_path_found,
            'download_url': 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
            'package_cmd': None,
            'install_steps': [
                'Click "Download Platform Tools" above.',
                'Extract the ZIP to C:\\platform-tools.',
                'Open System Properties → Advanced → Environment Variables.',
                'Under System Variables, find Path, click Edit, and add C:\\platform-tools.',
                'Open a new Command Prompt and run: adb version',
                'Come back here and click "Check ADB" to verify.',
            ],
            'udev_note': None,
        }
    elif sys == 'Darwin':
        return {
            'os': 'macos', 'arch': arch,
            'adb_found': adb_found, 'adb_version': adb_version, 'adb_path': adb_path_found,
            'download_url': 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
            'package_cmd': 'brew install --cask android-platform-tools',
            'install_steps': [
                'Option A (easiest): If you have Homebrew, run: brew install --cask android-platform-tools',
                'Option B: Click "Download Platform Tools" above and extract the ZIP.',
                'Add the extracted folder to your PATH in ~/.zshrc: export PATH="$HOME/platform-tools:$PATH"',
                'Open a new Terminal and run: adb version',
                'Come back here and click "Check ADB" to verify.',
            ],
            'udev_note': None,
        }
    else:
        return {
            'os': 'linux', 'arch': arch,
            'adb_found': adb_found, 'adb_version': adb_version, 'adb_path': adb_path_found,
            'download_url': 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
            'package_cmd': 'sudo apt install adb',
            'install_steps': [
                'Ubuntu/Debian: sudo apt update && sudo apt install adb',
                'Arch Linux: sudo pacman -S android-tools',
                'Or click "Download Platform Tools" above, extract it, and add to PATH.',
                'Open a new terminal and run: adb version',
                'Linux tip: you may also need udev rules for USB device access (see note below).',
                'Come back here and click "Check ADB" to verify.',
            ],
            'udev_note': 'Linux USB tip: install udev rules so your user can access Android devices without sudo.',
        }
