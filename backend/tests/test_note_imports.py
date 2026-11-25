import copy
import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.note_imports import NoteImportCatalog, NoteImportNotFound


def bundle(import_id="study-20261106"):
    body = "# 第一课\n\n这是用于测试导入的学习笔记。\n"
    return {"id": import_id, "title": "AI 学习笔记", "source_sha256": "a" * 64,
            "space": {"id": "study-space", "name": "AI 学习", "description": "课程笔记", "icon": "sparkles", "color": "#666666"},
            "documents": [{"id": "lesson-1", "spaceId": "study-space", "title": "第一课", "fileName": "01.md",
                           "type": "md", "size": len(body.encode()), "updatedAt": "2026-11-06T12:00:00+08:00",
                           "version": 1, "status": "available", "body": body, "heading": "第一课", "isDemo": False,
                           "sourcePath": "notes/01.md", "contentHash": hashlib.sha256(body.encode()).hexdigest(),
                           "importBatchId": import_id, "studyGroup": "基础", "order": 1}],
            "excluded": ["raw/original-private.md", "评估/answers.md"], "summary": {"count": 1}}


def write_bundle(root, data=None):
    data = data or bundle()
    path = root / "imports" / data["id"] / "bundle.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path), base_url="http://127.0.0.1:8000") as opened:
        yield opened


def test_lists_metadata_and_returns_only_explicit_bundle(client, tmp_path):
    data = bundle()
    write_bundle(tmp_path, data)
    listed = client.get("/api/note-imports")
    assert listed.status_code == 200
    assert listed.json() == {"imports": [{"id": data["id"], "title": data["title"], "count": 1,
                                         "source_sha256": data["source_sha256"]}]}
    assert "学习笔记。" not in listed.text
    detail = client.get(f"/api/note-imports/{data['id']}")
    assert detail.status_code == 200 and detail.json() == data


def test_missing_catalog_and_unknown_id_are_safe(client):
    assert client.get("/api/note-imports").json() == {"imports": []}
    reply = client.get("/api/note-imports/missing")
    assert reply.status_code == 404


@pytest.mark.parametrize("import_id", ["..", "../private", "/absolute", "a/b", r"a\b", "C:private", "raw", "original", "评估"])
def test_identifiers_cannot_escape_or_access_reserved_directories(tmp_path, import_id):
    with pytest.raises(NoteImportNotFound):
        NoteImportCatalog(tmp_path).get(import_id)


def test_bad_json_does_not_echo_contents_or_local_path(client, tmp_path):
    path = write_bundle(tmp_path)
    path.write_text('{"secret": "DO-NOT-EXPOSE-PRIVATE-FILE",', encoding="utf-8")
    for address in ("/api/note-imports", "/api/note-imports/study-20261106"):
        reply = client.get(address)
        assert reply.status_code == 503
        assert "DO-NOT-EXPOSE" not in reply.text and str(tmp_path) not in reply.text


@pytest.mark.parametrize("change", ["wrong-space", "duplicate", "wrong-count", "wrong-hash", "not-documents", "wrong-id", "bad-icon", "nan-summary"])
def test_invalid_bundle_shape_and_count_are_rejected(client, tmp_path, change):
    data = copy.deepcopy(bundle())
    if change == "wrong-space":
        data["documents"][0]["spaceId"] = "other-space"
    elif change == "duplicate":
        data["documents"].append(copy.deepcopy(data["documents"][0]))
    elif change == "wrong-count":
        data["summary"]["count"] = 29
    elif change == "wrong-hash":
        data["source_sha256"] = "invalid"
    elif change == "not-documents":
        data["documents"] = "private content"
    elif change == "bad-icon":
        data["space"]["icon"] = "unsupported-icon"
    elif change == "nan-summary":
        data["summary"]["metric"] = float("nan")
    path = write_bundle(tmp_path, data)
    if change == "wrong-id":
        data["id"] = "different-id"
        path.write_text(json.dumps(data), encoding="utf-8")
    assert client.get("/api/note-imports/study-20261106").status_code == 503


def test_raw_original_and_evaluation_files_are_never_served(client, tmp_path):
    write_bundle(tmp_path)
    for name in ("raw", "original", "评估"):
        folder = tmp_path / "imports" / name
        folder.mkdir()
        (folder / "private.md").write_text("PRIVATE-UNSELECTED-CONTENT", encoding="utf-8")
        # Even a file named bundle.json in a reserved directory is not a study bundle.
        (folder / "bundle.json").write_text("PRIVATE-UNSELECTED-CONTENT", encoding="utf-8")
    (tmp_path / "imports" / "private.md").write_text("PRIVATE-UNSELECTED-CONTENT", encoding="utf-8")
    reply = client.get("/api/note-imports")
    assert reply.status_code == 200 and len(reply.json()["imports"]) == 1
    assert "PRIVATE-UNSELECTED-CONTENT" not in reply.text
    for address in ("raw", "original", "%E8%AF%84%E4%BC%B0", "private.md", "%2E%2E"):
        reply = client.get(f"/api/note-imports/{address}")
        assert reply.status_code == 404 and "PRIVATE-UNSELECTED-CONTENT" not in reply.text


def test_symlinked_bundle_cannot_read_outside_import_root(client, tmp_path, monkeypatch):
    private = tmp_path / "unrelated-private-bundle.json"
    private.write_text("PRIVATE-OUTSIDE-IMPORTS", encoding="utf-8")
    root = tmp_path / "imports" / "linked"
    root.mkdir(parents=True)
    target = root / "bundle.json"
    target.write_text("{}", encoding="utf-8")
    original_resolve = Path.resolve

    def simulated_link(path, *args, **kwargs):
        return private if path == target else original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", simulated_link)
    reply = client.get("/api/note-imports/linked")
    assert reply.status_code == 404 and "PRIVATE-OUTSIDE" not in reply.text
    assert client.get("/api/note-imports").json() == {"imports": []}


def test_body_and_encoded_file_size_limits(client, tmp_path, monkeypatch):
    from backend import note_imports

    monkeypatch.setattr(note_imports, "MAX_BODY_BYTES", 10)
    path = write_bundle(tmp_path)
    assert client.get("/api/note-imports/study-20261106").status_code == 503
    monkeypatch.setattr(note_imports, "MAX_BODY_BYTES", 1024)
    monkeypatch.setattr(note_imports, "MAX_BUNDLE_BYTES", path.stat().st_size - 1)
    assert client.get("/api/note-imports/study-20261106").status_code == 503


def test_note_import_api_inherits_same_local_origin_boundary(client, tmp_path):
    write_bundle(tmp_path)
    assert client.get("/api/note-imports", headers={"Origin": "https://untrusted.invalid"}).status_code == 403
    assert client.get("/api/note-imports/study-20261106", headers={"Host": "untrusted.invalid:8000"}).status_code == 403
