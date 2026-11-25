import os
import secrets
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from tools.migrate_desktop_data import migrate


def test_migration_backs_up_wal_and_preserves_originals(tmp_path):
    source, target = tmp_path / 'source', tmp_path / 'target'
    source.mkdir()
    with sqlite3.connect(source / 'library.sqlite3') as connection:
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('CREATE TABLE notes(body TEXT)')
        connection.execute('INSERT INTO notes VALUES (?)', ('完整正文😀',))
        connection.commit()
        (source / 'uploads').mkdir()
        (source / 'uploads' / 'note.md').write_text('immutable original', encoding='utf-8')
        result = migrate(source, target)
        assert result['verifiedFiles'] == 1
        with sqlite3.connect(target / 'library.sqlite3') as restored:
            assert restored.execute('SELECT body FROM notes').fetchone()[0] == '完整正文😀'
        assert connection.execute('SELECT count(*) FROM notes').fetchone()[0] == 1
        assert (target / 'uploads' / 'note.md').read_bytes() == (source / 'uploads' / 'note.md').read_bytes()
        with pytest.raises(FileExistsError):
            migrate(source, target)


def test_private_backend_requires_token_and_exits_when_parent_closes(tmp_path):
    token = secrets.token_hex(32)
    environment = {**os.environ, 'LOREDOCK_DATA_DIR': str(tmp_path), 'LOREDOCK_DESKTOP_TOKEN': token}
    process = subprocess.Popen([sys.executable, '-m', 'backend.desktop_entry'], cwd=Path(__file__).resolve().parents[2], env=environment,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = process.stdout.readline().strip()
        assert line.startswith('LOREDOCK_PORT=')
        url = 'http://127.0.0.1:' + line.split('=', 1)[1] + '/api/health'
        deadline = time.monotonic() + 15
        while True:
            try:
                response = httpx.get(url, headers={'x-loredock-desktop': token}, timeout=1)
                break
            except httpx.ConnectError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(.1)
        assert response.status_code == 200
        assert response.json()['status'] == 'ok'
        assert httpx.get(url).status_code == 403
        assert httpx.get(url, headers={'x-loredock-desktop': 'invalid'}).status_code == 403
        process.stdin.close()
        assert process.wait(timeout=10) == 0
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)
