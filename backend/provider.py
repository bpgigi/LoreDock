"""Small OpenAI-compatible HTTP adapter. No credentials or provider bodies in errors."""

import asyncio
import json
from urllib.parse import urlsplit

import httpx


class ProviderError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(message)


def check_credential(base_url: str, key: str):
    if not key and urlsplit(base_url).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ProviderError(400, "请先为该服务保存 API Key。")


def completion_payload(model: str, messages: list[dict], reasoning_effort: str | None = None) -> dict:
    payload = {"model": model, "messages": messages, "stream": False}
    if reasoning_effort is not None:
        payload["reasoning_effort"] = reasoning_effort
    return payload


async def provider_request(client: httpx.AsyncClient, method: str, base_url: str, key: str,
                           endpoint: str, payload=None, timeout: float = 60) -> dict:
    check_credential(base_url, key)
    headers = {"Authorization": f"Bearer {key}"} if key else {}

    async def request():
        async with client.stream(method, f"{base_url}/{endpoint}", headers=headers, json=payload, timeout=timeout) as response:
            if 300 <= response.status_code < 400:
                raise ProviderError(502, "接口返回了重定向；为保护密钥已停止，请核对 API Base URL。")
            if response.status_code in {401, 403}:
                raise ProviderError(502, "模型服务拒绝了认证，请检查 API Key 和账号权限。")
            if response.status_code == 429:
                raise ProviderError(429, "模型服务限流或额度不足，请检查账户后再试。")
            if response.status_code == 404:
                raise ProviderError(502, "服务未提供该接口，请核对兼容接口地址；模型也可手动填写。")
            if response.status_code in {400, 422} and isinstance(payload, dict) and payload.get("reasoning_effort"):
                # Inspect only a bounded error body and return fixed, neutral text.
                # Never echo provider messages, credentials, or automatically retry.
                error_body = bytearray()
                async for chunk in response.aiter_bytes():
                    error_body.extend(chunk[:max(0, 65536 - len(error_body))])
                    if len(error_body) >= 65536:
                        break
                description = error_body.decode("utf-8", errors="replace").lower()
                if "reasoning_effort" in description or "reasoning.effort" in description:
                    raise ProviderError(400, "当前模型或服务不支持这个思考档位，请改为“模型默认”或其他档位后重试。")
                raise ProviderError(502, "模型服务请求失败，请核对模型与接口配置，也可将思考强度改为“模型默认”后重试。")
            if response.status_code >= 400:
                raise ProviderError(502, "模型服务请求失败，请核对模型名称、接口配置和服务状态。")
            chunks = []
            length = 0
            async for chunk in response.aiter_bytes():
                length += len(chunk)
                if length > 2 * 1024 * 1024:
                    raise ProviderError(502, "模型服务返回的数据过大，已停止读取。")
                chunks.append(chunk)
            try:
                data = json.loads(b"".join(chunks))
                if not isinstance(data, dict):
                    raise ValueError
                return data
            except (ValueError, UnicodeDecodeError):
                raise ProviderError(502, "模型服务返回的内容不是有效 JSON，请检查接口协议。") from None
    try:
        return await asyncio.wait_for(request(), timeout=timeout)
    except (TimeoutError, httpx.TimeoutException):
        raise ProviderError(504, "模型服务响应超时，问题已保留，可以稍后重试。") from None
    except httpx.RequestError:
        raise ProviderError(502, "无法连接模型服务，请检查网络和 API Base URL。") from None
