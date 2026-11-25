"""Optional browser QA fixture: python -m backend.tests.card_preview.

Serves the production frontend build at 127.0.0.1:8001, with temporary databases
and an explicitly named simulated provider. Never reads real keys or user data.
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

    async def upstream(request):
        calls.append(1)
        message = json.loads(json.loads(request.content)['messages'][-1]['content'])
        if message['focus'] == '模拟额度不足':
            return httpx.Response(429)
        if message['focus'] == '模拟慢响应':
            await asyncio.sleep(10)
        pairs = [('json.loads：解析字符串', '带 s 处理字符串', 'data = json.loads(text)'),
                 ('json.load：读取文件', '不带 s 读取文件对象', 'data = json.load(fp)'),
                 ('json.dumps：生成字符串', 'dumps 返回字符串', 'text = json.dumps(data)')]
        cards = [{"title": title, "summary": summary, "body": f'```python\n{code}\n```',
                  "tags": ['Python', 'JSON'], "source_ids": ['P1']}
                 for title, summary, code in pairs[:message['requested_count']]]
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"cards": cards}, ensure_ascii=False)}}],
                                        "usage": {"prompt_tokens": 120, "completion_tokens": 80, "total_tokens": 200}})

    # This fixture alone maps its own browser origin to the local API test origin.
    # Production host/origin checks and server configuration are unchanged.
    class FixtureOrigin:
        def __init__(self, app):
            self.app = app
        async def __call__(self, scope, receive, send):
            if scope['type'] == 'http':
                scope = {**scope, 'headers': [(key, b'http://127.0.0.1:8000' if key == b'origin' and value == b'http://127.0.0.1:8001' else value)
                                               for key, value in scope['headers']]}
            await self.app(scope, receive, send)

    with TemporaryDirectory(prefix='loredock-card-qa-') as temporary:
        app = create_app(Path(temporary), transport=httpx.MockTransport(upstream))
        app.state.store.save('simulation', ProviderInput(name='本机模拟验收（不消耗额度）', base_url='http://127.0.0.1:1/v1', default_model='simulated-cards'))
        app.add_middleware(FixtureOrigin)

        @app.get('/__test__/stats')
        async def stats():
            return {'upstream_calls': len(calls), 'simulated': True}

        app.mount('/', StaticFiles(directory=Path(__file__).resolve().parents[2] / 'frontend' / 'dist', html=True))
        uvicorn.run(app, host='127.0.0.1', port=8001, log_level='warning', access_log=False)


if __name__ == '__main__':
    main()
