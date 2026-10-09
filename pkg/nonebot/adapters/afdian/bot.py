from typing import TYPE_CHECKING, Any, Literal
from typing_extensions import override

from nonebot.adapters import Bot as BaseBot
from nonebot.drivers import Request
from nonebot.message import handle_event

from .event import Event
from .message import Message, MessageSegment
from .payload import (
    CreatorPlansResponse,
    OrderResponse,
    PingResponse,
    PlanResponse,
    RandomReplyResponse,
    SendMsgResponse,
    SponsorResponse,
    UpdatePlanReplyResponse,
)
from .utils import construct_request, parse_response

if TYPE_CHECKING:
    from .adapter import Adapter


class Bot(BaseBot):
    adapter: "Adapter"

    @override
    def __init__(self, adapter: "Adapter", self_id: str):
        super().__init__(adapter, self_id)

    async def handle_event(self, event: Event) -> None:
        await handle_event(self, event)

    @override
    async def send(
        self,
        event: Event,
        message: str | Message | MessageSegment,
        **kwargs,
    ) -> Any: ...

    async def query_creator_plans(
        self, user_id: str | None = None
    ) -> CreatorPlansResponse:
        """查询创作者的所有方案

        .. attention::

            非官方接口（/api/creator/get-plans），不在爱发电开放平台文档内，
            无需 token 签名，仅能获取已上架的公开方案。字段结构可能随平台前端调整而变化。

        :param user_id: 创作者用户 id，默认为当前 Bot 配置的 user_id
        """
        request = Request(
            "GET",
            url=self.adapter.afdian_config.afdian_api_base + "/api/creator/get-plans",
            params={"user_id": user_id or self.self_id},
        )
        response = await self.adapter.request(request)
        return parse_response(response, CreatorPlansResponse)


class HookBot(Bot): ...


class TokenBot(HookBot):
    @override
    def __init__(self, adapter: "Adapter", self_id: str, token: str):
        super().__init__(adapter, self_id)
        self.token = token

    async def send_ping(self) -> PingResponse:
        request = construct_request(
            self.adapter.afdian_config.afdian_api_base + "/api/open/ping",
            self.self_id,
            self.token,
            params={"a": 333},
        )
        response = await self.adapter.request(request)
        return parse_response(response, PingResponse)

    async def __query_order(self, params: dict[str, Any]) -> OrderResponse:
        request = construct_request(
            self.adapter.afdian_config.afdian_api_base + "/api/open/query-order",
            self.self_id,
            self.token,
            params=params,
        )
        response = await self.adapter.request(request)
        return parse_response(response, OrderResponse)

    async def query_order_by_page(self, page: int) -> OrderResponse:
        """根据页码查询订单"""
        if page <= 0:
            raise ValueError("page must be greater than 0")
        return await self.__query_order(params={"page": page})

    async def query_order_by_out_trade_no(self, out_trade_no: str) -> OrderResponse:
        """根据订单号查询订单"""
        return await self.__query_order(params={"out_trade_no": out_trade_no})

    async def query_order_by_order_list(self, order_list: list[str]) -> OrderResponse:
        """根据订单号列表查询多个订单"""
        order_list_str = ",".join(order_list)
        return await self.__query_order(params={"out_trade_no": order_list_str})

    async def query_sponsor(self, page: int, per_page: int = 20) -> SponsorResponse:
        """查询赞助者，可选传参每页数量 1-100"""
        if page <= 0:
            raise ValueError("page must be greater than 0")
        if per_page > 100 or per_page < 1:
            raise ValueError("per_page must be between 1 and 100")
        request = construct_request(
            self.adapter.afdian_config.afdian_api_base + "/api/open/query-sponsor",
            self.self_id,
            self.token,
            params={"page": page, "per_page": per_page},
        )
        response = await self.adapter.request(request)
        return parse_response(response, SponsorResponse)

    async def query_random_reply(
        self, out_trade_no: str | list[str]
    ) -> RandomReplyResponse:
        """根据订单号查询随机自动回复

        :param out_trade_no: 订单号，传列表可查询多个
        """
        if isinstance(out_trade_no, list):
            if not out_trade_no:
                raise ValueError("out_trade_no list must not be empty")
            out_trade_no = ",".join(out_trade_no)
        request = construct_request(
            self.adapter.afdian_config.afdian_api_base + "/api/open/query-random-reply",
            self.self_id,
            self.token,
            params={"out_trade_no": out_trade_no},
        )
        response = await self.adapter.request(request)
        return parse_response(response, RandomReplyResponse)

    async def update_plan_reply(
        self,
        *,
        plan_id: str | None = None,
        sku_id: str | None = None,
        auto_reply: str | None = None,
        auto_random_reply: str | None = None,
        update_random_reply_type: Literal["append", "overwrite"] | None = None,
    ) -> UpdatePlanReplyResponse:
        """通过 API 填入自动回复（可用于补货、发码等场景）

        :param plan_id: 方案 id，更新订阅方案时使用，与 sku_id 二选一
        :param sku_id: 型号 id，更新商品时使用，与 plan_id 二选一
        :param auto_reply: 自动回复内容，非空时覆盖原内容，不传或空串不更新
        :param auto_random_reply: 自动随机回复内容，非空时才会更新
        :param update_random_reply_type: 更新随机回复方式 append 追加 / overwrite 覆盖，
            更新 auto_random_reply 时必填
        """
        if (plan_id is None) == (sku_id is None):
            raise ValueError("plan_id and sku_id are mutually exclusive, pick one")
        if auto_random_reply and update_random_reply_type is None:
            raise ValueError(
                "update_random_reply_type is required when updating auto_random_reply"
            )
        params: dict[str, Any] = {}
        if plan_id is not None:
            params["plan_id"] = plan_id
        else:
            params["sku_id"] = sku_id
        if auto_reply:
            params["auto_reply"] = auto_reply
        if auto_random_reply:
            params["auto_random_reply"] = auto_random_reply
            params["update_random_reply_type"] = update_random_reply_type
        request = construct_request(
            self.adapter.afdian_config.afdian_api_base + "/api/open/update-plan-reply",
            self.self_id,
            self.token,
            params=params,
        )
        response = await self.adapter.request(request)
        return parse_response(response, UpdatePlanReplyResponse)

    async def send_msg(self, recipient: str, content: str) -> SendMsgResponse:
        """发送私信

        平台频率限制：10 次/秒 和 1000 次/小时

        :param recipient: 接收用户
        :param content: 私信内容
        """
        request = construct_request(
            self.adapter.afdian_config.afdian_api_base + "/api/open/send-msg",
            self.self_id,
            self.token,
            params={"recipient": recipient, "content": content},
        )
        response = await self.adapter.request(request)
        return parse_response(response, SendMsgResponse)

    async def query_plan(self, plan_id: str) -> PlanResponse:
        """查看方案详情

        :param plan_id: 方案 id
        """
        request = construct_request(
            self.adapter.afdian_config.afdian_api_base + "/api/open/query-plan",
            self.self_id,
            self.token,
            params={"plan_id": plan_id},
        )
        response = await self.adapter.request(request)
        return parse_response(response, PlanResponse)
