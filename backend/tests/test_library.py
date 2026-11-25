import hashlib
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest

from backend.library import LibraryConflict, LibraryError, LibraryNotFound, LibraryStore
from backend.schemas import MAX_FILE_BYTES


def document(**changes):
    return {"id": "note-1", "space_id": "python", "space_name": "Python 学习",
            "title": "Python 文件", "body": "# Python 文件\n\n## JSON 文件\n使用 json.load 读取文件。\n",
            "version": 1, "file_name": "note.md", "type": "md"} | changes


def test_document_is_durable_and_original_is_immutable(tmp_path):
    store = LibraryStore(tmp_path)
    source = document()
    summary = store.upsert_document(source)
    assert summary["status"] == "indexed"
    assert summary["content_hash"] == hashlib.sha256(source["body"].encode()).hexdigest()
    original = next((tmp_path / "uploads").glob("*/*.md"))
    assert original.read_bytes() == source["body"].encode()
    reopened = LibraryStore(tmp_path)
    assert reopened.get_document(source["id"])["body"] == source["body"]
    assert reopened.list_documents() == [summary]
    assert reopened.status() == {"documents": 1, "chunks": 2, "spaces": 1,
                                 "deleted_documents": 0, "mode": "keyword-index"}
    assert "body" not in summary and "original_path" not in summary


def test_three_identical_retries_do_not_duplicate_index(tmp_path):
    store = LibraryStore(tmp_path)
    first = store.upsert_document(document())
    for _ in range(3):
        assert store.upsert_document(document()) == first
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == first["chunk_count"]
        assert db.execute("SELECT COUNT(*) FROM chunk_search").fetchone()[0] == first["chunk_count"]
    assert len(list((tmp_path / "uploads").glob("*/*.md"))) == 1


def test_update_atomically_changes_effective_chunks_and_keeps_old_version(tmp_path):
    store = LibraryStore(tmp_path)
    store.upsert_document(document(body="# 原文\nobsoletealpha 数据库事务说明。"))
    old = store.search(["python"], "obsoletealpha")[0]
    store.upsert_document(document(version=2, body="# 新文\nfreshbeta 文件读取说明。"))
    assert store.search(["python"], "obsoletealpha") == []
    current = store.search(["python"], "freshbeta")
    assert len(current) == 1 and current[0].version == 2
    assert current[0].id != old.id
    assert old.excerpt == "# 原文\nobsoletealpha 数据库事务说明。"
    assert store.get_document("note-1")["version"] == 2
    assert len(list((tmp_path / "uploads").glob("*/*.md"))) == 2
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0] == 2


@pytest.mark.parametrize("change", [
    {"body": "另一份内容"}, {"title": "另一标题"}, {"file_name": "other.md"},
    {"space_id": "secret"}, {"version": 1},
])
def test_conflicts_do_not_overwrite_or_move_documents(tmp_path, change):
    store = LibraryStore(tmp_path)
    original = document(version=2)
    store.upsert_document(original)
    with pytest.raises(LibraryConflict) as error:
        store.upsert_document(original | change)
    assert error.value.status == 409
    assert store.get_document("note-1")["body"] == original["body"]
    assert store.get_document("note-1")["space_id"] == "python"


def test_write_failure_and_failed_sql_keep_current_version(tmp_path, monkeypatch):
    store = LibraryStore(tmp_path)
    store.upsert_document(document())
    original_writer = store._write_original

    def fail_write(*_args):
        raise OSError("private path must not be disclosed")

    monkeypatch.setattr(store, "_write_original", fail_write)
    with pytest.raises(LibraryError) as error:
        store.upsert_document(document(version=2, body="新的数据库事务内容"))
    assert error.value.status == 503 and "private" not in str(error.value)
    assert store.get_document("note-1")["version"] == 1
    monkeypatch.setattr(store, "_write_original", original_writer)
    with store.connect() as db:
        db.execute("""CREATE TRIGGER reject_new_chunks BEFORE INSERT ON chunks
            WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT, 'failure'); END""")
    for _ in range(3):
        with pytest.raises(sqlite3.IntegrityError):
            store.upsert_document(document(version=2, body="新的数据库事务内容"))
    assert store.get_document("note-1")["version"] == 1
    assert store.search(["python"], "load")[0].version == 1
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0] == 1
        db.execute("DROP TRIGGER reject_new_chunks")
    assert store.upsert_document(document(version=2, body="新的数据库事务内容"))["version"] == 2


def test_search_enforces_space_document_and_current_versions(tmp_path):
    store = LibraryStore(tmp_path)
    store.upsert_document(document())
    store.upsert_document(document(id="secret-doc", space_id="secret", space_name="私有空间",
                                   body="# JSON\njson.load secret 内容"))
    assert {item.documentId for item in store.search(["python"], "json")} == {"note-1"}
    assert store.search(["python"], "json", document_id="secret-doc") == []
    assert store.search(["nonexistent"], "json") == []
    assert store.search(["python"], "不存在的无关术语xyzzzy") == []
    assert store.search(["python"], "读取文件")
    assert store.search(["python"], "LOAD")
    assert store.search(["python"], "json", required_versions={}) == []
    assert store.search(["python"], "json", required_versions={"note-1": 1})
    assert {item.documentId for item in store.search(
        ["python", "secret"], "json", required_versions={"note-1": 1})} == {"note-1"}
    for versions, scope, selected in [
        ({"unknown": 1}, ["python"], None),
        ({"note-1": 2}, ["python"], None),
        ({"secret-doc": 1}, ["python"], None),
        ({"note-1": 1, "secret-doc": 1}, ["python", "secret"], "note-1"),
    ]:
        with pytest.raises(LibraryConflict):
            store.search(scope, "json", document_id=selected, required_versions=versions)


def test_tombstone_excludes_all_versions_and_cannot_be_reused(tmp_path):
    store = LibraryStore(tmp_path)
    store.upsert_document(document())
    with pytest.raises(LibraryConflict):
        store.delete_document("note-1", 2)
    assert store.search(["python"], "json")
    result = store.delete_document("note-1", 1)
    assert result == {"id": "note-1", "deleted": True, "retrievable": False, "purge_pending": True}
    assert store.delete_document("note-1", 1) == result
    assert store.search(["python"], "json") == []
    assert store.list_documents() == []
    with pytest.raises(LibraryNotFound):
        store.get_document("note-1")
    with pytest.raises(LibraryConflict):
        store.search(["python"], "json", required_versions={"note-1": 1})
    with pytest.raises(LibraryConflict):
        LibraryStore(tmp_path).upsert_document(document(version=2))
    assert store.status()["deleted_documents"] == 1


def test_retire_unknown_ids_blocks_late_uploads_and_is_atomic(tmp_path):
    store = LibraryStore(tmp_path)
    store.upsert_document(document())
    with pytest.raises(LibraryError):
        store.retire_documents(["note-1", "../bad"])
    assert store.search(["python"], "json")
    result = store.retire_documents(["note-1", "late-doc", "late-doc"])
    assert result == {"retired": 2, "retrievable": False, "purge_pending": True}
    assert store.retire_documents(["note-1", "late-doc"]) == result
    reopened = LibraryStore(tmp_path)
    for identity in ("note-1", "late-doc"):
        with pytest.raises(LibraryConflict):
            reopened.upsert_document(document(id=identity, version=3))
    assert reopened.status()["deleted_documents"] == 2


def test_markdown_heading_paths_ignore_code_and_chunks_preserve_text(tmp_path):
    body = "intro\n# 总标题\n## JSON读写\n```python\n# 假标题\nx = 1\n```\n" + "jsonload段落。\n" * 350
    store = LibraryStore(tmp_path)
    summary = store.upsert_document(document(body=body))
    with store.connect() as db:
        chunks = list(db.execute("SELECT * FROM chunks ORDER BY offset"))
    assert "".join(item["excerpt"] for item in chunks) == body
    assert len(chunks) == summary["chunk_count"]
    assert all(len(item["excerpt"]) <= 1600 for item in chunks)
    assert all("假标题" not in item["heading"] for item in chunks)
    assert any("总标题 / JSON读写" in item["heading"] for item in chunks)
    results = store.search(["python"], "jsonload", limit=2, char_budget=3200)
    assert len(results) == 2 and sum(len(item.excerpt) for item in results) <= 3200
    assert store.search(["python"], "jsonload", char_budget=1) == []


def test_parallel_identical_uploads_only_publish_one_version(tmp_path):
    store = LibraryStore(tmp_path)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: store.upsert_document(document()), range(4)))
    assert all(result == results[0] for result in results)
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0] == 1
    assert store.status()["documents"] == 1


def test_version_validation_and_retrieval_share_a_read_snapshot(tmp_path, monkeypatch):
    reader = LibraryStore(tmp_path)
    writer = LibraryStore(tmp_path)
    reader.upsert_document(document(body="# oldtoken\n同一请求读取旧版本。"))
    original_connect = reader.connect
    advanced = False

    @contextmanager
    def interleave(*args, **kwargs):
        nonlocal advanced
        with original_connect(*args, **kwargs) as db:
            class Connection:
                def execute(self, sql, parameters=()):
                    nonlocal advanced
                    cursor = db.execute(sql, parameters)
                    if sql == "SELECT * FROM documents WHERE id=?" and not advanced:
                        row = cursor.fetchone()  # Pins the WAL read snapshot.
                        advanced = True
                        writer.upsert_document(document(version=2, body="# newtoken\n后来的新版本。"))

                        class Cursor:
                            def fetchone(self):
                                return row

                        return Cursor()
                    return cursor

            yield Connection()

    monkeypatch.setattr(reader, "connect", interleave)
    results = reader.search(["python"], "oldtoken", required_versions={"note-1": 1})
    assert len(results) == 1 and results[0].version == 1
    assert "oldtoken" in results[0].excerpt
    assert writer.get_document("note-1")["version"] == 2
    with pytest.raises(LibraryConflict):
        reader.search(["python"], "oldtoken", required_versions={"note-1": 1})


@pytest.mark.parametrize("change", [
    {"id": "../escape"}, {"space_id": "../space"}, {"file_name": "../note.md"},
    {"file_name": "C:\\note.md"}, {"file_name": "note.txt"}, {"type": "pdf"}, {"type": []},
    {"body": "a\x00b"}, {"body": "\ud800"}, {"body": "   "}, {"body": 123},
    {"version": True}, {"version": 0}, {"title": "bad\nname"}, {"space_name": ""},
])
def test_invalid_inputs_do_not_create_versions(tmp_path, change):
    store = LibraryStore(tmp_path)
    with pytest.raises(LibraryError) as error:
        store.upsert_document(document(**change))
    assert error.value.status == 422
    assert store.status()["documents"] == 0


def test_utf8_byte_limit_checked_before_indexing(tmp_path):
    store = LibraryStore(tmp_path)
    with pytest.raises(LibraryError) as error:
        store.upsert_document(document(body="汉" * (MAX_FILE_BYTES // 3 + 1)))
    assert error.value.status == 413
    assert store.list_documents() == []


def test_corrupted_original_is_never_silently_overwritten(tmp_path):
    store = LibraryStore(tmp_path)
    store.upsert_document(document())
    original = next((tmp_path / "uploads").glob("*/*.md"))
    original.write_text("changed out of band", encoding="utf-8")
    with pytest.raises(LibraryError) as error:
        store.upsert_document(document())
    assert error.value.status == 503
    assert original.read_text(encoding="utf-8") == "changed out of band"


@pytest.mark.parametrize("question", [
    "光合作用的卡尔文循环如何固定二氧化碳？",
    "唐代诗人李白出生在哪一年？",
    "咖啡因的分子式是什么？",
])
def test_question_particles_do_not_turn_unrelated_topics_into_evidence(tmp_path, question):
    # These are the natural-query false positives found in the private-corpus
    # evaluation. Retain a portable regression even without that private data.
    store = LibraryStore(tmp_path)
    store.upsert_document(document(body="""# 编程问答
## 循环
如何使用 Python 循环？固定次数可以遍历 range。
## 异常
异常发生在哪一行，应检查堆栈。函数返回什么由其实现决定。
"""))
    assert store.search(["python"], question, required_versions={"note-1": 1}) == []
