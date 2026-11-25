"""Local-only document copies and keyword retrieval. No model calls here."""

from fastapi import APIRouter
from pydantic import Field, field_validator

from .library import LibraryStore
from .schemas import ContextDocument, StrictModel


def validate_versions(value: dict[str, int]) -> dict[str, int]:
    if len(value) > 500 or any(not key or len(key) > 128 or version < 1 for key, version in value.items()):
        raise ValueError("资料版本范围无效")
    return value


class LibraryDocumentInput(ContextDocument):
    file_name: str = Field(min_length=1, max_length=240)
    type: str = Field(pattern=r"^(md|txt)$")
    space_name: str = Field(min_length=1, max_length=240)


class SearchInput(StrictModel):
    question: str = Field(min_length=1, max_length=4000)
    scope_ids: list[str] = Field(min_length=1, max_length=100)
    document_id: str | None = Field(default=None, min_length=1, max_length=128)
    document_versions: dict[str, int]

    _versions = field_validator("document_versions")(validate_versions)

    @field_validator("question")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("请填写检索关键词")
        return value.strip()


class RetireInput(StrictModel):
    document_ids: list[str] = Field(min_length=1, max_length=500)


def indexed_context(library, scope_ids, question, document_id, versions, char_budget):
    citations = library.search(scope_ids, question, document_id=document_id, limit=8,
                               char_budget=char_budget, required_versions=versions)
    note = (f"本机关键词检索，选取 {len(citations)} 个资料片段；不是语义或向量检索。"
            if citations else "当前范围没有匹配的资料片段，请换用资料中的关键词；未调用模型。")
    return {f"S{index}": citation for index, citation in enumerate(citations, 1)}, note


def library_router(library: LibraryStore) -> APIRouter:
    router = APIRouter(prefix="/api/library")

    @router.get("/status")
    def status():
        return library.status()

    @router.get("/documents")
    def documents():
        return {"documents": library.list_documents()}

    @router.get("/documents/{document_id}")
    def document(document_id: str):
        return library.get_document(document_id)

    @router.put("/documents/{document_id}")
    def save(document_id: str, payload: LibraryDocumentInput):
        from fastapi import HTTPException
        if document_id != payload.id:
            raise HTTPException(422, "资料标识不一致。")
        return library.upsert_document(payload.model_dump(exclude={"heading"}))

    @router.post("/retire")
    def retire(payload: RetireInput):
        return library.retire_documents(payload.document_ids)

    @router.post("/search")
    def search(payload: SearchInput):
        context, note = indexed_context(library, payload.scope_ids, payload.question,
                                        payload.document_id, payload.document_versions, 12000)
        return {"citations": list(context.values()), "context_note": note}

    return router
