#!/usr/bin/env python3
"""Consistent SQLite snapshot + referenced immutable objects. Private local backup."""
import datetime, gzip, hashlib, json, os, pathlib, shutil, sqlite3, tempfile
os.umask(0o077)
config = json.loads(pathlib.Path(os.environ['HUB_SERVER_CONFIG']).read_text())
database = pathlib.Path(config['database'])
directory = database.parent / 'backups'
directory.mkdir(mode=0o700, exist_ok=True)
object_root = pathlib.Path(config.get('objectDirectory', database.parent / 'objects'))
object_backup = directory / 'objects'
object_backup.mkdir(mode=0o700, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
with tempfile.TemporaryDirectory(dir=directory) as work:
    snapshot = pathlib.Path(work) / 'snapshot.sqlite'
    source = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    destination = sqlite3.connect(snapshot)
    source.backup(destination)
    assert destination.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    objects = {}
    for (body,) in destination.execute("SELECT body FROM hub_v2_records WHERE kind='shared_file_version' OR (kind='shared_chunk' AND status<>'cleaned')"):
        row = json.loads(body)
        if row.get('storage', 'disk') != 'disk':
            continue
        key = row['objectKey']
        name = hashlib.sha256(key.encode()).hexdigest()
        objects[name] = {'size': row['size'], 'sha256': row['sha256']}
    destination.close(); source.close()
    for name, expected in objects.items():
        original = object_root / name
        with original.open('rb') as stream:
            checksum = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 * 1024), b''): checksum.update(block)
            actual = checksum.hexdigest()
        assert actual == expected['sha256'] and original.stat().st_size == expected['size'], 'Object integrity failure'
        saved = object_backup / name
        if not saved.exists():
            temporary = pathlib.Path(work) / name
            shutil.copyfile(original, temporary)
            os.replace(temporary, saved)
    compressed = pathlib.Path(work) / 'snapshot.sqlite.gz'
    with snapshot.open('rb') as src, gzip.open(compressed, 'wb') as dst:
        shutil.copyfileobj(src, dst)
    with compressed.open('rb') as done: os.fsync(done.fileno())
    manifest = pathlib.Path(work) / 'manifest.json'
    manifest.write_text(json.dumps({'stamp': stamp, 'objects': objects, 'database': 'hub-' + stamp + '.sqlite.gz'}))
    # Both are only advertised after every referenced object has been copied and checked.
    os.replace(compressed, directory / ('hub-' + stamp + '.sqlite.gz'))
    os.replace(manifest, directory / ('hub-' + stamp + '.manifest.json'))
for old in sorted(directory.glob('hub-*.manifest.json'))[:-7]:
    data = json.loads(old.read_text())
    (directory / data['database']).unlink(missing_ok=True)
    old.unlink()
for old in sorted(directory.glob('hub-*.sqlite.gz'))[:-7]: old.unlink()
retained = set()
for manifest in directory.glob('hub-*.manifest.json'):
    retained.update(json.loads(manifest.read_text())['objects'])
for old in object_backup.iterdir():
    if len(old.name) == 64 and old.name not in retained: old.unlink()
print('Consistent database and shared-object backup saved; integrity verified; local copy only')
