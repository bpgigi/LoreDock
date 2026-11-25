"""Local library HTTP boundaries and indexed-chat integration, using no real model."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.tests.test_api import TestProtector, provider_config


def document(**values):
    return {
        "id": "python-doc", "space_id": "learning", "space_name": "学习笔记",
        "title": "数据处理笔记", "file_name": "python.md", "type": "md",
        "body": "# 数据处理笔记\n\n## JSON\n\n使用 json.loads 解析字符串，json.load 读取文件。\n"
                "\n## 环境\n\nVIRTUALENV-UNRELATED-SECTION\n",
        "version": 2, **values,
    }


def search_payload(**values):
    return {"question": "loads", "scope_ids": ["learning"],
            "document_versions": {"python-doc": 2}, **values}


def chat_payload(**values):
    return {"session_id": "local-session", "request_id": "local-request",
            "provider_id": "test", "model": "test-model", "question": "loads",
            "scope_ids": ["learning"], "retrieval_mode": "indexed",
            "document_versions": {"python-doc": 2}, "documents": [], "history": [], **values}


def no_model(_request):
    pytest.fail("This operation must not request a model or any external service")


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path / "local-data", transport=httpx.MockTransport(no_model),
                     protector=TestProtector())
    with TestClient(app, base_url="http://127.0.0.1:8000") as instance:
        yield instance


def save(client, payload=None):
    payload = payload or document()
    response = client.put(f'/api/library/documents/{payload["id"]}', json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_document_copy_and_index_survive_service_reopen(tmp_path):
    directory = tmp_path / "persistent-library"
    app = create_app(directory, transport=httpx.MockTransport(no_model), protector=TestProtector())
    with TestClient(app, base_url="http://127.0.0.1:8000") as first:
        summary = save(first)
        assert summary["status"] == "indexed"
        assert summary["size"] == len(document()["body"].encode("utf-8"))
        assert summary["chunk_count"] >= 2
        initial_status = first.get("/api/library/status").json()
        save(first)  # Idempotent upload must not duplicate any active chunk.
        assert first.get("/api/library/status").json() == initial_status
    reopened = create_app(directory, transport=httpx.MockTransport(no_model), protector=TestProtector())
    with TestClient(reopened, base_url="http://127.0.0.1:8000") as second:
        stored = second.get("/api/library/documents/python-doc")
        assert stored.status_code == 200
        assert stored.json()["body"] == document()["body"]
        assert stored.json()["content_hash"] == summary["content_hash"]
        assert "original_path" not in stored.json()
        assert second.get("/api/library/status").json() == initial_status
        listed = second.get("/api/library/documents").json()["documents"]
        assert len(listed) == 1 and "body" not in listed[0]
        hits = second.post("/api/library/search", json=search_payload()).json()["citations"]
        assert len(hits) == 1 and hits[0]["documentId"] == "python-doc"
    originals = list((directory / "uploads").rglob("*.md"))
    assert len(originals) == 1
    assert originals[0].read_text(encoding="utf-8") == document()["body"]


@pytest.mark.parametrize("question", ["LOADS", "读取文件"])
def test_local_search_supports_english_and_chinese_without_provider(client, question):
    save(client)
    response = client.post("/api/library/search", json=search_payload(question=question))
    assert response.status_code == 200
    hits = response.json()["citations"]
    assert len(hits) == 1 and "json.loads" in hits[0]["excerpt"]
    assert hits[0]["version"] == 2
    assert "JSON" in hits[0]["heading"]
    assert "关键词" in response.json()["context_note"]


def test_allowlist_and_space_scope_exclude_cached_private_or_removed_browser_docs(client):
    save(client)
    save(client, document(id="omitted", body="loads OMITTED-FROM-CURRENT-BROWSER", version=1))
    save(client, document(id="private", space_id="private", space_name="私有",
                          body="loads PRIVATE-SPACE-SENTINEL", version=1))
    response = client.post("/api/library/search", json=search_payload())
    assert response.status_code == 200
    assert {hit["documentId"] for hit in response.json()["citations"]} == {"python-doc"}
    assert "PRIVATE-SPACE-SENTINEL" not in response.text
    assert "OMITTED-FROM-CURRENT-BROWSER" not in response.text
    empty = client.post("/api/library/search", json=search_payload(document_versions={}))
    assert empty.status_code == 200 and empty.json()["citations"] == []
    wrong_scope = client.post("/api/library/search", json=search_payload(document_versions={"private": 1}))
    assert wrong_scope.status_code == 409 and "PRIVATE-SPACE-SENTINEL" not in wrong_scope.text
    exact_doc = client.post("/api/library/search", json=search_payload(document_id="python-doc"))
    assert exact_doc.status_code == 200
    inconsistent_doc = client.post("/api/library/search", json=search_payload(document_id="omitted"))
    assert inconsistent_doc.status_code == 409


def test_version_conflicts_do_not_overwrite_original_or_retrieve_old_chunks(client):
    original = save(client)
    assert client.put("/api/library/documents/python-doc", json=document(body="conflicting same version")).status_code == 409
    assert client.get("/api/library/documents/python-doc").json()["content_hash"] == original["content_hash"]
    updated = save(client, document(version=3, body="# Updated\n\nNEW-VERSION-SENTINEL"))
    assert updated["version"] == 3
    assert client.put("/api/library/documents/python-doc", json=document()).status_code == 409
    stale_search = client.post("/api/library/search", json=search_payload())
    assert stale_search.status_code == 409
    current_search = client.post("/api/library/search", json=search_payload(document_versions={"python-doc": 3}))
    assert current_search.status_code == 200 and current_search.json()["citations"] == []
    new_hits = client.post("/api/library/search", json=search_payload(
        question="SENTINEL", document_versions={"python-doc": 3})).json()["citations"]
    assert new_hits and all(hit["version"] == 3 for hit in new_hits)
    assert all("json.loads" not in hit["excerpt"] for hit in new_hits)


def test_indexed_chat_only_sends_retrieved_sources_and_validates_citations(tmp_path):
    calls = []

    def upstream(request):
        assert request.url.path == "/v1/chat/completions"
        body = json.loads(request.content)
        calls.append(body)
        sources = json.loads(body["messages"][-1]["content"])["source_passages"]
        assert len(sources) == 1
        assert "json.loads" in sources[0]["text"]
        encoded = json.dumps(body, ensure_ascii=False)
        assert "VIRTUALENV-UNRELATED-SECTION" not in encoded
        assert "PRIVATE-MODEL-SENTINEL" not in encoded
        content = {"answer": "使用 json.loads。[S1] 不可核验的说法[S999]",
                   "citation_ids": ["S1", "S999"]}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content)}}]})

    app = create_app(tmp_path / "chat", transport=httpx.MockTransport(upstream), protector=TestProtector())
    with TestClient(app, base_url="http://127.0.0.1:8000") as instance:
        assert instance.put("/api/providers/test", json=provider_config()).status_code == 200
        save(instance)
        save(instance, document(id="private", space_id="private", space_name="私有",
                                body="loads PRIVATE-MODEL-SENTINEL", version=1))
        response = instance.post("/api/chat", json=chat_payload())
        assert response.status_code == 200
        answer = response.json()
        assert answer["session_id"] == "local-session" and answer["request_id"] == "local-request"
        assert len(answer["citations"]) == 1 and answer["citations"][0]["version"] == 2
        assert answer["citations"][0]["documentId"] == "python-doc"
        assert "S999" not in answer["body"] and "无法核验" in answer["body"]
        assert "关键词" in answer["context_note"]
        assert len(calls) == 1 and not instance.app.state.active_requests


@pytest.mark.parametrize("versions,question", [({"python-doc": 2}, "nevermatchingword"), ({}, "loads")])
def test_zero_hits_never_call_model(client, versions, question):
    save(client)
    client.put("/api/providers/test", json=provider_config())
    response = client.post("/api/chat", json=chat_payload(document_versions=versions, question=question))
    assert response.status_code == 200
    assert response.json()["citations"] == []
    assert "未调用模型" in response.json()["context_note"]
    assert not client.app.state.active_requests


def test_indexed_chat_rejects_stale_versions_and_body_snapshot(client):
    save(client)
    client.put("/api/providers/test", json=provider_config())
    stale = client.post("/api/chat", json=chat_payload(document_versions={"python-doc": 1}))
    assert stale.status_code == 409 and not client.app.state.active_requests
    snapshot = {key: document()[key] for key in ("id", "space_id", "title", "body", "version")}
    mixed = client.post("/api/chat", json=chat_payload(documents=[snapshot]))
    assert mixed.status_code == 422
    assert "json.loads" not in mixed.text


def test_retire_hides_documents_and_blocks_late_upload_resurrection(client):
    save(client)
    retired = client.post("/api/library/retire", json={"document_ids": ["python-doc", "not-uploaded-yet"]})
    assert retired.status_code == 200
    assert retired.json() == {"retired": 2, "retrievable": False, "purge_pending": True}
    assert client.get("/api/library/documents/python-doc").status_code == 404
    assert client.get("/api/library/documents/not-found").status_code == 404
    assert client.get("/api/library/documents").json()["documents"] == []
    status = client.get("/api/library/status").json()
    assert status["documents"] == 0 and status["chunks"] == 0 and status["deleted_documents"] == 2
    assert client.put("/api/library/documents/python-doc", json=document(version=3)).status_code == 409
    assert client.put("/api/library/documents/not-uploaded-yet", json=document(id="not-uploaded-yet")).status_code == 409
    assert client.post("/api/library/search", json=search_payload()).status_code == 409
    repeat = client.post("/api/library/retire", json={"document_ids": ["python-doc"]})
    assert repeat.status_code == 200
    assert client.get("/api/library/status").json() == status


@pytest.mark.parametrize("change", [
    {"file_name": "../../private-secret.md"},
    {"file_name": "private-secret.txt", "type": "md"},
    {"body": "private-secret\x00"},
    {"space_id": "../private-secret"},
    {"version": 0},
    {"type": "pdf"},
])
def test_invalid_upload_is_safe_and_does_not_create_documents(client, change):
    response = client.put("/api/library/documents/python-doc", json=document(**change))
    assert response.status_code == 422
    assert "private-secret" not in response.text
    assert client.get("/api/library/status").json()["documents"] == 0


def test_path_id_mismatch_and_bad_retirement_do_not_mutate(client):
    mismatch = client.put("/api/library/documents/different-id", json=document())
    assert mismatch.status_code == 422
    empty = client.post("/api/library/retire", json={"document_ids": []})
    assert empty.status_code == 422
    malicious = client.post("/api/library/retire", json={"document_ids": ["normal", "../private-secret"]})
    assert malicious.status_code == 422 and "private-secret" not in malicious.text
    assert client.get("/api/library/status").json()["deleted_documents"] == 0


def test_cross_origin_access_to_library_is_blocked(client):
    response = client.put("/api/library/documents/python-doc", json=document(),
                          headers={"Origin": "https://untrusted.invalid"})
    assert response.status_code == 403
    assert client.get("/api/library/status").json()["documents"] == 0
