import type { WorkspaceData } from './storage'
import type { KnowledgeCard } from './types'

/** Seed once, preserving an explicit empty collection and every existing field. */
export function ensureKnowledgeCards(workspace: WorkspaceData): WorkspaceData {
  if (workspace.knowledgeCards !== undefined) return workspace
  const targetSpace = workspace.spaces.find(space => space.id === 'python') ?? workspace.spaces[0]
  if (!targetSpace) return { ...workspace, knowledgeCards: [] }
  const createdAt = new Date().toISOString()
  const examples = [
    {
      key: 'load', title: 'json.load：读取 JSON 文件',
      summary: '从已打开的文件对象读取 JSON，转换成对应的 Python 对象。',
      body: [
        '# json.load：读取 JSON 文件', '',
        '`json.load(fp)` 接收可读取的文件对象，返回 JSON 对应的 Python 对象。JSON 可以表示对象、数组和其他 JSON 值。', '',
        '```python', 'import json', '',
        'with open("config.json", "r", encoding="utf-8") as fp:',
        '    config = json.load(fp)', '', 'print(config)', '```', '',
        '文件不存在、JSON 格式错误时会抛出异常，应根据实际业务处理。',
      ].join('\n'),
    },
    {
      key: 'loads', title: 'json.loads：解析 JSON 字符串',
      summary: '解析已有的 JSON 字符串，不需要先写入文件；也可接收 bytes 或 bytearray。',
      body: [
        '# json.loads：解析 JSON 字符串', '',
        '`json.loads(s)` 把 JSON 文本转换为对应的 Python 对象；常用于处理接口返回的文本。', '',
        '```python', 'import json', '',
        'payload = \'{"name": "学习笔记", "enabled": true, "topics": ["JSON", "Python"]}\'',
        'data = json.loads(payload)', '', 'print(data["name"])', 'print(data["enabled"])  # True', '```', '',
        'JSON 文本中的 `true`、`false`、`null` 分别对应 Python 的 `True`、`False`、`None`。',
      ].join('\n'),
    },
    {
      key: 'dump', title: 'json.dump：写入 JSON 文件',
      summary: '把可序列化的 Python 对象写入文件对象；函数返回 None。',
      body: [
        '# json.dump：写入 JSON 文件', '',
        '`json.dump(obj, fp)` 把支持 JSON 序列化的 Python 对象写入文件。`ensure_ascii=False` 保留可直接阅读的中文，`indent=2` 使用两空格缩进。', '',
        '```python', 'import json', '',
        'settings = {"name": "学习笔记", "enabled": True, "topics": ["JSON", "Python"]}', '',
        'with open("config.json", "w", encoding="utf-8") as fp:',
        '    json.dump(settings, fp, ensure_ascii=False, indent=2)', '```', '',
        '`"w"` 会覆盖原文件，修改重要配置前应保留原件。`dump` 不返回 JSON 字符串，需要字符串时使用 `dumps`。',
      ].join('\n'),
    },
    {
      key: 'dumps', title: 'json.dumps：生成 JSON 字符串',
      summary: '返回 JSON 格式的字符串，不会自动写入文件。',
      body: [
        '# json.dumps：生成 JSON 字符串', '',
        '`json.dumps(obj)` 把支持 JSON 序列化的 Python 对象转换成字符串，适合构造请求文本、日志或待保存内容。', '',
        '```python', 'import json', '',
        'settings = {"name": "学习笔记", "enabled": True, "topics": ["JSON", "Python"]}',
        'text = json.dumps(settings, ensure_ascii=False, indent=2)', '',
        'print(text)', 'print(type(text))  # <class \'str\'>', '```', '',
        '`dumps` 只负责生成字符串；如需落盘，可以另行写入，或直接使用 `json.dump`。',
      ].join('\n'),
    },
  ]
  const knowledgeCards: KnowledgeCard[] = examples.map(example => ({
    id: `example-json-${example.key}`, spaceId: targetSpace.id,
    title: example.title, summary: example.summary,
    body: `${example.body}\n\n[Python json 文档](https://docs.python.org/3/library/json.html)\n`,
    tags: ['Python', 'JSON', example.key], createdAt, updatedAt: createdAt, version: 1, isDemo: true,
  }))
  return { ...workspace, knowledgeCards }
}
