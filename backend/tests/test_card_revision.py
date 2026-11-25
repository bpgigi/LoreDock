import json

import httpx
import pytest

from backend.tests.test_card_generation import make_client, payload, response


def draft(identity, ordinal):
    return {'id': identity, 'ordinal': ordinal, 'title': '知识点', 'summary': '', 'body': '原始正文', 'tags': ['Python'],
            'sources': [{'id': 'P1', 'excerpt': f'原文{identity}', 'documentId': 'doc-1', 'spaceId': 'python',
                         'title': '文章', 'heading': f'章节{ordinal}', 'version': 3, 'start': ordinal * 20, 'end': ordinal * 20 + 6, 'isDraft': True, 'isHistorical': False, 'sourcePath': 'notes/example.md'}]}


def revision(**changes):
    return {'session_id': 'reading', 'request_id': 'revision-1', 'provider_id': 'test', 'model': 'test-model',
            'revision': 2, 'instructions': '合并这两张', 'drafts': [draft('a', 1), draft('b', 2)], **changes}


def operation(ids=None, **changes):
    return {'target_ids': ['a', 'b'] if ids is None else ids,
            'card': {'title': '合并后', 'summary': '记法', 'body': 'AI 补充示例\n```python\nprint(1)\n```', 'tags': [], **changes}}


def upstream_response(operations=None, finish='stop'):
    return httpx.Response(200, json={'choices': [{'finish_reason': finish, 'message': {'content': json.dumps({'operations': operations if operations is not None else [operation()]})}}]})


def test_merge_preserves_stable_id_and_all_provenance_without_saving(make_client):
    def upstream(request):
        body = json.loads(request.content)
        assert body['reasoning_effort'] == 'high'
        assert 'cards' not in body
        content = json.loads(body['messages'][-1]['content'])
        assert content['drafts'][1]['ordinal'] == 2
        assert content['drafts'][0]['sources'] == revision()['drafts'][0]['sources']
        return upstream_response()
    client = make_client(upstream)
    result = client.post('/api/cards/revise', json=revision(reasoning_effort='high'))
    assert result.status_code == 200
    body = result.json()
    assert body['revision'] == 2 and body['reasoning_effort'] == 'high'
    assert body['operations'][0]['card']['id'] == 'a'
    assert body['operations'][0]['card']['sources'] == [item['sources'][0] for item in revision()['drafts']]
    assert client.get('/api/library/status').json()['documents'] == 0


@pytest.mark.parametrize('operations', [[operation(['invented'])], [operation(['a', 'a'])], [operation(['a']), operation(['a'])],
                                        [operation([], body='')], [operation(sources=[])], [operation(source_ids=['P2'])]])
def test_invalid_revision_never_returns_destructive_operations(make_client, operations):
    client = make_client(lambda _: upstream_response(operations))
    result = client.post('/api/cards/revise', json=revision())
    assert result.status_code == 502 and '原草稿未修改' in result.json()['detail']


def test_replay_revision_does_not_spend_again_and_changed_revision_is_conflict(make_client):
    calls = []
    client = make_client(lambda _: calls.append(1) or upstream_response())
    first = client.post('/api/cards/revise', json=revision())
    assert first.status_code == 200
    assert client.post('/api/cards/revise', json=revision()).json() == first.json()
    assert client.post('/api/cards/revise', json=revision(revision=3)).status_code == 409
    assert len(calls) == 1


@pytest.mark.parametrize('changes', [{'drafts': []}, {'drafts': [draft('a', 1)] * 2}, {'drafts': [draft(str(n), n + 1) for n in range(9)]},
                                     {'instructions': ' '}, {'instructions': 'x' * 4001}, {'revision': True}])
def test_invalid_revision_input_is_rejected_before_model(make_client, changes):
    client = make_client(lambda _: pytest.fail('Invalid input must not call model'))
    assert client.post('/api/cards/revise', json=revision(**changes)).status_code == 422


@pytest.mark.parametrize('finish', ['length', 'content_filter'])
def test_partial_output_is_never_accepted_as_complete(make_client, finish):
    client = make_client(lambda _: upstream_response(finish=finish))
    assert client.post('/api/cards/revise', json=revision()).status_code == 502
    def partial(_):
        data = json.loads(response().content)
        data['choices'][0]['finish_reason'] = finish
        return httpx.Response(200, json=data)
    client = make_client(partial)
    assert client.post('/api/cards/generate', json=payload()).status_code == 502
