import json

import httpx
import pytest

from backend.tests.test_api import clients, provider_config, request_payload
from backend.tests.test_card_generation import payload as card_payload, response as card_response


def chat_payload(**changes):
    return request_payload(answer_mode='assistant', retrieval_mode='none', documents=[], **changes)


ENDPOINTS = [('/api/chat', chat_payload), ('/api/cards/generate', card_payload)]


def model_reply(endpoint):
    return card_response() if endpoint.endswith('generate') else httpx.Response(200, json={'choices': [{'message': {'content': '模拟回答'}}]})


@pytest.mark.parametrize('endpoint,make_payload', ENDPOINTS)
@pytest.mark.parametrize('effort', ['low', 'medium', 'high', 'xhigh'])
def test_explicit_effort_reaches_both_model_request_paths(clients, endpoint, make_payload, effort):
    def upstream(request):
        body = json.loads(request.content)
        assert body['reasoning_effort'] == effort
        assert body['model'] == 'custom-model'
        assert set(body) == {'model', 'messages', 'stream', 'reasoning_effort'}
        assert 'temperature' not in body
        return model_reply(endpoint)
    client = clients(upstream)
    client.put('/api/providers/test', json=provider_config())
    result = client.post(endpoint, json=make_payload(model='custom-model', reasoning_effort=effort))
    assert result.status_code == 200
    if endpoint.endswith('generate'):
        assert result.json()['reasoning_effort'] == effort
    assert not client.app.state.active_requests


@pytest.mark.parametrize('endpoint,make_payload', ENDPOINTS)
def test_default_omits_reasoning_for_legacy_or_non_reasoning_services(clients, endpoint, make_payload):
    def upstream(request):
        assert 'reasoning_effort' not in json.loads(request.content)
        return model_reply(endpoint)
    client = clients(upstream)
    client.put('/api/providers/test', json=provider_config())
    assert client.post(endpoint, json=make_payload()).status_code == 200


@pytest.mark.parametrize('endpoint,make_payload', ENDPOINTS)
@pytest.mark.parametrize('effort', ['default', 'ultra', 3])
def test_invalid_effort_is_rejected_without_calling_service(clients, endpoint, make_payload, effort):
    client = clients(lambda _: pytest.fail('Invalid effort must not call model'))
    client.put('/api/providers/test', json=provider_config())
    assert client.post(endpoint, json=make_payload(reasoning_effort=effort)).status_code == 422


def test_unsupported_effort_is_clear_sanitized_and_never_silently_retried(clients):
    calls = []
    def upstream(request):
        calls.append(request)
        return httpx.Response(400, json={'error': {'param': 'reasoning_effort', 'message': 'unsupported xhigh test-only-secret-123456'}})
    client = clients(upstream)
    client.put('/api/providers/test', json=provider_config())
    result = client.post('/api/chat', json=chat_payload(reasoning_effort='xhigh'))
    assert result.status_code == 400
    assert '模型默认' in result.json()['detail']
    assert 'test-only-secret' not in result.text
    assert len(calls) == 1
    assert not client.app.state.active_requests


@pytest.mark.parametrize('configured,expected', [(None, 300), ('17', 17)])
def test_deep_reasoning_gets_time_but_respects_explicit_timeout(clients, monkeypatch, configured, expected):
    if configured is None:
        monkeypatch.delenv('LOREDOCK_MODEL_TIMEOUT', raising=False)
    else:
        monkeypatch.setenv('LOREDOCK_MODEL_TIMEOUT', configured)
    def upstream(request):
        assert request.extensions['timeout']['read'] == expected
        return model_reply('/api/chat')
    client = clients(upstream)
    client.put('/api/providers/test', json=provider_config())
    assert client.post('/api/chat', json=chat_payload(reasoning_effort='xhigh')).status_code == 200


def test_card_generation_cache_binds_effort_to_request_identity(clients):
    calls = []
    client = clients(lambda request: (calls.append(request), card_response())[1])
    client.put('/api/providers/test', json=provider_config())
    data = card_payload(reasoning_effort='medium')
    assert client.post('/api/cards/generate', json=data).status_code == 200
    assert client.post('/api/cards/generate', json=data).status_code == 200
    data['reasoning_effort'] = 'high'
    assert client.post('/api/cards/generate', json=data).status_code == 409
    assert len(calls) == 1
