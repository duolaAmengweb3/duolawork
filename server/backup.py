#!/usr/bin/env python3
"""Consistent local SQLite snapshot; not a substitute for off-machine backups."""
import datetime
import gzip
import json
import os
import pathlib
import shutil
import sqlite3
import tempfile

os.umask(0o077)
config = json.loads(pathlib.Path(os.environ['HUB_SERVER_CONFIG']).read_text())
database = pathlib.Path(config['database'])
directory = database.parent / 'backups'
directory.mkdir(mode=0o700, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
with tempfile.TemporaryDirectory(dir=directory) as work:
    snapshot = pathlib.Path(work) / 'snapshot.sqlite'
    source = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    destination = sqlite3.connect(snapshot)
    source.backup(destination)
    assert destination.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    destination.close()
    source.close()
    compressed = pathlib.Path(work) / 'snapshot.sqlite.gz'
    with snapshot.open('rb') as src, gzip.open(compressed, 'wb') as dst:
        shutil.copyfileobj(src, dst)
    with compressed.open('rb') as done:
        os.fsync(done.fileno())
    os.replace(compressed, directory / ('hub-' + stamp + '.sqlite.gz'))
for old in sorted(directory.glob('hub-*.sqlite.gz'))[:-7]:
    old.unlink()
print('Consistent local backup saved; integrity verified')
