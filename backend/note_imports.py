"""Read-only, explicitly prepared study bundles; never an arbitrary file browser."""

import json
import re
from pathlib import Path


MAX_BODY_BYTES = 20 * 1024 * 1024
MAX_BUNDLE_BYTES = 24 * 1024 * 1024
RESERVED_NAMES = {"raw", "original", "originals", "eval", "evaluation", "evaluations", "评估", "原始", "原文"}


class NoteImportNotFound(Exception):
    pass


class NoteImportUnavailable(Exception):
    pass


def valid_import_id(import_id: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", import_id)) and import_id.lower() not in RESERVED_NAMES


def text(value, maximum: int) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum


def reject_non_json_number(_value):
    raise ValueError("Non-JSON numeric value")


def validate_bundle(bundle, import_id: str):
    if not isinstance(bundle, dict) or bundle.get("id") != import_id or not text(bundle.get("title"), 240):
        raise NoteImportUnavailable
    source_hash = bundle.get("source_sha256")
    if not isinstance(source_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", source_hash):
        raise NoteImportUnavailable
    space = bundle.get("space")
    if not isinstance(space, dict) or not text(space.get("id"), 128) or not text(space.get("name"), 120):
        raise NoteImportUnavailable
    if (space.get("icon") not in {"code", "sparkles", "printer", "game"}
            or not isinstance(space.get("description"), str) or len(space["description"]) > 1000
            or not isinstance(space.get("color"), str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", space["color"])):
        raise NoteImportUnavailable
    docs = bundle.get("documents")
    if not isinstance(docs, list) or not 1 <= len(docs) <= 500:
        raise NoteImportUnavailable
    if not isinstance(bundle.get("summary"), dict) or not isinstance(bundle.get("excluded"), list):
        raise NoteImportUnavailable
    if any(not isinstance(item, str) for item in bundle["excluded"]):
        raise NoteImportUnavailable
    summary_count = bundle["summary"].get("count")
    if summary_count is not None and (type(summary_count) is not int or summary_count != len(docs)):
        raise NoteImportUnavailable
    ids = set()
    total = 0
    for doc in docs:
        if not isinstance(doc, dict) or not text(doc.get("id"), 128) or doc["id"] in ids:
            raise NoteImportUnavailable
        ids.add(doc["id"])
        if (doc.get("spaceId") != space["id"] or not text(doc.get("title"), 240)
                or not text(doc.get("fileName"), 500) or doc.get("type") != "md"
                or type(doc.get("version")) is not int or doc["version"] != 1
                or doc.get("status") != "available" or doc.get("isDemo") is not False
                or not isinstance(doc.get("body"), str) or "\x00" in doc["body"]
                or not isinstance(doc.get("heading"), str) or len(doc["heading"]) > 500
                or not text(doc.get("updatedAt"), 80)
                or type(doc.get("size")) is not int or not 0 <= doc["size"] <= MAX_BODY_BYTES
                or doc.get("importBatchId") != import_id):
            raise NoteImportUnavailable
        total += len(doc["body"].encode("utf-8"))
        if total > MAX_BODY_BYTES:
            raise NoteImportUnavailable


class NoteImportCatalog:
    def __init__(self, data_dir: Path):
        # Keep the intended imports directory lexical after resolving the configured
        # data root, so a junction/symlink cannot redefine the permitted boundary.
        self.root = data_dir.resolve() / "imports"

    def _path(self, import_id: str) -> Path:
        if not valid_import_id(import_id):
            raise NoteImportNotFound
        try:
            path = (self.root / import_id / "bundle.json").resolve()
            if not path.is_relative_to(self.root):
                raise NoteImportNotFound
            return path
        except (OSError, RuntimeError):
            raise NoteImportUnavailable from None

    def get(self, import_id: str) -> dict:
        path = self._path(import_id)
        try:
            with path.open("rb") as source:
                encoded = source.read(MAX_BUNDLE_BYTES + 1)
            if len(encoded) > MAX_BUNDLE_BYTES:
                raise NoteImportUnavailable
            bundle = json.loads(encoded.decode("utf-8-sig"), parse_constant=reject_non_json_number)
            validate_bundle(bundle, import_id)
            return bundle
        except FileNotFoundError:
            raise NoteImportNotFound from None
        except (OSError, ValueError, UnicodeError, RecursionError):
            raise NoteImportUnavailable from None

    def list(self) -> list[dict]:
        try:
            if not self.root.exists():
                return []
            if self.root.resolve() != self.root:
                raise NoteImportUnavailable
            candidates = sorted(self.root.iterdir(), key=lambda path: path.name)
        except (OSError, RuntimeError):
            raise NoteImportUnavailable from None
        result = []
        for candidate in candidates:
            if not valid_import_id(candidate.name) or not candidate.is_dir():
                continue
            try:
                bundle = self.get(candidate.name)
            except NoteImportNotFound:
                continue
            result.append({"id": bundle["id"], "title": bundle["title"], "count": len(bundle["documents"]),
                           "source_sha256": bundle["source_sha256"]})
        return result
