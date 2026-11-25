"""Isolated UI fixture: python -m backend.tests.card_workshop_preview.

Open http://127.0.0.1:8004/__test__/seed to create disposable sample data.
This process only uses temporary databases and simulated model responses.
"""
import asyncio
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import uvicorn
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from backend.app import create_app
from backend.schemas import ProviderInput


def main():
    calls = []
    controls = {'fail_next': False, 'slow_next': False}
    text = '# JSON 学习样例\n\n仅用于独立验收，不是正式笔记。\n\n## 读取字符串\n\njson.loads 把 JSON 字符串解析成 Python 对象。\n\n```python\nimport json\nvalue = json.loads(\'{"name": "示例"}\')\n```\n\n## 读取文件\n\njson.load 从文件对象读取 JSON。\n\n```python\nwith open("example.json", encoding="utf-8") as fp:\n    value = json.load(fp)\n```\n\n## 写出字符串\n\njson.dumps 把 Python 对象转换为 JSON 字符串。\n'
    documents = [{'id': identity, 'spaceId': 'learn', 'title': title, 'fileName': title + '.md', 'type': 'md', 'size': len(body.encode()), 'updatedAt': '2026-11-13T00:00:00Z', 'version': 3, 'status': 'available', 'body': body, 'heading': '正文', 'isDemo': False}
                 for identity, title, body in [('qa-json', 'JSON 学习样例', text), ('qa-other', '隔离验证样例', '# 另一个文档\n\n这篇文档不应收到前一篇迟到的卡片草稿。\n')]]
    workspace = {'spaces': [{'id': 'learn', 'name': '卡片独立验收', 'description': '模拟数据', 'icon': 'code', 'color': '#667767'}],
                 'documents': documents, 'conversations': [{'id': 'qa-chat', 'spaceId': 'learn', 'title': '验收问答', 'messages': [], 'createdAt': '2026-11-13T00:00:00Z'}],
                 'selectedSpaceId': 'learn', 'selectedConversationId': 'qa-chat', 'knowledgeCards': [
                     {'id': 'qa-existing', 'spaceId': 'learn', 'title': 'JSON 原有示例卡', 'summary': 'json.loads 字符串解析', 'body': '已有卡片哨兵，不可覆盖。', 'tags': ['JSON'], 'createdAt': '2026-11-13T00:00:00Z', 'updatedAt': '2026-11-13T00:00:00Z', 'version': 1}],
                 'aiPreference': {'providerId': 'simulation', 'model': 'simulated-cards'}}

    async def upstream(request):
        if request.url.path.endswith('/models'):
            return httpx.Response(200, json={'data': [{'id': 'simulated-cards'}]})
        payload = json.loads(request.content)
        user = json.loads(payload['messages'][-1]['content'])
        kind = 'revise' if 'drafts' in user else 'generate' if 'requested_count' in user else 'chat'
        calls.append({'kind': kind, 'input': user, 'history': payload['messages'][1:-1], 'reasoning_effort': payload.get('reasoning_effort')})
        if controls['slow_next']:
            controls['slow_next'] = False
            await asyncio.sleep(15)
        if controls['fail_next']:
            controls['fail_next'] = False
            return httpx.Response(429)
        if kind == 'revise':
            drafts = user['drafts']
            targets = drafts if '合并' in user['instructions'] else drafts[:1]
            first = targets[0]
            body = '\n\n'.join(item['body'] for item in targets) if len(targets) > 1 else first['body']
            if '简短' in user['instructions']:
                body = '精简后：json.loads 用于 JSON 字符串。'
            if '代码' in user['instructions']:
                body += '\n\nAI 补充示例：\n```python\nimport json\nvalue = json.loads(\'{"ok": true}\')\n```'
            content = {'operations': [{'target_ids': [item['id'] for item in targets], 'card': {'title': first['title'] + ('（合并）' if len(targets) > 1 else ''), 'summary': '模拟修改记法', 'body': body, 'tags': ['JSON']}}]}
        elif kind == 'generate':
            passages = user['source_passages']
            content = {'cards': [{'title': f'JSON 知识点 {index + 1}', 'summary': '模拟草稿，等待人工核对', 'body': '本机模拟生成。\n\n' + passages[0]['text'], 'tags': ['JSON'], 'source_ids': [passages[0]['id']]} for index in range(min(user['requested_count'], 3))]}
        else:
            content = {'answer': '这是独立模拟问答，未接收本地卡片。' + ('\n\n参考当前文章 [S1]。' if user['source_passages'] else ''), 'citation_ids': ['S1'] if user['source_passages'] else []}
        return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(content, ensure_ascii=False)}}]})

    class FixtureOrigin:
        def __init__(self, app):
            self.app = app
        async def __call__(self, scope, receive, send):
            if scope['type'] == 'http':
                scope = {**scope, 'headers': [(key, b'http://127.0.0.1:8000' if key == b'origin' and value == b'http://127.0.0.1:8004' else value) for key, value in scope['headers']]}
            await self.app(scope, receive, send)

    with TemporaryDirectory(prefix='loredock-workshop-qa-') as temporary:
        app = create_app(Path(temporary), transport=httpx.MockTransport(upstream))
        app.state.store.save('simulation', ProviderInput(name='独立卡片模拟（不消耗额度）', base_url='http://127.0.0.1:1/v1', default_model='simulated-cards'))
        app.add_middleware(FixtureOrigin)

        @app.get('/__test__/seed', response_class=HTMLResponse)
        async def seed():
            value = json.dumps(workspace, ensure_ascii=False).replace('<', '\\u003c')
            return '<!doctype html><meta charset="utf-8"><h1>正在准备独立验收数据</h1><script>const r=indexedDB.open("loredock-ui-preview",1);r.onupgradeneeded=()=>r.result.createObjectStore("workspace");r.onsuccess=()=>{const t=r.result.transaction("workspace","readwrite"),s=t.objectStore("workspace");s.clear();s.put(' + value + ',"current");t.oncomplete=()=>{r.result.close();location.href="/"}};</script>'

        @app.get('/__test__/inspect', response_class=HTMLResponse)
        async def inspect():
            return '''<!doctype html><meta charset="utf-8"><a href="/">返回应用</a><pre id="output"></pre><script>
const r=indexedDB.open('loredock-ui-preview',1); r.onsuccess=()=>{const t=r.result.transaction('workspace','readonly'),q=t.objectStore('workspace').get('current');q.onsuccess=async()=>{const w=q.result; const docs=await Promise.all(w.documents.map(async d=>({id:d.id,version:d.version,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(d.body)))).map(b=>b.toString(16).padStart(2,'0')).join('')}))); document.querySelector('#output').textContent=JSON.stringify({documents:docs,cards:w.knowledgeCards},null,2);};};</script>'''

        @app.get('/__test__/stats')
        async def stats():
            return {'calls': calls, 'original_hashes': {doc['id']: hashlib.sha256(doc['body'].encode()).hexdigest() for doc in documents}, 'simulated': True}

        @app.post('/__test__/control')
        async def control(value: dict):
            controls.update({key: bool(value[key]) for key in controls if key in value})
            return controls

        app.mount('/', StaticFiles(directory=Path(__file__).resolve().parents[2] / 'frontend/dist', html=True))
        uvicorn.run(app, host='127.0.0.1', port=8004, log_level='warning', access_log=False)


if __name__ == '__main__':
    main()
