import json
import os
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from queue import Queue, Empty

from flask import Flask, Response, jsonify, render_template, request, send_file, stream_with_context

import adb
import jobs as jobs_module

app = Flask(__name__)
app.secret_key = os.urandom(24)

UPLOAD_DIR = Path(__file__).parent / 'static' / 'uploads'
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# run_id -> {'queue': Queue, 'done': bool, 'proc': Popen|None}
active_runs: dict[str, dict] = {}
# rec_id -> {'proc': Popen, 'serial': str, 'remote_path': str}
active_recordings: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Main page
# ---------------------------------------------------------------------------

@app.get('/')
def index():
    return render_template('index.html')


# ---------------------------------------------------------------------------
# Platform / ADB check
# ---------------------------------------------------------------------------

@app.get('/api/platform')
def api_platform():
    return jsonify(adb.get_platform_info())


@app.get('/api/adb/check')
def api_adb_check():
    result = adb.run(['version'])
    return jsonify({
        'found': result['success'],
        'version': result['stdout'].splitlines()[0] if result['success'] else None,
        'error': result['stderr'] if not result['success'] else None,
    })


@app.get('/api/adb/devices')
def api_adb_devices():
    return jsonify(adb.get_devices())


@app.post('/api/adb/pair')
def api_adb_pair():
    data = request.get_json()
    host = data.get('host', '').strip()
    port = data.get('port', '').strip()
    code = data.get('code', '').strip()
    if not host or not port or not code:
        return jsonify({'error': 'host, port and code are required'}), 400
    result = adb.run(['pair', f'{host}:{port}', code], timeout=30)
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


@app.post('/api/adb/connect')
def api_adb_connect():
    data = request.get_json()
    host = data.get('host', '').strip()
    port = data.get('port', '5555').strip()
    if not host:
        return jsonify({'error': 'host is required'}), 400
    result = adb.run(['connect', f'{host}:{port}'], timeout=15)
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


@app.post('/api/adb/tcpip')
def api_adb_tcpip():
    data = request.get_json()
    serial = data.get('serial', '').strip()
    s_args = ['-s', serial] if serial else []
    result = adb.run(s_args + ['tcpip', '5555'])
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

SETTINGS_FILE = Path(__file__).parent / 'data' / 'settings.json'


def load_settings():
    if SETTINGS_FILE.exists():
        with open(SETTINGS_FILE, encoding='utf-8') as f:
            return json.load(f)
    return {'adb_path': '', 'default_dest': ''}


def save_settings(data):
    SETTINGS_FILE.parent.mkdir(exist_ok=True)
    tmp = SETTINGS_FILE.with_suffix('.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, SETTINGS_FILE)


@app.get('/api/settings')
def api_get_settings():
    return jsonify(load_settings())


@app.post('/api/settings')
def api_save_settings():
    save_settings(request.get_json())
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# Jobs CRUD
# ---------------------------------------------------------------------------

@app.get('/api/jobs')
def api_list_jobs():
    return jsonify(jobs_module.list_jobs())


@app.post('/api/jobs')
def api_create_job():
    job = jobs_module.create_job(request.get_json())
    return jsonify(job), 201


@app.put('/api/jobs/<job_id>')
def api_update_job(job_id):
    job = jobs_module.update_job(job_id, request.get_json())
    if not job:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(job)


@app.delete('/api/jobs/<job_id>')
def api_delete_job(job_id):
    if jobs_module.delete_job(job_id):
        return jsonify({'ok': True})
    return jsonify({'error': 'Not found'}), 404


# ---------------------------------------------------------------------------
# Run backup job with SSE streaming
# ---------------------------------------------------------------------------

def _execute_backup(job, run_id):
    q = active_runs[run_id]['queue']
    serial = job.get('device_serial', '').strip()
    s_args = ['-s', serial] if serial else []

    def send(msg):
        q.put(msg)

    if job['method'] == 'pull':
        mappings = [m for m in job.get('mappings', []) if m.get('enabled', True)]
        for mapping in mappings:
            src = mapping['source']
            dest = mapping['destination']
            send({'type': 'mapping_start', 'id': mapping['id'], 'source': src, 'dest': dest})
            try:
                os.makedirs(dest, exist_ok=True)
            except Exception as e:
                send({'type': 'line', 'id': mapping['id'], 'text': f'Warning: could not create {dest}: {e}'})

            error = False
            for line in adb.stream(s_args + ['pull', src, dest]):
                send({'type': 'line', 'id': mapping['id'], 'text': line})
                if 'error' in line.lower() or 'failed' in line.lower():
                    error = True
            send({'type': 'mapping_done', 'id': mapping['id'], 'success': not error})

    elif job['method'] == 'backup':
        flags = job.get('backup_flags', {})
        args = s_args + ['backup']
        if flags.get('apk'):
            args.append('-apk')
        if flags.get('shared'):
            args.append('-shared')
        if flags.get('all'):
            args.append('-all')
        if flags.get('system'):
            args.append('-system')
        output_file = job.get('backup_output', '') or 'backup.ab'
        args += ['-f', output_file]

        send({'type': 'mapping_start', 'id': 'backup', 'source': 'Device Backup', 'dest': output_file})
        send({'type': 'line', 'id': 'backup', 'text': 'Starting adb backup — check your phone screen to authorize...'})

        for line in adb.stream(args):
            send({'type': 'line', 'id': 'backup', 'text': line})

        send({'type': 'mapping_done', 'id': 'backup', 'success': True})

    send({'type': 'job_done'})
    send({'done': True})
    active_runs[run_id]['done'] = True


@app.post('/api/run/<job_id>')
def api_run_job(job_id):
    job = jobs_module.get_job(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    run_id = str(uuid.uuid4())
    active_runs[run_id] = {'queue': Queue(), 'done': False}
    t = threading.Thread(target=_execute_backup, args=(job, run_id), daemon=True)
    t.start()
    return jsonify({'run_id': run_id})


@app.get('/api/stream/<run_id>')
def api_stream(run_id):
    if run_id not in active_runs:
        return Response('data: {"error":"unknown run"}\n\n', mimetype='text/event-stream')

    @stream_with_context
    def generate():
        q = active_runs[run_id]['queue']
        while True:
            try:
                msg = q.get(timeout=25)
            except Empty:
                yield 'event: ping\ndata: {}\n\n'
                continue
            yield f'data: {json.dumps(msg)}\n\n'
            if msg.get('done'):
                break

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


# ---------------------------------------------------------------------------
# Device Tools
# ---------------------------------------------------------------------------

def _serial_args(data):
    serial = (data or {}).get('serial', '').strip()
    return ['-s', serial] if serial else []


@app.post('/api/tools/screenshot')
def tool_screenshot():
    s_args = _serial_args(request.get_json())
    remote = '/sdcard/.adbwiz_ss.png'
    r = adb.run(s_args + ['shell', 'screencap', '-p', remote])
    if not r['success']:
        return jsonify({'error': r['stderr'] or 'screencap failed'}), 400
    tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
    tmp.close()
    r2 = adb.run(s_args + ['pull', remote, tmp.name])
    adb.run(s_args + ['shell', 'rm', remote])
    if not r2['success']:
        return jsonify({'error': r2['stderr']}), 400
    return send_file(tmp.name, mimetype='image/png', as_attachment=True, download_name='screenshot.png')


@app.post('/api/tools/screenrecord/start')
def tool_screenrecord_start():
    data = request.get_json()
    s_args = _serial_args(data)
    duration = int(data.get('duration', 180))
    rec_id = str(uuid.uuid4())[:8]
    remote = f'/sdcard/.adbwiz_rec_{rec_id}.mp4'
    try:
        adb_bin = adb.find_adb()
    except adb.AdbError as e:
        return jsonify({'error': str(e)}), 400

    extra = {}
    import platform
    if platform.system() == 'Windows':
        extra['creationflags'] = subprocess.CREATE_NO_WINDOW

    cmd = [adb_bin] + s_args + ['shell', 'screenrecord', '--time-limit', str(min(duration, 180)), remote]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **extra)
    active_recordings[rec_id] = {'proc': proc, 'serial': (data or {}).get('serial', ''), 'remote': remote}
    return jsonify({'rec_id': rec_id, 'max_seconds': min(duration, 180)})


@app.post('/api/tools/screenrecord/stop')
def tool_screenrecord_stop():
    data = request.get_json()
    rec_id = data.get('rec_id', '')
    rec = active_recordings.pop(rec_id, None)
    if not rec:
        return jsonify({'error': 'Recording not found'}), 404
    rec['proc'].terminate()
    try:
        rec['proc'].wait(timeout=5)
    except subprocess.TimeoutExpired:
        rec['proc'].kill()
    time.sleep(1)
    s_args = ['-s', rec['serial']] if rec['serial'] else []
    tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    tmp.close()
    adb.run(s_args + ['pull', rec['remote'], tmp.name])
    adb.run(s_args + ['shell', 'rm', rec['remote']])
    return send_file(tmp.name, mimetype='video/mp4', as_attachment=True, download_name='screen_recording.mp4')


@app.post('/api/tools/install')
def tool_install():
    s_args = _serial_args({'serial': request.form.get('serial', '')})
    f = request.files.get('apk')
    if not f:
        return jsonify({'error': 'No APK file provided'}), 400
    tmp = tempfile.NamedTemporaryFile(suffix='.apk', delete=False)
    f.save(tmp.name)
    tmp.close()
    result = adb.run(s_args + ['install', '-r', tmp.name], timeout=120)
    os.unlink(tmp.name)
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


@app.post('/api/tools/push')
def tool_push():
    s_args = _serial_args({'serial': request.form.get('serial', '')})
    remote_dest = request.form.get('dest', '/sdcard/')
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'No file provided'}), 400
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=Path(f.filename).suffix)
    f.save(tmp.name)
    tmp.close()
    result = adb.run(s_args + ['push', tmp.name, remote_dest], timeout=120)
    os.unlink(tmp.name)
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


@app.post('/api/tools/clipboard')
def tool_clipboard():
    data = request.get_json()
    s_args = _serial_args(data)
    text = data.get('text', '')
    # Use am broadcast for Clipper app, fall back to input text
    result = adb.run(s_args + ['shell', 'am', 'broadcast', '-a', 'clipper.set', '-e', 'text', text])
    if not result['success'] or 'Broadcast completed: result=0' in result['stdout']:
        # Fallback: input text directly
        safe = text.replace(' ', '%s').replace("'", "\\'")
        result = adb.run(s_args + ['shell', 'input', 'text', safe])
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


@app.post('/api/tools/reboot')
def tool_reboot():
    data = request.get_json()
    s_args = _serial_args(data)
    mode = data.get('mode', '')  # '', 'bootloader', 'recovery'
    args = s_args + ['reboot']
    if mode:
        args.append(mode)
    result = adb.run(args)
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


@app.post('/api/tools/input-text')
def tool_input_text():
    data = request.get_json()
    s_args = _serial_args(data)
    text = data.get('text', '').replace(' ', '%s')
    result = adb.run(s_args + ['shell', 'input', 'text', text])
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


@app.post('/api/tools/keyevent')
def tool_keyevent():
    data = request.get_json()
    s_args = _serial_args(data)
    keycode = str(data.get('keycode', ''))
    result = adb.run(s_args + ['shell', 'input', 'keyevent', keycode])
    return jsonify({'success': result['success']})


@app.get('/api/tools/battery')
def tool_battery():
    serial = request.args.get('serial', '').strip()
    s_args = ['-s', serial] if serial else []
    result = adb.run(s_args + ['shell', 'dumpsys', 'battery'])
    parsed = {}
    for line in result['stdout'].splitlines():
        if ':' in line:
            k, _, v = line.partition(':')
            parsed[k.strip()] = v.strip()
    return jsonify({'success': result['success'], 'raw': result['stdout'], 'parsed': parsed})


@app.get('/api/tools/deviceinfo')
def tool_deviceinfo():
    serial = request.args.get('serial', '').strip()
    s_args = ['-s', serial] if serial else []
    result = adb.run(s_args + ['shell', 'getprop'])
    interesting = ['ro.product.model', 'ro.product.manufacturer', 'ro.build.version.release',
                   'ro.build.version.sdk', 'ro.product.board', 'ro.serialno',
                   'ro.product.locale', 'gsm.network.type']
    props = {}
    for line in result['stdout'].splitlines():
        for key in interesting:
            if f'[{key}]' in line:
                val = line.split(']')[-1].strip().strip('[').strip(']')
                props[key] = val
    return jsonify({'success': result['success'], 'props': props, 'raw': result['stdout']})


@app.get('/api/tools/storage')
def tool_storage():
    serial = request.args.get('serial', '').strip()
    s_args = ['-s', serial] if serial else []
    result = adb.run(s_args + ['shell', 'df', '-h'])
    return jsonify({'success': result['success'], 'raw': result['stdout']})


@app.post('/api/tools/extract-apk')
def tool_extract_apk():
    data = request.get_json()
    s_args = _serial_args(data)
    pkg = data.get('package', '').strip()
    if not pkg:
        return jsonify({'error': 'package name required'}), 400
    r = adb.run(s_args + ['shell', 'pm', 'path', pkg])
    if not r['success'] or 'package:' not in r['stdout']:
        return jsonify({'error': f'Package not found: {pkg}'}), 404
    remote_path = r['stdout'].strip().split('package:')[-1].strip()
    tmp = tempfile.NamedTemporaryFile(suffix='.apk', delete=False)
    tmp.close()
    r2 = adb.run(s_args + ['pull', remote_path, tmp.name])
    if not r2['success']:
        return jsonify({'error': r2['stderr']}), 400
    return send_file(tmp.name, mimetype='application/vnd.android.package-archive',
                     as_attachment=True, download_name=f'{pkg}.apk')


@app.post('/api/tools/darkmode')
def tool_darkmode():
    data = request.get_json()
    s_args = _serial_args(data)
    enable = data.get('enable', True)
    value = 'yes' if enable else 'no'
    result = adb.run(s_args + ['shell', 'cmd', 'uimode', 'night', value])
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


@app.post('/api/tools/fontscale')
def tool_fontscale():
    data = request.get_json()
    s_args = _serial_args(data)
    scale = str(data.get('scale', '1.0'))
    result = adb.run(s_args + ['shell', 'settings', 'put', 'system', 'font_scale', scale])
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


@app.post('/api/tools/density')
def tool_density():
    data = request.get_json()
    s_args = _serial_args(data)
    dpi = data.get('dpi', '')
    if dpi == 'reset':
        result = adb.run(s_args + ['shell', 'wm', 'density', 'reset'])
    else:
        result = adb.run(s_args + ['shell', 'wm', 'density', str(dpi)])
    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


# ---------------------------------------------------------------------------
# App Manager
# ---------------------------------------------------------------------------

@app.get('/api/apps')
def api_list_apps():
    serial = request.args.get('serial', '').strip()
    filter_type = request.args.get('filter', 'user')  # 'user', 'system', 'all'
    s_args = ['-s', serial] if serial else []

    if filter_type == 'user':
        args = s_args + ['shell', 'pm', 'list', 'packages', '-3']
    elif filter_type == 'system':
        args = s_args + ['shell', 'pm', 'list', 'packages', '-s']
    else:
        args = s_args + ['shell', 'pm', 'list', 'packages']

    result = adb.run(args, timeout=30)
    packages = []
    for line in result['stdout'].splitlines():
        line = line.strip()
        if line.startswith('package:'):
            packages.append(line[len('package:'):].strip())
    packages.sort()
    return jsonify({'success': result['success'], 'packages': packages})


@app.post('/api/apps/action')
def api_app_action():
    data = request.get_json()
    s_args = _serial_args(data)
    pkg = data.get('package', '').strip()
    action = data.get('action', '')

    if not pkg:
        return jsonify({'error': 'package required'}), 400

    if action == 'clear':
        result = adb.run(s_args + ['shell', 'pm', 'clear', pkg])
    elif action == 'disable':
        result = adb.run(s_args + ['shell', 'pm', 'disable-user', '--user', '0', pkg])
    elif action == 'enable':
        result = adb.run(s_args + ['shell', 'pm', 'enable', pkg])
    elif action == 'uninstall':
        result = adb.run(s_args + ['shell', 'pm', 'uninstall', '--user', '0', pkg])
    elif action == 'grant':
        perm = data.get('permission', '').strip()
        if not perm:
            return jsonify({'error': 'permission required'}), 400
        result = adb.run(s_args + ['shell', 'pm', 'grant', pkg, perm])
    else:
        return jsonify({'error': f'Unknown action: {action}'}), 400

    return jsonify({'success': result['success'], 'output': result['stdout'] + result['stderr']})


# ---------------------------------------------------------------------------

if __name__ == '__main__':
    app.run(debug=True, port=5000, threaded=True)
