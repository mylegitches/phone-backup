import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

JOBS_FILE = Path(__file__).parent / 'data' / 'jobs.json'


def _now():
    return datetime.now(timezone.utc).isoformat()


def load_all():
    if not JOBS_FILE.exists():
        return {'version': 1, 'jobs': []}
    with open(JOBS_FILE, encoding='utf-8') as f:
        return json.load(f)


def save_all(data):
    JOBS_FILE.parent.mkdir(exist_ok=True)
    tmp = JOBS_FILE.with_suffix('.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, JOBS_FILE)


def list_jobs():
    return load_all().get('jobs', [])


def get_job(job_id):
    for j in list_jobs():
        if j['id'] == job_id:
            return j
    return None


def create_job(data):
    store = load_all()
    job = {
        'id': str(uuid.uuid4()),
        'created_at': _now(),
        'updated_at': _now(),
        'name': data.get('name', 'Untitled Job'),
        'device_serial': data.get('device_serial', ''),
        'method': data.get('method', 'pull'),
        'mappings': data.get('mappings', []),
        'backup_flags': data.get('backup_flags', {'apk': False, 'shared': True, 'all': False, 'system': False}),
        'backup_output': data.get('backup_output', ''),
    }
    store['jobs'].append(job)
    save_all(store)
    return job


def update_job(job_id, data):
    store = load_all()
    for i, j in enumerate(store['jobs']):
        if j['id'] == job_id:
            j.update({
                'updated_at': _now(),
                'name': data.get('name', j['name']),
                'device_serial': data.get('device_serial', j['device_serial']),
                'method': data.get('method', j['method']),
                'mappings': data.get('mappings', j['mappings']),
                'backup_flags': data.get('backup_flags', j['backup_flags']),
                'backup_output': data.get('backup_output', j['backup_output']),
            })
            store['jobs'][i] = j
            save_all(store)
            return j
    return None


def delete_job(job_id):
    store = load_all()
    original_len = len(store['jobs'])
    store['jobs'] = [j for j in store['jobs'] if j['id'] != job_id]
    if len(store['jobs']) < original_len:
        save_all(store)
        return True
    return False
