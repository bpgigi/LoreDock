"""Isolated browser fixture: python -m backend.tests.assistant_preview.

Uses temporary databases and a mock provider at 127.0.0.1:8002. No real key,
workspace, model call, or paid request is used. Stop with Ctrl+C after UI checks.
"""
import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import uvicorn
from fastapi.staticfiles import StaticFiles

from backend.app import create_app
from backend.schemas import ProviderInput


def main():
    calls = []
    library_requests = []
    chat_request_fields = []

    async def upstream(request):
        if request.url.path.endswith('/models'):
            return httpx.Response(200, json={'data': [{'id': value} for value in ['gpt-6.1-sol', 'gpt-5', 'simulated-assistant', 'simulated-basic']]})
        payload = json.loads(request.content)
        user = json.loads(payload['messages'][-1]['content'])
        sources = user['source_passages']
        selection = user.get('reading_selection')
        calls.append({'question': user.get('question'), 'model': payload['model'], 'reasoning_effort': payload.get('reasoning_effort'), 'request_fields': sorted(payload), 'sources': [source.get('kind', 'pasted') for source in sources], 'selection': selection, 'history': payload['messages'][1:-1]})
        if payload['model'] == 'simulated-basic' and payload.get('reasoning_effort'):
            return httpx.Response(400, json={'error': {'param': 'reasoning_effort', 'message': 'This simulated model does not support reasoning_effort'}})
        if 'requested_count' in user:
            cards = [{'title': '模拟生成卡片', 'summary': '验证思考档位传递', 'body': sources[0]['text'], 'tags': ['测试'], 'source_ids': [sources[0]['id']]}]
            return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps({'cards': cards}, ensure_ascii=False)}}]})
        if '模拟失败' in user['question']:
            return httpx.Response(429)
        if '模拟慢响应' in user['question']:
            await asyncio.sleep(15)
        if selection:
            answer = f"这是本机模拟的选文问答。\n\n你选中了 **{selection['text']}**，来自「{selection['title']}」的「{selection['heading']}」。本轮已收到附近原文，可以继续追问。\n\n实际解释由你选择的模型生成；此处仅验证选文和上下文传递。"
        elif sources:
            answer = f"这是本机模拟回答。参考资料「{sources[0]['title']}」[S1]，也可以用一般知识继续解释。"
        else:
            answer = '这是本机模拟的普通 AI 回答。模型请求没有附带知识卡片；下方的相关卡片由本地匹配，点击即可查看。'
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps({'answer': answer, 'citation_ids': ['S1'] if sources else []}, ensure_ascii=False)}}]})

    class FixtureOrigin:
        def __init__(self, app):
            self.app = app
        async def __call__(self, scope, receive, send):
            original_receive = receive
            body = bytearray()
            async def inspect_request():
                message = await original_receive()
                if message['type'] == 'http.request':
                    body.extend(message.get('body', b''))
                    if not message.get('more_body'):
                        chat_request_fields.append(sorted(json.loads(body)))
                return message
            if scope['type'] == 'http':
                if scope['path'].startswith('/api/library/'):
                    library_requests.append(scope['path'])
                scope = {**scope, 'headers': [(key, b'http://127.0.0.1:8000' if key == b'origin' and value == b'http://127.0.0.1:8002' else value) for key, value in scope['headers']]}
            await self.app(scope, inspect_request if scope['type'] == 'http' and scope['path'] == '/api/chat' else receive, send)

    with TemporaryDirectory(prefix='loredock-assistant-qa-') as temporary:
        app = create_app(Path(temporary), transport=httpx.MockTransport(upstream))
        app.state.store.save('simulation', ProviderInput(name='本机模拟（不消耗额度）', base_url='http://127.0.0.1:1/v1', default_model='simulated-assistant'))
        app.state.store.save('simulation-alt', ProviderInput(name='备用模拟服务', base_url='http://127.0.0.1:1/v1', default_model='gpt-6.1-sol'))
        app.add_middleware(FixtureOrigin)

        @app.get('/__test__/stats')
        async def stats():
            return {'calls': calls, 'chat_request_fields': chat_request_fields, 'library_requests': library_requests, 'simulated': True}

        app.mount('/', StaticFiles(directory=Path(__file__).resolve().parents[2] / 'frontend/dist', html=True))
        uvicorn.run(app, host='127.0.0.1', port=8002, log_level='warning', access_log=False)


if __name__ == '__main__':
    main()
