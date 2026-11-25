"""One-time local backend migration. Never overwrite an existing desktop data directory."""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def migrate(source: Path, destination: Path):
    source, destination = source.resolve(), destination.resolve()
    if not source.is_dir() or destination == source or source in destination.parents:
        raise ValueError('Source must exist; destination must be outside it.')
    if destination.exists():
        raise FileExistsError('Desktop data already exists; it was not overwritten.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    staging = destination.with_name(destination.name + '.migration-' + stamp)
    staging.mkdir()
    files, databases = [], []
    for name in ('settings.sqlite3', 'library.sqlite3'):
        original = source / name
        if not original.is_file():
            continue
        # SQLite backup includes committed WAL pages without touching the source.
        with closing(sqlite3.connect(original.as_uri() + '?mode=ro', uri=True)) as old:
            with closing(sqlite3.connect(staging / name)) as new:
                old.backup(new)
                if new.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('SQLite integrity check failed: ' + name)
        databases.append(name)
    for directory in ('uploads', 'imports'):
        original = source / directory
        if not original.is_dir():
            continue
        for item in original.rglob('*'):
            if item.is_symlink() or not item.resolve().is_relative_to(source):
                raise ValueError('Migration does not follow external links.')
            if not item.is_file():
                continue
            relative = item.relative_to(source)
            copied = staging / relative
            copied.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, copied)
            checksum = digest(item)
            if checksum != digest(copied):
                raise RuntimeError('Copied file changed during migration: ' + str(relative))
            files.append({'path': relative.as_posix(), 'sha256': checksum})
    report = {'createdAt': stamp, 'databases': databases, 'verifiedFiles': files,
              'note': 'Original files retained. DPAPI keys remain bound to the same Windows account.'}
    (staging / 'migration.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    # Rename publishes the complete copy; a second attempt never merges or replaces it.
    if destination.exists():
        raise FileExistsError('Destination appeared during migration; staging copy retained.')
    staging.rename(destination)
    return {'destination': str(destination), 'databases': len(databases), 'verifiedFiles': len(files)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1] / 'data')
    parser.add_argument('--destination', type=Path, default=Path(os.environ['APPDATA']) / 'LoreDock' / 'data')
    options = parser.parse_args()
    print(json.dumps(migrate(options.source, options.destination), ensure_ascii=False))
