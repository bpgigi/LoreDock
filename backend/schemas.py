from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_FILE_BYTES = 20 * 1024 * 1024


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def validate_base_url(value: str) -> str:
    try:
        url = urlsplit(value.strip())
        port = url.port  # Reject invalid port syntax.
    except ValueError:
        raise ValueError("接口地址格式无效") from None
    if not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("接口地址需为不含凭据、查询或片段的完整地址")
    if url.scheme != "https" and not (
        url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        raise ValueError("远程接口需使用 HTTPS；HTTP 仅允许本机地址")
    if port is not None and not 0 < port <= 65535:
        raise ValueError("接口端口无效")
    return urlunsplit((url.scheme, url.netloc, url.path.rstrip("/"), "", ""))


class ProviderInput(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    base_url: str = Field(min_length=1, max_length=500)
    default_model: str = Field(default="", max_length=200)
    api_key: str | None = Field(default=None, max_length=8192, repr=False)
    clear_api_key: bool = False

    @field_validator("base_url")
    @classmethod
    def check_base_url(cls, value: str) -> str:
        return validate_base_url(value)

    @field_validator("name", "default_model")
    @classmethod
    def clean_text(cls, value: str) -> str:
        value = value.strip()
        if "\n" in value or "\r" in value or "\x00" in value:
            raise ValueError("请填写单行文本")
        return value

    @field_validator("api_key")
    @classmethod
    def clean_key(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip()
        if any(ord(char) <= 32 or ord(char) > 126 for char in value):
            raise ValueError("API Key 不能包含空格、换行或非 ASCII 字符")
        return value

    @model_validator(mode="after")
    def require_name(self):
        if not self.name:
            raise ValueError("请填写服务名称")
        return self


class ProviderSummary(StrictModel):
    id: str
    name: str
    base_url: str
    default_model: str
    has_api_key: bool
    key_hint: str


class ModelListInput(StrictModel):
    model: str | None = Field(default=None, max_length=200)


class ContextDocument(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    space_id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(max_length=MAX_FILE_BYTES)
    version: int = Field(ge=1)
    heading: str = Field(default="", max_length=500)

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        try:
            size = len(value.encode("utf-8"))
        except UnicodeError:
            raise ValueError("资料正文必须为有效 UTF-8 文本") from None
        if size > MAX_FILE_BYTES:
            raise ValueError("单份资料超过 20 MiB")
        if "\x00" in value:
            raise ValueError("资料正文必须为有效文本")
        return value


class HistoryMessage(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class ContextCard(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    space_id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(min_length=1, max_length=6000)
    version: int = Field(ge=1)
    is_ai_draft: bool = False


class ReadingSelection(StrictModel):
    documentId: str = Field(min_length=1, max_length=128)
    spaceId: str = Field(min_length=1, max_length=128)
    version: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=240)
    heading: str = Field(max_length=500)
    text: str = Field(min_length=1, max_length=2000)
    context: str = Field(min_length=1, max_length=5000)
    isDraft: bool = False
    isHistorical: bool = False
    truncated: bool = False

    @field_validator("text", "context")
    @classmethod
    def readable_text(cls, value: str) -> str:
        if not value.strip() or "\x00" in value:
            raise ValueError("选文和附近原文必须为有效文本")
        try:
            value.encode("utf-8")
        except UnicodeError:
            raise ValueError("选文必须为有效 UTF-8 文本") from None
        return value


ReasoningEffort = Literal["low", "medium", "high", "xhigh"]


class ChatInput(StrictModel):
    session_id: str = Field(min_length=1, max_length=128)
    request_id: str = Field(min_length=1, max_length=128)
    provider_id: str = Field(min_length=1, max_length=128)
    model: str = Field(min_length=1, max_length=200)
    question: str = Field(min_length=1, max_length=4000)
    scope_ids: list[str] = Field(min_length=1, max_length=100)
    document_id: str | None = Field(default=None, min_length=1, max_length=128)
    documents: list[ContextDocument] = Field(default_factory=list, max_length=500)
    history: list[HistoryMessage] = Field(default_factory=list, max_length=20)
    # Legacy clients retain their strict, document-based behavior. The current UI
    # explicitly chooses assistant mode, with document lookup independently optional.
    answer_mode: Literal["assistant", "grounded"] = "grounded"
    retrieval_mode: Literal["none", "snapshot", "indexed"] = "snapshot"
    # Accepted only for old clients. Chat never forwards card content to a model.
    cards: list[ContextCard] = Field(default_factory=list, max_length=4)
    document_versions: dict[str, int] = Field(default_factory=dict, max_length=500)
    reading_selection: ReadingSelection | None = None
    reasoning_effort: ReasoningEffort | None = None

    @field_validator("document_versions")
    @classmethod
    def check_versions(cls, value: dict[str, int]) -> dict[str, int]:
        if any(not key or len(key) > 128 or version < 1 for key, version in value.items()):
            raise ValueError("资料版本范围无效")
        return value

    @field_validator("scope_ids")
    @classmethod
    def check_scope(cls, value: list[str]) -> list[str]:
        if any(not scope or len(scope) > 128 for scope in value):
            raise ValueError("空间标识无效")
        return list(dict.fromkeys(value))

    @field_validator("question", "model")
    @classmethod
    def strip_required(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("该项不能为空")
        return value.strip()

    @model_validator(mode="after")
    def check_total(self):
        if self.reading_selection:
            if self.answer_mode != "assistant":
                raise ValueError("选文问答需使用普通 AI 模式")
            if self.reading_selection.documentId != self.document_id or self.reading_selection.spaceId not in self.scope_ids:
                raise ValueError("选文必须属于当前阅读文档和本轮空间")
        if self.retrieval_mode == "none" and (self.documents or self.document_versions):
            raise ValueError("未开启资料参考时不能提交文档正文或版本范围")
        if len({card.id for card in self.cards}) != len(self.cards):
            raise ValueError("卡片标识不能重复")
        if sum(len(card.body) for card in self.cards) > 12000:
            raise ValueError("本轮卡片内容超过 12000 字符")
        if self.retrieval_mode == "indexed" and self.documents:
            raise ValueError("索引检索只提交资料版本，不能同时提交正文快照")
        if sum(len(doc.body.encode("utf-8")) for doc in self.documents) > MAX_FILE_BYTES:
            raise ValueError("本轮资料总量超过 20 MiB，请缩小范围")
        if len({doc.id for doc in self.documents}) != len(self.documents):
            raise ValueError("资料标识不能重复")
        if sum(len(item.content) for item in self.history) > 32000:
            raise ValueError("历史对话过长，请开启新对话")
        return self


class Citation(StrictModel):
    id: str
    documentId: str
    version: int
    title: str
    heading: str
    excerpt: str
    cardId: str | None = None
    isAiDraft: bool = False


class ChatOutput(StrictModel):
    session_id: str
    request_id: str
    body: str
    citations: list[Citation]
    model: str
    provider_name: str
    context_note: str
    matched_cards: list[Citation] = Field(default_factory=list)
