"""Durable, versioned local text index. Keyword retrieval, not vector search.

The browser explicitly submits a saved document snapshot. Each successful write
stores an immutable UTF-8 copy and a complete set of indexed chunks before making
that version active. Reads use one SQLite snapshot, including version checks.
"""

import hashlib
import os
import re
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .context import heading_boundaries, query_terms
from .schemas import Citation, MAX_FILE_BYTES


# A lexical relevance gate, not a probability/confidence score. Ordinary question
# particles must not make an unrelated topic look supported. Keep technical nouns
# (e.g. 循环, 连接, 事务) even when they appear in more than one subject.
MIN_QUERY_TERM_COVERAGE = 0.35
_QUESTION_PHRASES = re.compile(
    "请帮我|请问|请你|帮我|告诉我|解释一下|介绍一下|请说明|说明一下|分别|"
    "有什么|是什么|什么是|为什么|为何|如何|怎样|怎么|哪些|哪一个|哪个|"
    "哪一年|在哪|有何|是否|能否|应该|进行|什么|[的与和及吗呢]"
)


def _retrieval_terms(question: str) -> set[str]:
    # Replacing with a boundary avoids inventing new bigrams between adjacent
    # words. Long questions keep a bounded set; this remains keyword retrieval.
    cleaned = _QUESTION_PHRASES.sub(" ", question)
    return set(sorted(query_terms(cleaned))[:128])


class LibraryError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class LibraryConflict(LibraryError):
    def __init__(self, message="本机资料版本与当前页面不一致，请重新保存当前版本后重试。"):
        super().__init__(409, message)


class LibraryNotFound(LibraryError):
    def __init__(self):
        super().__init__(404, "本机没有这份可用资料。")


def _identifier(value, name="资料标识") -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise LibraryError(422, f"{name}无效。")
    return value


def _line(value, name: str, max_length: int) -> str:
    if (not isinstance(value, str) or not value.strip() or len(value) > max_length
            or any(ord(char) < 32 for char in value)):
        raise LibraryError(422, f"{name}无效。")
    return value.strip()


def _version(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 2**31 - 1:
        raise LibraryError(422, "资料版本无效。")
    return value


def _tokens(text: str) -> str:
    """Pre-tokenize Chinese bigrams so SQLite also indexes Chinese phrases.

    Unlike a substring scan, latin terms remain exact tokens. Repeated terms are
    retained for ranking. No models are downloaded and no text leaves the host.
    """
    result = re.findall(r"[a-z0-9_]{2,}", text.lower())
    for word in re.findall(r"[\u4e00-\u9fff]+", text):
        result.extend(word[index:index + 2] for index in range(len(word) - 1))
    return " ".join(result)


def _chunks(document: dict) -> list[dict]:
    body = document["body"]
    boundaries = heading_boundaries(body)
    if not boundaries or boundaries[0][0] > 0:
        boundaries.insert(0, (0, "文档正文"))
    chunks = []
    for index, (start, heading) in enumerate(boundaries):
        section_end = boundaries[index + 1][0] if index + 1 < len(boundaries) else len(body)
        while start < section_end:
            end = min(start + 1600, section_end)
            if end < section_end:
                newline = body.rfind("\n", start + 800, end)
                if newline >= 0:
                    end = newline + 1
            excerpt = body[start:end]
            if excerpt.strip():
                fingerprint = hashlib.sha256(
                    f'{document["id"]}\0{document["version"]}\0{start}\0{excerpt}'.encode("utf-8")
                ).hexdigest()
                chunks.append({"id": fingerprint, "offset": start, "excerpt": excerpt,
                               "heading": f"{heading}（第 {start + 1}–{end} 字符）",
                               "tokens": _tokens(excerpt)})
            start = end
    return chunks


class LibraryStore:
    def __init__(self, data_dir: Path):
        self.directory = Path(data_dir).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "library.sqlite3"
        if not self.path.resolve().is_relative_to(self.directory):
            raise LibraryError(503, "本机资料数据库路径无效。")
        self.uploads = self.directory / "uploads"
        self.uploads.mkdir(exist_ok=True)
        self._inside_uploads(self.uploads)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS spaces (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id),
                    active_version INTEGER NOT NULL, deleted_at TEXT
                );
                CREATE TABLE IF NOT EXISTS retired_documents (
                    id TEXT PRIMARY KEY, retired_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS document_versions (
                    document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL,
                    title TEXT NOT NULL, file_name TEXT NOT NULL, type TEXT NOT NULL,
                    body TEXT NOT NULL, content_hash TEXT NOT NULL, size INTEGER NOT NULL,
                    original_path TEXT NOT NULL, chunk_count INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (document_id, version)
                );
                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, version INTEGER NOT NULL,
                    offset INTEGER NOT NULL, heading TEXT NOT NULL, excerpt TEXT NOT NULL,
                    FOREIGN KEY (document_id, version)
                        REFERENCES document_versions(document_id, version)
                );
                CREATE INDEX IF NOT EXISTS chunks_document_version
                    ON chunks(document_id, version);
                CREATE INDEX IF NOT EXISTS documents_space ON documents(space_id, deleted_at);
                CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(
                    chunk_id UNINDEXED, title_tokens, body_tokens,
                    tokenize='unicode61 remove_diacritics 0'
                );
            """)

    @contextmanager
    def connect(self, *, write=False, snapshot=False):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=15000")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            elif snapshot:
                db.execute("BEGIN")
            with db:
                yield db
        finally:
            db.close()

    def _inside_uploads(self, path: Path) -> Path:
        resolved = path.resolve()
        root = self.uploads.resolve()
        if not root.is_relative_to(self.directory) or not resolved.is_relative_to(root):
            raise LibraryError(503, "本机原文存储路径无效。")
        return resolved

    def _write_original(self, document: dict, raw: bytes, content_hash: str) -> str:
        # IDs and original names never become path components.
        folder = self.uploads / hashlib.sha256(document["id"].encode()).hexdigest()
        folder.mkdir(exist_ok=True)
        self._inside_uploads(folder)
        path = self._inside_uploads(folder / f'{document["version"]}-{content_hash}.{document["type"]}')
        if path.exists():
            if hashlib.sha256(path.read_bytes()).hexdigest() != content_hash:
                raise LibraryError(503, "本机原文副本校验失败，请检查数据目录。")
            return path.relative_to(self.directory).as_posix()
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=folder, prefix=".pending-", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            # link() never overwrites an existing immutable original.
            try:
                os.link(temporary, path)
            except FileExistsError:
                if hashlib.sha256(path.read_bytes()).hexdigest() != content_hash:
                    raise LibraryError(503, "本机原文副本校验失败，请检查数据目录。")
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return path.relative_to(self.directory).as_posix()

    @staticmethod
    def _validate_document(document: dict) -> tuple[dict, bytes]:
        required = {"id", "space_id", "space_name", "title", "body", "version", "file_name", "type"}
        if not isinstance(document, dict) or set(document) != required:
            raise LibraryError(422, "资料字段不完整或包含不支持的字段。")
        document = dict(document)
        document["id"] = _identifier(document["id"])
        document["space_id"] = _identifier(document["space_id"], "空间标识")
        document["space_name"] = _line(document["space_name"], "空间名称", 120)
        document["title"] = _line(document["title"], "资料标题", 240)
        document["file_name"] = _line(document["file_name"], "文件名", 240)
        document["version"] = _version(document["version"])
        if not isinstance(document["type"], str) or document["type"] not in {"md", "txt"}:
            raise LibraryError(422, "只支持 Markdown 和 UTF-8 TXT 资料。")
        file_name = document["file_name"]
        if (any(char in file_name for char in '<>:"/\\|?*') or file_name.endswith((".", " "))
                or not file_name.lower().endswith("." + document["type"])):
            raise LibraryError(422, "文件名或资料类型不匹配。")
        body = document["body"]
        if not isinstance(body, str) or "\x00" in body:
            raise LibraryError(422, "资料正文必须为有效 UTF-8 文本。")
        try:
            raw = body.encode("utf-8")
        except UnicodeError:
            raise LibraryError(422, "资料正文必须为有效 UTF-8 文本。") from None
        if len(raw) > MAX_FILE_BYTES:
            raise LibraryError(413, "单份资料超过 20 MiB。")
        if not body.strip():
            raise LibraryError(422, "资料正文为空，无法建立索引。")
        return document, raw

    @staticmethod
    def _summary(row) -> dict:
        return {key: row[key] for key in ("id", "space_id", "space_name", "title", "file_name", "type",
                                          "version", "content_hash", "size", "chunk_count", "updated_at")} | {
            "status": "indexed"
        }

    _SELECT = """SELECT d.id, d.space_id, s.name AS space_name, v.* FROM documents d
                 JOIN spaces s ON s.id=d.space_id
                 JOIN document_versions v ON v.document_id=d.id AND v.version=d.active_version
                 WHERE d.deleted_at IS NULL"""

    def upsert_document(self, document: dict) -> dict:
        document, raw = self._validate_document(document)
        content_hash = hashlib.sha256(raw).hexdigest()
        # Build everything before acquiring the writer lock. Readers retain the old version.
        chunks = _chunks(document)
        title_tokens = _tokens(document["title"])
        try:
            with self.connect(write=True) as db:
                if db.execute("SELECT 1 FROM retired_documents WHERE id=?", (document["id"],)).fetchone():
                    raise LibraryConflict("这份资料已从本机索引移除，不能复用其标识。")
                existing = db.execute("SELECT * FROM documents WHERE id=?", (document["id"],)).fetchone()
                if existing:
                    if existing["deleted_at"] is not None:
                        raise LibraryConflict("这份资料已从本机索引移除，不能复用其标识。")
                    if existing["space_id"] != document["space_id"]:
                        raise LibraryConflict("资料所属空间不一致，不能覆盖其他空间的资料。")
                    if document["version"] < existing["active_version"]:
                        raise LibraryConflict()
                    if document["version"] == existing["active_version"]:
                        current = db.execute(self._SELECT + " AND d.id=?", (document["id"],)).fetchone()
                        if (current["content_hash"] != content_hash or any(
                                current[key] != document[key] for key in ("title", "file_name", "type"))):
                            raise LibraryConflict("相同版本的资料内容不同，已保留本机现有版本。")
                        self._write_original(document, raw, content_hash)
                        db.execute("UPDATE spaces SET name=? WHERE id=?",
                                   (document["space_name"], document["space_id"]))
                        result = self._summary(current)
                        result["space_name"] = document["space_name"]
                        return result
                original_path = self._write_original(document, raw, content_hash)
                now = datetime.now(timezone.utc).isoformat()
                db.execute("INSERT INTO spaces VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                           (document["space_id"], document["space_name"]))
                if not existing:
                    db.execute("INSERT INTO documents(id,space_id,active_version) VALUES (?,?,?)",
                               (document["id"], document["space_id"], document["version"]))
                db.execute("""INSERT INTO document_versions
                    (document_id,version,title,file_name,type,body,content_hash,size,original_path,chunk_count,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                           (document["id"], document["version"], document["title"], document["file_name"],
                            document["type"], document["body"], content_hash, len(raw), original_path, len(chunks), now))
                db.executemany("INSERT INTO chunks VALUES (?,?,?,?,?,?)",
                               [(item["id"], document["id"], document["version"], item["offset"],
                                 item["heading"], item["excerpt"]) for item in chunks])
                db.executemany("INSERT INTO chunk_search(chunk_id,title_tokens,body_tokens) VALUES (?,?,?)",
                               [(item["id"], title_tokens, item["tokens"]) for item in chunks])
                db.execute("UPDATE documents SET active_version=? WHERE id=?",
                           (document["version"], document["id"]))
                return self._summary(db.execute(self._SELECT + " AND d.id=?", (document["id"],)).fetchone())
        except OSError:
            raise LibraryError(503, "本机原文无法写入，请检查数据目录和剩余空间后重试。") from None

    def get_document(self, document_id: str) -> dict:
        _identifier(document_id)
        with self.connect() as db:
            row = db.execute(self._SELECT + " AND d.id=?", (document_id,)).fetchone()
            if row is None:
                raise LibraryNotFound()
            return self._summary(row) | {"body": row["body"]}

    def list_documents(self) -> list[dict]:
        with self.connect() as db:
            return [self._summary(row) for row in db.execute(self._SELECT + " ORDER BY v.updated_at DESC,d.id")]

    def delete_document(self, document_id: str, expected_version: int) -> dict:
        _identifier(document_id)
        _version(expected_version)
        with self.connect(write=True) as db:
            current = db.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
            if current is None:
                raise LibraryNotFound()
            if current["active_version"] != expected_version:
                raise LibraryConflict()
            if current["deleted_at"] is None:
                db.execute("UPDATE documents SET deleted_at=? WHERE id=?",
                           (datetime.now(timezone.utc).isoformat(), document_id))
            db.execute("INSERT OR IGNORE INTO retired_documents VALUES (?,?)",
                       (document_id, datetime.now(timezone.utc).isoformat()))
            # Removing retrieval access is distinct from permanently purging originals.
            return {"id": document_id, "deleted": True, "retrievable": False, "purge_pending": True}

    def retire_documents(self, ids: list[str]) -> dict:
        """Persist deletion intent even when an upload has not reached this store yet."""
        if not isinstance(ids, list) or len(ids) > 500:
            raise LibraryError(422, "待移除的资料范围无效。")
        ids = list(dict.fromkeys(_identifier(identity) for identity in ids))
        with self.connect(write=True) as db:
            now = datetime.now(timezone.utc).isoformat()
            db.executemany("INSERT OR IGNORE INTO retired_documents VALUES (?,?)",
                           [(identity, now) for identity in ids])
            db.executemany("UPDATE documents SET deleted_at=COALESCE(deleted_at,?) WHERE id=?",
                           [(now, identity) for identity in ids])
            return {"retired": len(ids), "retrievable": False, "purge_pending": True}

    def status(self) -> dict:
        with self.connect(snapshot=True) as db:
            documents = db.execute("SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL").fetchone()[0]
            chunks = db.execute("""SELECT COUNT(*) FROM chunks c JOIN documents d ON d.id=c.document_id
                WHERE d.deleted_at IS NULL AND d.active_version=c.version""").fetchone()[0]
            spaces = db.execute("SELECT COUNT(DISTINCT space_id) FROM documents WHERE deleted_at IS NULL").fetchone()[0]
            deleted = db.execute("""SELECT COUNT(*) FROM (
                SELECT id FROM retired_documents UNION SELECT id FROM documents WHERE deleted_at IS NOT NULL
            )""").fetchone()[0]
            return {"documents": documents, "chunks": chunks, "spaces": spaces,
                    "deleted_documents": deleted, "mode": "keyword-index"}

    def search(self, scope_ids: list[str], question: str, document_id: str | None = None,
               limit: int = 8, char_budget: int = 12000,
               required_versions: dict[str, int] | None = None) -> list[Citation]:
        if not isinstance(scope_ids, list) or not 1 <= len(scope_ids) <= 100:
            raise LibraryError(422, "请选择有效的资料空间。")
        scope_ids = list(dict.fromkeys(_identifier(value, "空间标识") for value in scope_ids))
        if document_id is not None:
            _identifier(document_id)
        if not isinstance(question, str) or not question.strip() or len(question) > 4000:
            raise LibraryError(422, "请填写不超过 4000 字符的问题。")
        if (isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100
                or isinstance(char_budget, bool) or not isinstance(char_budget, int)
                or not 1 <= char_budget <= 120000):
            raise LibraryError(422, "检索数量或上下文长度无效。")
        if required_versions is not None:
            if not isinstance(required_versions, dict) or len(required_versions) > 500:
                raise LibraryError(422, "资料版本范围无效。")
            for identity, version in required_versions.items():
                _identifier(identity)
                _version(version)
        with self.connect(snapshot=True) as db:
            if required_versions is not None:
                if not required_versions:
                    return []
                # Validate under this same read transaction, before running retrieval.
                for identity, version in required_versions.items():
                    row = db.execute("SELECT * FROM documents WHERE id=?", (identity,)).fetchone()
                    if (row is None or row["deleted_at"] is not None or row["active_version"] != version
                            or row["space_id"] not in scope_ids
                            or (document_id is not None and identity != document_id)):
                        raise LibraryConflict()
            terms = _retrieval_terms(question)
            if not terms:
                return []
            expression = " OR ".join(f'"{term}"' for term in sorted(terms))
            clauses = ["chunk_search MATCH ?", "d.deleted_at IS NULL", "d.active_version=c.version",
                       f"d.space_id IN ({','.join('?' for _ in scope_ids)})"]
            arguments = [expression, *scope_ids]
            if document_id is not None:
                clauses.append("d.id=?")
                arguments.append(document_id)
            if required_versions is not None:
                clauses.append(f"d.id IN ({','.join('?' for _ in required_versions)})")
                arguments.extend(required_versions)
            rows = db.execute("""SELECT c.*,v.title,chunk_search.title_tokens,chunk_search.body_tokens,
                bm25(chunk_search,0,3,1) AS rank
                FROM chunk_search JOIN chunks c ON c.id=chunk_search.chunk_id
                JOIN documents d ON d.id=c.document_id
                JOIN document_versions v ON v.document_id=c.document_id AND v.version=c.version
                WHERE """ + " AND ".join(clauses) + " ORDER BY rank,c.document_id,c.offset LIMIT ?",
                              [*arguments, max(128, limit * 4)]).fetchall()
            selected = []
            remaining = char_budget
            for row in rows:
                indexed_terms = set((row["title_tokens"] + " " + row["body_tokens"]).split())
                coverage = len(terms & indexed_terms) / len(terms)
                if coverage < MIN_QUERY_TERM_COVERAGE:
                    continue
                if len(row["excerpt"]) > remaining:
                    continue
                selected.append(Citation(id=row["id"], documentId=row["document_id"], version=row["version"],
                                         title=row["title"], heading=row["heading"], excerpt=row["excerpt"]))
                remaining -= len(row["excerpt"])
                if len(selected) == limit:
                    break
            return selected
