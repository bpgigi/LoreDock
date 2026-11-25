"""Isolated UI polish fixture; no real keys, workspaces, or model requests.

Build the frontend, then run from the project root:
    .venv/Scripts/python.exe -m backend.tests.ui_polish_preview
Open http://127.0.0.1:8005/__test__/seed once. Revisiting preserves this origin's
existing workspace. /__test__/stats reports mock calls and library mutations.
Stop with Ctrl+C. All server databases live in a temporary directory.
"""
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import uvicorn
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from backend.schemas import ProviderInput


COPY_ANSWER = '''## JSON 的四个常用操作

| 操作 | 输入 | 返回值 | 使用场景 |
| --- | --- | --- | --- |
| `json.loads` | JSON 字符串 | Python 对象 | 解析接口返回的文本 |
| `json.load` | 文件对象 | Python 对象 | 读取本地配置文件 |
| `json.dumps` | Python 对象 | JSON 字符串 | 准备需要发送的请求内容 |
| `json.dump` | Python 对象与文件对象 | 无返回值 | 保存配置到文件 |

```python
import json

text = '{"name": "小舟", "ready": true}'
value = json.loads(text)
print(value["name"])
```

- [x] 字符串操作带 `s`
- [ ] 文件操作需要文件对象

这是一段原创模拟回答，用于检查表格、代码与 Markdown 复制。'''


def sample_workspace():
    spaces = [
        {'id': 'qa-python', 'name': 'Python 学习', 'description': '原创界面验收示例', 'icon': 'code', 'color': '#6c86ad'},
        {'id': 'qa-notes', 'name': '日常笔记', 'description': '用于跨空间与空资料列表验收', 'icon': 'sparkles', 'color': '#8c7aa8'},
    ]
    documents = []
    for identity, title, order, day, status, body in [
        ('qa-files', '文件与字符串', 2, 13, 'available', '# 文件与字符串\n\n## 字符串\n\n使用 json.loads 解析 JSON 字符串。\n\n```python\nimport json\nvalue = json.loads(\'{"ok": true}\')\n```\n\n## 文件\n\n使用 json.load 读取文件对象。'),
        ('qa-errors', '接口错误处理', 1, 11, 'available', '# 接口错误处理\n\n## 保留输入\n\n请求失败后保留问题，方便用户修改或重试。\n\n## 明确反馈\n\n| 情况 | 提示 |\n| --- | --- |\n| 等待中 | 正在处理 |\n| 已取消 | 可以重新发送 |'),
        ('qa-failed', '等待重试的示例', 3, 14, 'failed', '# 等待重试的示例\n\n这是独立验收数据，用来检查状态筛选与重试入口。'),
    ]:
        document = {'id': identity, 'spaceId': 'qa-python', 'title': title, 'fileName': f'{order:02d}_{title}.md',
                    'type': 'md', 'size': len(body.encode('utf-8')), 'updatedAt': f'2026-11-{day:02d}T08:00:00Z',
                    'version': 1, 'status': status, 'body': body, 'heading': '正文', 'isDemo': True, 'order': order,
                    'studyGroup': '基础练习'}
        if status == 'failed':
            document['failureReason'] = '模拟读取失败，未涉及真实文件。'
        documents.append(document)

    cards = []
    for index, (space_id, title, summary, tags) in enumerate([
        ('qa-python', 'json.loads：解析字符串', '带 s 的 loads 接收字符串', ['Python', 'JSON', '验收']),
        ('qa-python', 'json.load：读取文件', '没有 s 的 load 接收文件对象', ['Python', 'JSON', '验收']),
        ('qa-python', '接口失败时保留输入', '先保留问题，再让用户明确重试', ['Python', '接口', '验收']),
        ('qa-notes', '每天整理一个知识点', '把结论写短，把原文留作核对', ['学习', '验收']),
    ], start=1):
        cards.append({'id': f'qa-card-{index}', 'spaceId': space_id, 'title': title, 'summary': summary,
                      'body': f'## {title}\n\n{summary}。\n\n这是原创界面验收卡片，可在独立工作区中编辑。',
                      'tags': tags, 'version': 1, 'isDemo': True,
                      'createdAt': f'2026-11-{index + 5:02d}T08:00:00Z',
                      'updatedAt': f'2026-11-{15 - index:02d}T08:00:00Z'})

    conversations = []
    titles = ['最早的离线阅读约定', '异常提示怎样写', '整理笔记的顺序', '给函数起一个名字',
              '比较两种输入方式', '解释文件对象', '怎样保留原文', 'JSON 操作对照表']
    for index, title in enumerate(titles, start=1):
        created = f'2026-11-{index + 5:02d}T09:00:00Z'
        answer = COPY_ANSWER if index == 8 else f'这是第 {index} 条原创模拟回答：{title}。用于验证历史搜索和对话切换。'
        messages = [{'id': f'qa-message-{index}-{role}', 'role': role, 'body': text,
                     'scopeIds': ['qa-python'], 'citations': [], 'createdAt': created,
                     'status': 'completed', 'isDemo': False, 'referenceDocuments': False}
                    for role, text in [('user', title), ('assistant', answer)]]
        conversations.append({'id': f'qa-conversation-{index}', 'spaceId': 'qa-python', 'title': title,
                              'messages': messages, 'createdAt': created, 'referenceDocuments': False})
    return {'spaces': spaces, 'documents': documents, 'knowledgeCards': cards,
            'conversations': list(reversed(conversations)), 'selectedSpaceId': 'qa-python',
            'selectedConversationId': 'qa-conversation-8', 'importedBatchIds': [],
            'aiPreference': {'providerId': 'simulation', 'model': 'simulated-polish'}}


def create_preview(directory: Path):
    # backend.app also constructs a default app on its first import. Route even
    # that initialization to this fixture directory, never the normal data dir.
    previous_directory = os.environ.get('LOREDOCK_DATA_DIR')
    os.environ['LOREDOCK_DATA_DIR'] = str(directory)
    try:
        from backend.app import create_app
    finally:
        if previous_directory is None:
            os.environ.pop('LOREDOCK_DATA_DIR', None)
        else:
            os.environ['LOREDOCK_DATA_DIR'] = previous_directory

    workspace = sample_workspace()
    model_calls = []
    model_list_calls = []
    api_requests = []
    library_writes = []

    async def upstream(request):
        if request.url.path.endswith('/models'):
            model_list_calls.append(1)
            return httpx.Response(200, json={'data': [{'id': 'simulated-polish'}]})
        payload = json.loads(request.content)
        model_calls.append({'model': payload.get('model'), 'request_fields': sorted(payload)})
        content = {'answer': COPY_ANSWER, 'citation_ids': []}
        return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {
            'content': json.dumps(content, ensure_ascii=False)}}]})

    app = create_app(directory, transport=httpx.MockTransport(upstream))
    app.state.store.save('simulation', ProviderInput(name='界面模拟（不消耗额度）',
                         base_url='http://127.0.0.1:1/v1', default_model='simulated-polish'))

    class FixtureOrigin:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope['type'] == 'http':
                path, method = scope['path'], scope['method']
                if path.startswith('/api/'):
                    api_requests.append({'method': method, 'path': path})
                if path.startswith('/api/library/') and (method in {'PUT', 'PATCH', 'DELETE'} or path.endswith('/retire') and method == 'POST'):
                    library_writes.append({'method': method, 'path': path})
                scope = {**scope, 'headers': [(key, b'http://127.0.0.1:8000'
                         if key == b'origin' and value == b'http://127.0.0.1:8005' else value)
                         for key, value in scope['headers']]}
            await self.app(scope, receive, send)

    app.add_middleware(FixtureOrigin)

    @app.get('/__test__/seed', response_class=HTMLResponse)
    async def seed():
        value = json.dumps(workspace, ensure_ascii=False).replace('<', '\\u003c')
        return '''<!doctype html><meta charset="utf-8"><title>LoreDock 独立界面验收</title>
<h1 id="status">正在打开独立验收工作区</h1><script>
const seedData = ''' + value + ''';
const seedStatus = document.querySelector('#status');
const request = indexedDB.open('loredock-ui-preview', 1);
request.onupgradeneeded = () => {
  if (!request.result.objectStoreNames.contains('workspace')) request.result.createObjectStore('workspace');
};
request.onerror = () => { seedStatus.textContent = '无法打开独立存储，请关闭旧验收页面后重试。'; };
request.onblocked = () => { seedStatus.textContent = '存储被占用，请关闭旧验收页面后重试。'; };
request.onsuccess = () => {
  const db = request.result;
  const tx = db.transaction('workspace', 'readwrite');
  const store = tx.objectStore('workspace');
  const current = store.get('current');
  current.onsuccess = () => { if (current.result === undefined) store.put(seedData, 'current'); };
  tx.oncomplete = () => { db.close(); location.replace('/'); };
  tx.onabort = () => { db.close(); seedStatus.textContent = '准备失败，已有验收数据未被覆盖。'; };
};
</script>'''

    @app.get('/__test__/stats')
    async def stats():
        return {'simulated': True, 'model_calls': len(model_calls), 'model_requests': model_calls,
                'model_list_calls': len(model_list_calls), 'library_write_requests': library_writes,
                'library': app.state.library.status(), 'api_requests': api_requests,
                'seed_counts': {key: len(workspace[key]) for key in ('spaces', 'documents', 'knowledgeCards', 'conversations')},
                'original_document_hashes': {doc['id']: hashlib.sha256(doc['body'].encode()).hexdigest() for doc in workspace['documents']},
                'expected_copy_answer': COPY_ANSWER}

    app.mount('/', StaticFiles(directory=Path(__file__).resolve().parents[2] / 'frontend/dist', html=True))
    return app


def main():
    with TemporaryDirectory(prefix='loredock-ui-polish-qa-') as temporary:
        app = create_preview(Path(temporary))
        uvicorn.run(app, host='127.0.0.1', port=8005, log_level='warning', access_log=False)


if __name__ == '__main__':
    main()
