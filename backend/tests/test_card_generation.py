import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.tests.test_api import TestProtector, provider_config


def payload(**changes):
    return {"session_id": "card-session", "request_id": "card-request", "provider_id": "test",
            "model": "test-model", "text": "json.loads 解析字符串，json.load 读取文件对象。",
            "count": 3, "instructions": "比较区别", **changes}


def card(**changes):
    return {"title": "JSON 读取", "summary": "带 s 读字符串", "body": "使用 `json.loads(text)` 解析字符串。",
            "tags": ["Python"], "source_ids": ["P1"], **changes}


def response(cards=None, **extra):
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"cards": cards if cards is not None else [card()]}, ensure_ascii=False)}}], **extra})


@pytest.fixture
def make_client(tmp_path):
    clients = []
    def make(handler):
        app = create_app(tmp_path / str(len(clients)), transport=httpx.MockTransport(handler), protector=TestProtector())
        client = TestClient(app, base_url="http://127.0.0.1:8000")
        client.__enter__()
        clients.append(client)
        client.put("/api/providers/test", json=provider_config())
        return client
    yield make
    for client in clients:
        client.__exit__(None, None, None)


def test_pasted_text_only_and_sources_are_server_snapshots(make_client):
    def upstream(request):
        assert request.headers['Authorization'] == 'Bearer test-only-secret-123456'
        body = json.loads(request.content)
        assert set(body) == {"model", "messages", "stream"}
        assert len(body["messages"]) == 2
        source = json.loads(body['messages'][1]['content'])
        assert source['source_passages'] == [{"id": "P1", "text": payload()['text']}]
        assert source['requested_count'] == 3 and source['focus'] == '比较区别'
        return response(usage={"prompt_tokens": 101, "completion_tokens": 33, "total_tokens": 134})
    client = make_client(upstream)
    result = client.post('/api/cards/generate', json=payload())
    assert result.status_code == 200
    data = result.json()
    assert data['session_id'] == 'card-session' and data['request_id'] == 'card-request'
    assert data['cards'][0]['sources'] == [{"id": "P1", "excerpt": payload()['text']}]
    assert data['usage']['total_tokens'] == 134
    assert client.get('/api/library/status').json()['documents'] == 0
    assert 'test-only-secret' not in result.text


@pytest.mark.parametrize('changes', [{"text": "   "}, {"text": "x" * 24001}, {"count": 0}, {"count": 9},
                                     {"count": True}, {"model": " "}, {"instructions": "x" * 501}])
def test_invalid_inputs_never_spend_tokens(make_client, changes):
    client = make_client(lambda _: pytest.fail('Must not call upstream'))
    assert client.post('/api/cards/generate', json=payload(**changes)).status_code == 422


@pytest.mark.parametrize('cards', [[card(source_ids=['P999'])], [card(source_ids=[])], [card(body=' ')],
                                  [card(title='x' * 101)], [card(tags=['x' * 21])], [card(), card()]])
def test_malformed_or_unverifiable_drafts_are_not_returned(make_client, cards):
    calls = []
    client = make_client(lambda request: calls.append(request) or response(cards))
    for _ in range(2):
        result = client.post('/api/cards/generate', json=payload(count=1))
        assert result.status_code == 502 and '未保存任何卡片' in result.json()['detail']
    assert len(calls) == 1  # A repeated failed request is not automatically charged again.


def test_replay_is_idempotent_and_changed_request_id_content_is_rejected(make_client):
    calls = []
    client = make_client(lambda request: calls.append(request) or response())
    first = client.post('/api/cards/generate', json=payload()).json()
    assert client.post('/api/cards/generate', json=payload()).json() == first
    assert client.post('/api/cards/generate', json=payload(text='different')).status_code == 409
    assert len(calls) == 1


@pytest.mark.parametrize('status', [401, 429, 500, 307])
def test_quota_and_network_errors_are_sanitized(make_client, status):
    client = make_client(lambda _: httpx.Response(status, text='test-only-secret-123456 private provider body'))
    result = client.post('/api/cards/generate', json=payload())
    assert result.status_code == (429 if status == 429 else 502)
    assert 'private provider' not in result.text and 'test-only-secret' not in result.text


def test_timeout_and_missing_usage(make_client):
    client = make_client(lambda _: (_ for _ in ()).throw(httpx.ReadTimeout('private')))
    assert client.post('/api/cards/generate', json=payload()).status_code == 504
    other = make_client(lambda _: response([], usage={"total_tokens": True, "prompt_tokens": -1}))
    result = other.post('/api/cards/generate', json=payload()).json()
    assert result['cards'] == [] and result['usage'] is None


def test_fences_and_secret_echo_do_not_leak(make_client):
    content = json.dumps({"cards": [card(body='test-only-secret-123456')]})
    client = make_client(lambda _: httpx.Response(200, json={"choices": [{"message": {"content": f'```json\n{content}\n```'}}]}))
    result = client.post('/api/cards/generate', json=payload())
    assert result.status_code == 200 and 'test-only-secret' not in result.text


def test_concurrent_duplicate_is_rejected_before_upstream(make_client):
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = []
    async def upstream(request):
        calls.append(request)
        entered.set()
        await release.wait()
        return response()
    client = make_client(upstream)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://127.0.0.1:8000') as http:
            first = asyncio.create_task(http.post('/api/cards/generate', json=payload()))
            await entered.wait()
            duplicate = await http.post('/api/cards/generate', json=payload())
            assert duplicate.status_code == 409
            release.set()
            assert (await first).status_code == 200
    asyncio.run(run())
    assert len(calls) == 1
