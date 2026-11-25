import asyncio
import json
import os
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app import cancellable_provider_call, create_app
from fastapi import HTTPException
from backend.store import WindowsSecretProtector
from backend.context import passages
from backend.schemas import ContextDocument


class TestProtector:
    """Only for protocol tests; production always uses user-bound Windows DPAPI."""
    __test__ = False

    def protect(self, value):
        return b"encrypted-test-value:" + value.encode()[::-1]

    def reveal(self, value):
        return value.removeprefix(b"encrypted-test-value:")[::-1].decode()


def provider_config(**values):
    return {"name": "Test service", "base_url": "https://example.invalid/v1",
            "default_model": "test-model", "api_key": "test-only-secret-123456", **values}


def request_payload(**values):
    return {"session_id": "session-1", "request_id": "request-1", "provider_id": "test",
            "model": "test-model", "question": "异常如何处理？", "scope_ids": ["python"],
            "documents": [{"id": "python-doc", "space_id": "python", "title": "异常处理",
                           "body": "用 HTTPException 返回明确的状态码。", "version": 2, "heading": "异常处理"},
                          {"id": "private-doc", "space_id": "private", "title": "禁止泄漏",
                           "body": "DO-NOT-SEND-OUTSIDE-SCOPE", "version": 1, "heading": "私有"}],
            "history": [], **values}


@pytest.fixture
def clients(tmp_path):
    opened = []

    def make(handler):
        app = create_app(tmp_path / str(len(opened)), transport=httpx.MockTransport(handler),
                         protector=TestProtector())
        client = TestClient(app, base_url="http://127.0.0.1:8000")
        client.__enter__()
        opened.append(client)
        return client

    yield make
    for client in opened:
        client.__exit__(None, None, None)


def test_key_is_masked_retained_and_not_written_as_plaintext(clients):
    client = clients(lambda _: pytest.fail("No network expected"))
    reply = client.put("/api/providers/test", json=provider_config())
    assert reply.status_code == 200
    assert reply.json()["has_api_key"] is True
    assert "test-only-secret" not in reply.text
    with sqlite3.connect(client.app.state.store.path) as db:
        cipher = db.execute("SELECT encrypted_key FROM providers").fetchone()[0]
    assert b"test-only-secret" not in cipher
    retained = client.put("/api/providers/test", json=provider_config(api_key="", name="Renamed"))
    assert retained.json()["has_api_key"] is True
    assert "api_key" not in client.get("/api/providers").json()["providers"][0]
    removed = client.put("/api/providers/test", json=provider_config(api_key="", clear_api_key=True))
    assert removed.json()["has_api_key"] is False


def test_changing_address_does_not_forward_existing_key(clients):
    client = clients(lambda _: pytest.fail("No network expected"))
    client.put("/api/providers/test", json=provider_config())
    reply = client.put("/api/providers/test", json=provider_config(base_url="https://other.invalid/v1", api_key=""))
    assert reply.json()["has_api_key"] is False


@pytest.mark.parametrize("address", ["http://remote.invalid/v1", "https://user:secret@remote.invalid/v1",
                                    "https://remote.invalid/v1?key=secret", "file:///C:/temp"])
def test_bad_address_and_validation_errors_do_not_echo_secrets(clients, address):
    client = clients(lambda _: pytest.fail("No network expected"))
    reply = client.put("/api/providers/test", json=provider_config(base_url=address))
    assert reply.status_code == 422
    assert "test-only-secret" not in reply.text
    assert "secret" not in reply.text


def test_scope_filter_and_citation_validation(clients):
    def upstream(request):
        assert request.url.path == "/v1/chat/completions"
        body = json.loads(request.content)
        text = json.dumps(body, ensure_ascii=False)
        assert "DO-NOT-SEND-OUTSIDE-SCOPE" not in text
        assert "HTTPException" in text
        content = {"answer": "使用 HTTPException。[S1] 另一个说法[S999]", "citation_ids": ["S1", "S999"]}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content, ensure_ascii=False)}}]})

    client = clients(upstream)
    client.put("/api/providers/test", json=provider_config())
    reply = client.post("/api/chat", json=request_payload())
    assert reply.status_code == 200
    result = reply.json()
    assert result["session_id"] == "session-1" and result["request_id"] == "request-1"
    assert [item["documentId"] for item in result["citations"]] == ["python-doc"]
    assert result["citations"][0]["version"] == 2
    assert "S999" not in result["body"] and "无法核验" in result["body"]


def test_reader_document_filter_excludes_other_documents(clients):
    def upstream(request):
        text = request.content.decode()
        assert "only-current-document" in text
        assert "unrelated-other-document" not in text
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"answer":"依据原文。","citation_ids":["S1"]}'}}]})

    client = clients(upstream)
    client.put("/api/providers/test", json=provider_config())
    docs = [{"id": "current", "space_id": "python", "title": "当前", "body": "only-current-document", "version": 1},
            {"id": "other", "space_id": "python", "title": "其他", "body": "unrelated-other-document", "version": 1}]
    reply = client.post("/api/chat", json=request_payload(document_id="current", documents=docs))
    assert [item["documentId"] for item in reply.json()["citations"]] == ["current"]


def test_no_documents_does_not_call_model(clients):
    client = clients(lambda _: pytest.fail("No model call for missing context"))
    client.put("/api/providers/test", json=provider_config())
    reply = client.post("/api/chat", json=request_payload(scope_ids=["nonexistent"]))
    assert reply.status_code == 200
    assert reply.json()["citations"] == []
    assert "没有可用资料" in reply.json()["body"]


def test_models_endpoint_lists_remote_models_without_completion(clients):
    def upstream(request):
        assert request.method == "GET" and request.url.path == "/v1/models"
        assert request.headers["Authorization"] == "Bearer test-only-secret-123456"
        return httpx.Response(200, json={"data": [{"id": "model-b"}, {"id": "model-a"}]})

    client = clients(upstream)
    client.put("/api/providers/test", json=provider_config())
    assert client.post("/api/providers/test/models", json={}).json() == {"models": ["model-a", "model-b"]}


@pytest.mark.parametrize("status", [401, 429, 500, 307])
def test_provider_errors_do_not_echo_sensitive_response_bodies(clients, status):
    client = clients(lambda _: httpx.Response(status, text="upstream leaked test-only-secret-123456"))
    client.put("/api/providers/test", json=provider_config())
    reply = client.post("/api/chat", json=request_payload())
    assert reply.status_code in {429, 502}
    assert "test-only-secret" not in reply.text


def test_timeout_is_recoverable_safe_error(clients):
    def upstream(request):
        raise httpx.ReadTimeout("Do not echo test-only-secret", request=request)

    client = clients(upstream)
    client.put("/api/providers/test", json=provider_config())
    reply = client.post("/api/chat", json=request_payload())
    assert reply.status_code == 504
    assert "超时" in reply.json()["detail"]
    assert "test-only-secret" not in reply.text
    assert not client.app.state.active_requests


def test_long_document_context_is_bounded_and_disclosed(clients, monkeypatch):
    monkeypatch.setenv("LOREDOCK_CONTEXT_CHARS", "3200")

    def upstream(request):
        messages = json.loads(request.content)["messages"]
        sources = json.loads(messages[-1]["content"])["source_passages"]
        assert sum(len(source["text"]) for source in sources) <= 3200
        assert any("technical_unique_token" in source["text"] for source in sources)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"answer":"依据片段。","citation_ids":["S1"]}'}}]})

    client = clients(upstream)
    client.put("/api/providers/test", json=provider_config())
    docs = [{"id": "long", "space_id": "python", "title": "Long document",
             "body": "普通资料。" * 5000 + "technical_unique_token", "version": 1}]
    reply = client.post("/api/chat", json=request_payload(question="technical_unique_token", document_id="long", documents=docs))
    assert reply.status_code == 200
    assert "并非全文或向量检索" in reply.json()["context_note"]


def test_source_location_does_not_label_cross_section_chunk_with_last_heading():
    body = "# FastAPI 开发实践\n\n## 统一错误响应\n使用 HTTPException。\n\n## 安全日志\n不要记录密钥。\n"
    document = ContextDocument(id="fastapi", space_id="python", title="FastAPI 开发实践",
                               body=body, version=1, heading="旧元数据 / 安全日志")
    whole = passages(document, set())[0].citation
    assert whole.excerpt == body
    assert whole.heading == f"文档正文（第 1–{len(body)} 字符）"
    assert "安全日志" not in whole.heading
    # Later chunks inside one section retain the start section, not code comments.
    long_body = "# 手册\n\n## 异常处理\n" + "正文资料。" * 350 + "\n```python\n# 这只是代码注释\n```\n"
    document.body = long_body
    tail = passages(document, set())[-1].citation
    assert tail.heading.startswith("手册 / 异常处理（第 1601–")
    assert tail.excerpt == long_body[1600:]


def test_disconnected_browser_cancels_pending_provider_work():
    events = []

    class DisconnectedRequest:
        async def is_disconnected(self):
            return True

    async def operation():
        try:
            await asyncio.sleep(30)
        finally:
            events.append("cancelled")

    with pytest.raises(HTTPException) as error:
        asyncio.run(cancellable_provider_call(DisconnectedRequest(), operation()))
    assert error.value.status_code == 499
    assert events == ["cancelled"]


def test_rejects_cross_site_origin_host_and_large_request(clients):
    client = clients(lambda _: pytest.fail("No upstream expected"))
    assert client.get("/api/providers", headers={"Origin": "https://evil.invalid"}).status_code == 403
    assert client.get("/api/providers", headers={"Host": "evil.invalid:8000"}).status_code == 403
    assert client.post("/api/chat", content="{}", headers={"Content-Length": str(30 * 1024 * 1024)}).status_code == 413
    assert client.get("/api/providers", headers={"Origin": "http://127.0.0.1:5173"}).status_code == 200


@pytest.mark.skipif(os.name != "nt", reason="Production key storage is Windows DPAPI")
def test_windows_dpapi_round_trip():
    protector = WindowsSecretProtector()
    key = "test-only-dpapi-credential"
    cipher = protector.protect(key)
    assert key.encode() not in cipher
    assert protector.reveal(cipher) == key
