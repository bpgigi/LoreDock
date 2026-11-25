"""Run from project root: python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000."""

import asyncio
import os
import re
import sqlite3
import hashlib
import time
from collections import OrderedDict
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .context import build_messages, select_context, verify_answer
from .note_imports import NoteImportCatalog, NoteImportNotFound, NoteImportUnavailable
from .provider import ProviderError, completion_payload, provider_request
from .schemas import ChatInput, ChatOutput, ModelListInput, ProviderInput, ProviderSummary
from .store import ProviderStore, SecretStorageError
from .library import LibraryError, LibraryStore
from .library_api import indexed_context, library_router
from .card_generation import CardGenerationInput, CardRevisionInput, generation_context, generation_messages, generation_usage, parse_generated_cards, revision_messages, parse_revised_cards


class LocalBoundaryMiddleware:
    """Block cross-site writes/reads and oversized bodies before JSON validation."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        host = headers.get(b"host", b"").decode("latin1")
        allowed_hosts = {"127.0.0.1", "localhost", "[::1]"}
        hostname = host.rsplit(":", 1)[0] if ":" in host and not host.endswith("]") else host
        origin = headers.get(b"origin", b"").decode("latin1")
        allowed_origins = {f"http://{name}:{port}" for name in allowed_hosts for port in (5173, 8000)}
        if hostname not in allowed_hosts or (origin and origin not in allowed_origins):
            await JSONResponse({"detail": "只允许本机 LoreDock 页面访问此服务。"}, 403)(scope, receive, send)
            return
        max_bytes = 24 * 1024 * 1024
        try:
            if int(headers.get(b"content-length", b"0")) > max_bytes:
                raise ValueError
        except ValueError:
            await JSONResponse({"detail": "请求体过大，请缩小资料范围。"}, 413)(scope, receive, send)
            return
        chunks = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            total += len(message.get("body", b""))
            if total > max_bytes:
                await JSONResponse({"detail": "请求体过大，请缩小资料范围。"}, 413)(scope, receive, send)
                return
            chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                break
        replayed = False

        async def replay_receive():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, replay_receive, send)


async def cancellable_provider_call(request: Request, coroutine):
    operation = asyncio.create_task(coroutine)

    async def disconnected():
        while True:
            if await request.is_disconnected():
                return
            await asyncio.sleep(.2)

    watcher = asyncio.create_task(disconnected())
    try:
        finished, _ = await asyncio.wait({operation, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if watcher in finished and not operation.done():
            operation.cancel()
            raise HTTPException(499, "请求已取消。")
        return await operation
    finally:
        watcher.cancel()
        if not operation.done():
            operation.cancel()
        with suppress(asyncio.CancelledError):
            await watcher
        with suppress(asyncio.CancelledError):
            await operation


def create_app(data_dir: Path | None = None, *, transport=None, protector=None) -> FastAPI:
    directory = data_dir or Path(os.environ.get("LOREDOCK_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
    store = ProviderStore(directory, protector)
    note_imports = NoteImportCatalog(directory)
    library = LibraryStore(directory)
    try:
        timeout = max(1.0, min(float(os.environ.get("LOREDOCK_MODEL_TIMEOUT", "60")), 300.0))
        context_chars = max(3200, min(int(os.environ.get("LOREDOCK_CONTEXT_CHARS", "24000")), 120000))
    except ValueError:
        raise RuntimeError("LOREDOCK_MODEL_TIMEOUT / LOREDOCK_CONTEXT_CHARS 必须为有效数值。") from None

    explicit_timeout = "LOREDOCK_MODEL_TIMEOUT" in os.environ

    def generation_timeout(reasoning_effort):
        # Deeper requests get time to finish unless the user configured a limit.
        return timeout if explicit_timeout else max(timeout, {"high": 180, "xhigh": 300}.get(reasoning_effort, 60))

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False,
                                     transport=transport) as client:
            application.state.http = client
            yield

    api = FastAPI(title="LoreDock local API", lifespan=lifespan, docs_url="/api/docs", redoc_url=None)
    api.state.store = store
    api.state.library = library
    api.state.active_requests = set()
    card_results = OrderedDict()
    api.add_middleware(LocalBoundaryMiddleware)
    api.include_router(library_router(library))

    @api.exception_handler(LibraryError)
    async def library_error(_request, error):
        return JSONResponse({"detail": error.message}, error.status)

    @api.exception_handler(RequestValidationError)
    async def validation_error(_request, _error):
        # FastAPI's default input field can echo API keys; deliberately omit all input values.
        return JSONResponse({"detail": "填写内容不符合要求，请检查必填项、接口地址及资料大小。"}, 422)

    @api.exception_handler(SecretStorageError)
    async def secret_error(_request, error):
        return JSONResponse({"detail": str(error)}, 503)

    @api.exception_handler(sqlite3.Error)
    async def database_error(_request, _error):
        return JSONResponse({"detail": "本机数据无法读写，请检查数据目录是否可用。"}, 503)

    @api.exception_handler(ProviderError)
    async def upstream_error(_request, error):
        return JSONResponse({"detail": error.message}, error.status)

    @api.exception_handler(NoteImportNotFound)
    async def missing_note_import(_request, _error):
        return JSONResponse({"detail": "未找到该待导入笔记包。"}, 404)

    @api.exception_handler(NoteImportUnavailable)
    async def unavailable_note_import(_request, _error):
        return JSONResponse({"detail": "本机笔记包无法读取或校验未通过，请重新准备笔记包。"}, 503)

    def provider(provider_id: str):
        row = store.get(provider_id)
        if row is None:
            raise HTTPException(404, "该模型服务不存在，请先保存配置。")
        return row

    @api.get("/api/health")
    async def health():
        return {"status": "ok", "mode": "keyword-index", "key_storage": "windows-dpapi"}

    @api.get("/api/providers")
    async def providers():
        return {"providers": store.list()}

    @api.get("/api/note-imports")
    def list_note_imports():
        return {"imports": note_imports.list()}

    @api.get("/api/note-imports/{import_id}")
    def get_note_import(import_id: str):
        return note_imports.get(import_id)

    @api.put("/api/providers/{provider_id}", response_model=ProviderSummary)
    async def save_provider(provider_id: str, config: ProviderInput):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", provider_id):
            raise HTTPException(400, "服务标识无效。")
        return store.save(provider_id, config)

    @api.delete("/api/providers/{provider_id}")
    async def delete_provider(provider_id: str):
        if not store.delete(provider_id):
            raise HTTPException(404, "该模型服务不存在。")
        return {"deleted": True}

    @api.post("/api/providers/{provider_id}/models")
    async def models(provider_id: str, _payload: ModelListInput, request: Request):
        row = provider(provider_id)
        data = await cancellable_provider_call(request, provider_request(
            request.app.state.http, "GET", row["base_url"], store.credential(row), "models", timeout=timeout))
        entries = data.get("data")
        if not isinstance(entries, list):
            raise ProviderError(502, "该服务未返回兼容的模型列表，可以手动填写模型名称。")
        ids = sorted({item["id"] for item in entries[:5000] if isinstance(item, dict)
                      and isinstance(item.get("id"), str) and 0 < len(item["id"]) <= 200})
        return {"models": ids[:2000]}

    @api.post("/api/chat", response_model=ChatOutput)
    async def chat(payload: ChatInput, request: Request):
        row = provider(payload.provider_id)
        identity = (payload.session_id, payload.request_id)
        if identity in api.state.active_requests:
            raise HTTPException(409, "此请求正在处理中，请勿重复提交。")
        # Reserve before awaiting retrieval so concurrent duplicate IDs cannot race.
        api.state.active_requests.add(identity)
        try:
            # Card suggestions are local UI links, never model evidence. Older
            # clients may still send cards; ignore them without bypassing documents.
            context = {}
            if payload.retrieval_mode == "none":
                note = ""
            elif payload.retrieval_mode == "indexed":
                context, note = await run_in_threadpool(indexed_context, library, payload.scope_ids,
                    payload.question, payload.document_id, payload.document_versions, context_chars)
            else:
                context, note = select_context(payload, context_chars)
        except BaseException:
            api.state.active_requests.discard(identity)
            raise
        common = {"session_id": payload.session_id, "request_id": payload.request_id,
                  "model": payload.model, "provider_name": row["name"]}
        if not context and payload.answer_mode == "grounded":
            api.state.active_requests.discard(identity)
            empty_body = ("未找到与问题匹配的资料片段，暂时无法依据资料回答。请使用笔记中的关键词重试。"
                          if payload.retrieval_mode == "indexed" else
                          "当前范围内没有可用资料，无法依据资料回答。请先上传或选择一份文档。")
            return ChatOutput(**common, body=empty_body,
                              citations=[], context_note=note)
        try:
            key = store.credential(row)
            data = await cancellable_provider_call(request, provider_request(
                request.app.state.http, "POST", row["base_url"], key, "chat/completions",
                completion_payload(payload.model, build_messages(payload, context), payload.reasoning_effort),
                timeout=generation_timeout(payload.reasoning_effort)))
            try:
                content = data["choices"][0]["message"]["content"]
                if not isinstance(content, str) or not content.strip() or len(content) > 100000:
                    raise ValueError
            except (KeyError, IndexError, TypeError, ValueError):
                raise ProviderError(502, "模型未返回可读取的文本，请确认所选模型支持文本 Chat Completions。") from None
            if key:
                content = content.replace(key, "[已隐藏密钥]")
            body, citations = verify_answer(content, context, strict=payload.answer_mode == "grounded")
            if payload.answer_mode == "grounded":
                note += "引用标识已校验；内容是否支持结论仍需对照原文。"
            elif not context:
                note = ("已附带选文与附近原文，未找到其他匹配资料。" if payload.reading_selection else "未匹配到相关资料，本轮由 AI 直接回答。") if payload.retrieval_mode != "none" else ""
            return ChatOutput(**common, body=body, citations=citations, context_note=note)
        finally:
            api.state.active_requests.discard(identity)

    @api.post("/api/cards/generate")
    async def generate_cards(payload: CardGenerationInput, request: Request):
        return await card_request(payload, request)

    @api.post("/api/cards/revise")
    async def revise_cards(payload: CardRevisionInput, request: Request):
        return await card_request(payload, request)

    async def card_request(payload: CardGenerationInput | CardRevisionInput, request: Request):
        revising = isinstance(payload, CardRevisionInput)
        identity = ("card-revision" if revising else "cards", payload.session_id, payload.request_id)
        fingerprint = hashlib.sha256(payload.model_dump_json().encode("utf-8")).hexdigest()
        # Bound private draft snapshots in memory. Replayed successful/failed requests
        # within this window do not repeat a potentially billable upstream call.
        while card_results and next(iter(card_results.values()))[0] < time.monotonic() - 900:
            card_results.popitem(last=False)
        cached = card_results.get(identity)
        if cached:
            _, previous, result, error = cached
            if previous != fingerprint:
                raise HTTPException(409, "请求标识已使用，请重新发起生成。")
            if error:
                raise HTTPException(*error)
            return result
        if identity in api.state.active_requests:
            raise HTTPException(409, "卡片正在生成中，请勿重复提交。")
        row = provider(payload.provider_id)
        api.state.active_requests.add(identity)
        result = error = None
        try:
            key = store.credential(row)
            context = {} if revising else generation_context(payload.text)
            data = await cancellable_provider_call(request, provider_request(
                request.app.state.http, "POST", row["base_url"], key, "chat/completions",
                completion_payload(payload.model.strip(), revision_messages(payload) if revising else generation_messages(payload, context), payload.reasoning_effort),
                timeout=generation_timeout(payload.reasoning_effort)))
            result = {"session_id": payload.session_id, "request_id": payload.request_id,
                      "model": payload.model.strip(), "provider_name": row["name"], "reasoning_effort": payload.reasoning_effort,
                      **({"revision": payload.revision, "operations": parse_revised_cards(data, payload, key)} if revising
                         else {"cards": parse_generated_cards(data, context, payload.count, key)}),
                      "usage": generation_usage(data)}
            return result
        except ProviderError as exc:
            error = (exc.status, exc.message)
            raise
        except HTTPException as exc:
            error = (exc.status_code, exc.detail)
            raise
        except asyncio.CancelledError:
            error = (499, "生成已取消；服务商已受理的请求仍可能消耗额度。")
            raise
        finally:
            api.state.active_requests.discard(identity)
            if result is not None or error is not None:
                card_results[identity] = (time.monotonic(), fingerprint, result, error)
                if len(card_results) > 128:
                    card_results.popitem(last=False)

    return api


app = create_app()
