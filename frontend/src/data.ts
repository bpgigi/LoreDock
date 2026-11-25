import type { KnowledgeDocument, Space } from './types'

export const initialSpaces: Space[] = [
  { id: 'python', name: 'Python 与后端', description: '把学到的知识，变成下一次解决问题的底气。', icon: 'code', color: '#555555' },
  { id: 'ai', name: 'AI 与 Agent', description: '记录模型、检索和智能体的实践与取舍。', icon: 'sparkles', color: '#666666' },
  { id: 'game', name: '像素游戏开发', description: '整理玩法、地图与项目中的每一个决定。', icon: 'game', color: '#777777' },
  { id: 'printing', name: '3D 打印实践', description: '从材料说明到打印记录，积累可追溯的经验。', icon: 'printer', color: '#888888' },
]

export const initialDocuments: KnowledgeDocument[] = [
  { id: 'fastapi-errors', spaceId: 'python', title: 'FastAPI 开发实践', fileName: 'fastapi-practice.md', type: 'md', size: 4860, updatedAt: '2026-11-04T09:20:00+08:00', version: 1, status: 'available', isDemo: true, heading: '异常处理 / 统一错误响应', body: '# FastAPI 开发实践\n\n## 统一错误响应\n业务异常可以使用 HTTPException，明确返回 HTTP 状态码与可读错误信息。建议保持错误结构一致，例如 code、message 和 request_id，方便前端展示与问题追踪。\n\n## 异常处理器\n通过 exception_handler 为特定异常注册统一处理函数，避免每个路由重复编写相同的异常转换逻辑。\n\n## 安全日志\n日志记录请求标识和错误类别，不记录模型密钥、数据库密码或完整私人资料。' },
  { id: 'api-design', spaceId: 'python', title: '接口设计与状态码', fileName: 'api-design.md', type: 'md', size: 3240, updatedAt: '2026-11-03T16:40:00+08:00', version: 1, status: 'available', isDemo: true, heading: 'HTTP 状态码 / 常见错误', body: '# 接口设计与状态码\n\n## 常见错误\n400 表示请求内容不符合要求；404 表示资源不存在；409 表示资源状态冲突。外部服务不可用时返回清楚的错误提示，而不是把失败伪装成成功。\n\n## 前端处理\n失败时保留用户输入，解除提交按钮的禁用状态，并为可恢复的操作提供重试入口。\n\n## 请求追踪\n每个请求分配 request_id，并在响应与日志中保留相同标识。' },
  { id: 'python-notes', spaceId: 'python', title: 'Python 学习笔记', fileName: 'python-notes.md', type: 'md', size: 6150, updatedAt: '2026-11-02T14:10:00+08:00', version: 1, status: 'available', isDemo: true, heading: '异常与上下文管理', body: '# Python 学习笔记\n\n## 异常与上下文管理\n仅捕获能够处理的异常。使用 with 管理文件等资源，让异常路径也能正确释放资源。\n\n## 异步请求\n异步任务应保留自身上下文，不依赖界面当前选择。取消和超时需要明确处理。\n\n## 模块职责\n按业务职责拆分代码，避免一个文件同时承担所有功能。' },
  { id: 'rag-notes', spaceId: 'ai', title: 'RAG 实践记录', fileName: 'rag-practice.md', type: 'md', size: 5200, updatedAt: '2026-11-03T10:00:00+08:00', version: 1, status: 'available', isDemo: true, heading: '检索范围 / 引用校验', body: '# RAG 实践记录\n\n## 检索范围\n检索默认限制在当前知识空间。跨空间搜索需要用户主动选择，后端应对本次范围做实际过滤。\n\n## 引用校验\n引用只能指向本轮实际召回的片段。引用标识有效并不代表内容能支持结论，评估时需要分别核对。\n\n## 版本更新\n更换嵌入模型后重建向量索引，并重新评估阈值。' },
  { id: 'agent-design', spaceId: 'ai', title: 'Agent 设计备忘', fileName: 'agent-design.txt', type: 'txt', size: 2150, updatedAt: '2026-11-01T11:30:00+08:00', version: 1, status: 'available', isDemo: true, heading: '工具与资料边界', body: 'Agent 设计备忘\n\n工具调用应有清晰的参数边界。检索资料与模型生成内容都作为数据处理，不能覆盖系统指令。\n\n对不确定事项说明未知；建议需要明确标记，不把生成内容自动当成用户决定。' },
  { id: 'game-rules', spaceId: 'game', title: '回合流程草案', fileName: 'turn-flow.md', type: 'md', size: 1840, updatedAt: '2026-11-02T15:00:00+08:00', version: 1, status: 'available', isDemo: true, heading: '回合结算 / 待确认事项', body: '# 回合流程草案\n\n## 回合结算\n草案记录：行动结束后检查格子事件，再进入结算。\n\n## 待确认事项\n地图岔路如何选择仍未决定。本资料没有确定岔路规则，不能把建议当成已有方案。' },
]

export const EXAMPLE_QUESTION = 'FastAPI 中如何统一处理异常？'
export const DEMO_STORAGE_KEY = 'loredock-ui-preview-v1'
