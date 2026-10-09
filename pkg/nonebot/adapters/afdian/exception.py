from typing import Any

from nonebot.exception import ActionFailed as BaseActionFailed
from nonebot.exception import AdapterException
from nonebot.exception import ApiNotAvailable as BaseApiNotAvailable
from nonebot.exception import NetworkError as BaseNetworkError

from .payload import WrongResponse  # type: ignore


class AfdianAdapterException(AdapterException):
    def __init__(self):
        super().__init__("Afdian")


class NetworkError(BaseNetworkError, AfdianAdapterException):
    def __init__(self, msg: str | None = None):
        super().__init__()
        self.msg: str | None = msg
        """错误原因"""

    def __repr__(self):
        return f"<NetWorkError message={self.msg}>"

    def __str__(self):
        return self.__repr__()


class ActionFailed(
    BaseActionFailed,
    AfdianAdapterException,
):
    def __init__(
        self,
        status_code: int,
        code: int | None = None,
        message: str | None = None,
        data: dict[str, Any] | None = None,
        wrong: WrongResponse | None = None,
    ):
        """
        一般情况下，有 wrong 则无其他信息

        :param status_code: HTTP 状态码
        :param code: API 错误码
        :param message: 错误信息
        :param data: 额外数据
        :param wrong: 如果有的话，附带的 WrongResponse 对象
        """
        self.status_code: int = status_code
        self.wrong: WrongResponse | None = wrong
        if wrong:
            self.code = wrong.ec
            self.message = wrong.em
            self.data = wrong.model_dump()
        else:
            self.code = code
            self.message = message
            self.data = data

    def __repr__(self):
        if self.wrong:
            return f"<ActionFailed status_code={self.status_code}, ec={self.wrong.ec}, em={self.wrong.em}, explan={self.wrong.data.explain} raw_data={self.data}>"
        return f"<ActionFailed status_code={self.status_code} code={self.code} message={self.message}>"

    __str__ = __repr__


class ApiNotAvailable(BaseApiNotAvailable, AfdianAdapterException):
    def __init__(self, message: str | None = None):
        super().__init__()
        self.message: str | None = message
        """API 不可用的原因"""
