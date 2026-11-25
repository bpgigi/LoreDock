import json

import httpx
import pytest

from backend.tests.test_api import clients, provider_config, request_payload


def assistant_payload(**changes):
    return request_payload(answer_mode="assistant", retrieval_mode="none", documents=[], **changes)


def response(content):
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


@pytest.mark.parametrize("content", ['{"answer":"你好，可以直接聊。","citation_ids":[]}', '你好，可以直接聊。'])
def test_ordinary_chat_calls_model_without_documents_or_forced_citation_warning(clients, content):
    def upstream(request):
        messages = json.loads(request.content)["messages"]
        assert "可以使用自己的知识" in messages[0]["content"]
        assert "只依据本轮" not in messages[0]["content"]
        assert json.loads(messages[-1]["content"])["source_passages"] == []
        assert messages[1] == {"role": "user", "content": "之前的问题"}
        return response(content)

    client = clients(upstream)
    client.put('/api/providers/test', json=provider_config())
    result = client.post('/api/chat', json=assistant_payload(history=[{"role": "user", "content": "之前的问题"}]))
    assert result.status_code == 200
    assert result.json()['body'] == '你好，可以直接聊。'
    assert result.json()['citations'] == []
    assert result.json()['matched_cards'] == []
    assert not client.app.state.active_requests


def test_legacy_card_payload_is_ignored_and_never_replaces_document_lookup(clients, monkeypatch):
    from backend.schemas import Citation
    looked_up = []

    def upstream(request):
        assert 'LOCAL-CARD-SECRET' not in request.content.decode()
        sources = json.loads(json.loads(request.content)['messages'][-1]['content'])['source_passages']
        assert len(sources) == 1
        assert sources[0]['kind'] == 'document'
        assert sources[0]['text'] == '文档检索结果'
        return response('{"answer":"参考资料[S1]，还可以进一步解释。","citation_ids":["S1"]}')

    def lookup(*args):
        looked_up.append(True)
        return {'S1': Citation(id='chunk-1', documentId='doc', title='资料', version=1, heading='正文', excerpt='文档检索结果')}, ''

    monkeypatch.setattr('backend.app.indexed_context', lookup)
    client = clients(upstream)
    client.put('/api/providers/test', json=provider_config())
    card = {"id": "card-1", "space_id": "python", "title": "LOCAL-CARD-SECRET", "body": "LOCAL-CARD-SECRET", "version": 3, "is_ai_draft": True}
    result = client.post('/api/chat', json=request_payload(answer_mode='assistant', retrieval_mode='indexed', documents=[], cards=[card], document_versions={'stale-doc': 1}))
    assert result.status_code == 200
    citation = result.json()['citations'][0]
    assert looked_up == [True]
    assert citation['cardId'] is None and citation['documentId'] == 'doc'
    assert result.json()['matched_cards'] == []
    assert '[1]' in result.json()['body']


@pytest.mark.parametrize('space_id', ['python', 'other'])
def test_all_cards_stay_out_of_model_requests_and_unknown_references_are_removed(clients, space_id):
    def upstream(request):
        assert 'OUTSIDE-SECRET' not in request.content.decode()
        return response('{"answer":"普通解释[S999]","citation_ids":["S999"]}')

    client = clients(upstream)
    client.put('/api/providers/test', json=provider_config())
    result = client.post('/api/chat', json=assistant_payload(cards=[{"id": "private", "space_id": space_id, "title": "私有卡片", "body": "OUTSIDE-SECRET", "version": 1}]))
    assert result.status_code == 200
    assert result.json()['body'] == '普通解释'
    assert result.json()['citations'] == []
    assert result.json()['matched_cards'] == []


def test_optional_document_lookup_can_fall_back_to_normal_ai(clients):
    calls = []
    client = clients(lambda request: (calls.append(request), response('{"answer":"可以用一般知识说明。","citation_ids":[]}'))[1])
    client.put('/api/providers/test', json=provider_config())
    result = client.post('/api/chat', json=request_payload(answer_mode='assistant', retrieval_mode='indexed', documents=[], document_versions={}))
    assert result.status_code == 200 and len(calls) == 1
    assert result.json()['body'] == '可以用一般知识说明。'
    assert '未调用模型' not in result.json()['context_note']


def test_optional_reader_reference_keeps_current_document_filter_and_relaxed_answer(clients):
    def upstream(request):
        text = request.content.decode()
        assert 'HTTPException' in text and 'DO-NOT-SEND' not in text
        return response('{"answer":"参考原文[S1]，也可以使用其他异常处理方法。","citation_ids":["S1"]}')

    client = clients(upstream)
    client.put('/api/providers/test', json=provider_config())
    result = client.post('/api/chat', json=request_payload(answer_mode='assistant', document_id='python-doc'))
    assert result.status_code == 200
    assert result.json()['citations'][0]['documentId'] == 'python-doc'
    assert '无法核验' not in result.json()['body']


@pytest.mark.parametrize('changes', [
    {'documents': [{'id': 'd', 'space_id': 'python', 'title': '不可自动附带', 'body': 'secret', 'version': 1}]},
    {'document_versions': {'d': 1}},
    {'cards': [{'id': 'c', 'space_id': 'python', 'title': '卡', 'body': 'x' * 6001, 'version': 1}]},
])
def test_disabled_document_mode_and_card_limits_are_validated(clients, changes):
    client = clients(lambda _: pytest.fail('Invalid requests must not call a provider'))
    client.put('/api/providers/test', json=provider_config())
    payload = assistant_payload()
    payload.update(changes)
    assert client.post('/api/chat', json=payload).status_code == 422


def test_ordinary_ai_preserves_key_redaction_and_failure_cleanup(clients):
    client = clients(lambda _: response('test-only-secret-123456'))
    client.put('/api/providers/test', json=provider_config())
    result = client.post('/api/chat', json=assistant_payload())
    assert result.status_code == 200 and 'test-only-secret' not in result.text
    assert '[已隐藏密钥]' in result.json()['body']
    failing = clients(lambda _: httpx.Response(429))
    failing.put('/api/providers/test', json=provider_config())
    assert failing.post('/api/chat', json=assistant_payload()).status_code == 429
    assert not failing.app.state.active_requests
