"""SQLite settings with user-bound Windows DPAPI; keys never leave this module."""

import ctypes
import os
import sqlite3
from contextlib import contextmanager
from ctypes import wintypes
from pathlib import Path

from .schemas import ProviderInput, ProviderSummary


class SecretStorageError(Exception):
    pass


class DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


class WindowsSecretProtector:
    """DPAPI encrypts for the current Windows account, without storing a master key."""

    def _transform(self, data: bytes, decrypt: bool) -> bytes:
        if os.name != "nt":
            raise SecretStorageError("本版本的密钥持久化需要 Windows DPAPI，未保存明文密钥。")
        source_buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
        source = DataBlob(len(data), source_buffer)
        result = DataBlob()
        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        if decrypt:
            transform = crypt32.CryptUnprotectData
            transform.argtypes = [ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                                  ctypes.POINTER(DataBlob)]
            ok = transform(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
        else:
            transform = crypt32.CryptProtectData
            transform.argtypes = [ctypes.POINTER(DataBlob), wintypes.LPCWSTR, ctypes.c_void_p,
                                  ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                                  ctypes.POINTER(DataBlob)]
            ok = transform(ctypes.byref(source), "LoreDock API credential", None, None, None,
                           1, ctypes.byref(result))
        if not ok:
            raise SecretStorageError("Windows 无法处理此密钥，请使用保存时的 Windows 账户。")
        try:
            return ctypes.string_at(result.pbData, result.cbData)
        finally:
            kernel32.LocalFree(ctypes.cast(result.pbData, ctypes.c_void_p))

    def protect(self, key: str) -> bytes:
        return self._transform(key.encode("utf-8"), False)

    def reveal(self, ciphertext: bytes) -> str:
        return self._transform(ciphertext, True).decode("utf-8")


class ProviderStore:
    def __init__(self, data_dir: Path, protector=None):
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "settings.sqlite3"
        self.protector = protector or WindowsSecretProtector()
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS providers (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
                default_model TEXT NOT NULL, encrypted_key BLOB NOT NULL DEFAULT X'')""")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def summary(row) -> ProviderSummary:
        return ProviderSummary(id=row["id"], name=row["name"], base_url=row["base_url"],
                               default_model=row["default_model"], has_api_key=bool(row["encrypted_key"]),
                               key_hint="••••••••" if row["encrypted_key"] else "")

    def list(self) -> list[ProviderSummary]:
        with self.connect() as db:
            return [self.summary(row) for row in db.execute("SELECT * FROM providers ORDER BY rowid")]

    def get(self, provider_id: str):
        with self.connect() as db:
            return db.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone()

    def save(self, provider_id: str, config: ProviderInput) -> ProviderSummary:
        with self.connect() as db:
            existing = db.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone()
            encrypted_key = existing["encrypted_key"] if existing else b""
            # Changing the destination must not silently forward an existing secret to a new host.
            if existing and existing["base_url"] != config.base_url and not config.api_key:
                encrypted_key = b""
            if config.clear_api_key:
                encrypted_key = b""
            elif config.api_key:
                encrypted_key = self.protector.protect(config.api_key)
            db.execute("""INSERT INTO providers VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url,
                default_model=excluded.default_model, encrypted_key=excluded.encrypted_key""",
                       (provider_id, config.name, config.base_url, config.default_model, encrypted_key))
            return self.summary(db.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone())

    def delete(self, provider_id: str) -> bool:
        with self.connect() as db:
            return bool(db.execute("DELETE FROM providers WHERE id = ?", (provider_id,)).rowcount)

    def credential(self, row) -> str:
        return self.protector.reveal(row["encrypted_key"]) if row["encrypted_key"] else ""
