import asyncio
from functools import partial
import json
from typing import Any, cast
from typing_extensions import override

from nonebot import get_plugin_config
from nonebot.adapters import Adapter as BaseAdapter
from nonebot.compat import type_validate_python
from nonebot.drivers import URL, Driver, HTTPServerSetup, Request, Response
from nonebot.internal.driver import ASGIMixin, HTTPClientMixin
from nonebot.utils import escape_tag

from .bot import Bot, HookBot, TokenBot
from .config import BotInfo, Config
from .event import OrderNotifyEvent
from .exception import ActionFailed, ApiNotAvailable
from .payload import (
    OrderResponse,
    PingResponse,
    PlanResponse,
    RandomReplyResponse,
    SendMsgResponse,
    SponsorResponse,
    UpdatePlanReplyResponse,
)
from .signature import AFDIAN_WEBHOOK_PUBLIC_KEY, verify_webhook_sign
from .utils import construct_request, log, parse_response


class Adapter(BaseAdapter):
    @override
    def __init__(self, driver: Driver, **kwargs: Any):
        super().__init__(driver, **kwargs)
        self.afdian_config: Config = get_plugin_config(Config)
        self.tasks: list[asyncio.Task] = []
        self.webhook_url = (
            f"/afdian/{self.afdian_config.afdian_hook_secret}/webhooks/"
            if self.afdian_config.afdian_hook_secret
            else "/afdian/webhooks/"
        )
        self._setup()

    @classmethod
    @override
    def get_name(cls) -> str:
        return "AFDian"

    def _setup(self):
        if not isinstance(self.driver, HTTPClientMixin):
            raise RuntimeError(
                f"Current driver {self.config.driver} does not support http client requests! "
                f"{self.get_name()} Adapter need a HTTPClient Driver to work."
            )
        if not isinstance(self.driver, ASGIMixin):
            raise RuntimeError(
                f"Current driver {self.config.driver} does not support http server! "
                f"{self.get_name()} Adapter need a ASGI Driver to work."
            )

        # 为每一个配置过的 Bot 设置专属路由
        for bot_info in self.afdian_config.afdian_bots:
            webhook_route = HTTPServerSetup(
                URL(self.webhook_url + bot_info.user_id),
                "POST",
                self.get_name(),
                partial(
                    self._handle_webhook, user_id=bot_info.user_id, token=bot_info.token
                ),
            )
            self.setup_http_server(webhook_route)
        self.on_ready(self._startup)

    async def _startup(self):
        log("INFO", "AFDian Adapter startup.")
        for bot_info in self.afdian_config.afdian_bots:
            if bot_info.token:
                self.tasks.append(asyncio.create_task(self._connect_bot(bot_info)))
                log(
                    "INFO",
                    f"Bot <y>{escape_tag(bot_info.user_id)}</y> will connect with token.",
                )
            else:
                bot = HookBot(self, self_id=bot_info.user_id)
                self.bot_connect(bot)
                log(
                    "INFO",
                    f"<y>Bot {escape_tag(bot_info.user_id)}</y> has no token, "
                    f"<y>skipped connecting</y>.",
                )

    async def _handle_webhook(
        self, request: Request, user_id: str, token: str | None = None
    ) -> Response:
        """
        处理 Webhook 请求
        该函数会验证请求的合法性，并将订单通知事件传递给对应的 Bot 进行处理

        :param request: 请求对象
        :param user_id: Bot 用户 ID
        :param token: Bot Token 可选
        :return: 响应对象
        """
        if not request.content:
            log("ERROR", "Webhook data is empty.")
            return Response(
                400,
                headers={"Content-Type": "application/json"},
                content='{"ec": 400, "em": "data is empty"}',
            )
        json_data = json.loads(request.content)
        try:
            event = type_validate_python(OrderNotifyEvent, json_data)
        except Exception as e:
            log("ERROR", f"Webhook data parse to event failed: {e}")
            return Response(
                400,
                headers={"Content-Type": "application/json"},
                content='{"ec": 400, "em": "parse data failed"}',
            )

        if event.data.order.out_trade_no == "202106232138371083454010626":
            # 测试订单号，用于测试 webhook 是否能正常收到
            log(
                "INFO",
                "Webhook received <y>test order</y> notify: 202106232138371083454010626",
            )
            bot = cast(HookBot, self.bots[user_id])
            asyncio.create_task(bot.handle_event(event))
            return Response(
                200,
                headers={"Content-Type": "application/json"},
                content='{"ec": 200, "em": "success"}',
            )

        if event.data.order.sign:
            # 2025-07-01 起 webhook 推送携带签名，优先使用本地 RSA 验签
            public_key = (
                self.afdian_config.afdian_webhook_public_key
                or AFDIAN_WEBHOOK_PUBLIC_KEY
            )
            if not verify_webhook_sign(event.data.order, public_key):
                log(
                    "ERROR",
                    f"Webhook sign verify <r>failed</r>: {event.data.order.out_trade_no}",
                )
                return Response(
                    400,
                    headers={"Content-Type": "application/json"},
                    content='{"ec": 400, "em": "sign verify failed"}',
                )
            bot = cast(Bot, self.bots[user_id])
            asyncio.create_task(bot.handle_event(event))
            return Response(
                200,
                headers={"Content-Type": "application/json"},
                content='{"ec": 200, "em": "success"}',
            )

        if not token:
            # 如果没有token，则代表为HookBot，只接受Hook交给Bot处理，不做验证
            bot = cast(HookBot, self.bots[user_id])
            asyncio.create_task(bot.handle_event(event))
            return Response(
                200,
                headers={"Content-Type": "application/json"},
                content='{"ec": 200, "em": "success"}',
            )

        # 旧版推送无签名，回查订单接口验证（如果服务器异常，可能不保证能及时推送，因此建议结合API一起使用）
        verify_request = construct_request(
            self.afdian_config.afdian_api_base + "/api/open/query-order",
            user_id,
            token,
            {"out_trade_no": event.data.order.out_trade_no},
        )
        verify_response: Response = await self.request(verify_request)

        # 请求失败
        if verify_response.status_code != 200:
            log(
                "ERROR",
                f"Webhook data request failed when verify: {verify_response.content}",
            )
            return Response(
                400,
                headers={"Content-Type": "application/json"},
                content='{"ec": 400, "em": "Webhook data request failed when verify"}',
            )

        try:
            verify_order: OrderResponse = parse_response(verify_response, OrderResponse)
        except ActionFailed as e:
            log(
                "ERROR",
                f"Webhook data request failed when verify, status={e.status_code} code={getattr(e, 'code', None)} message={getattr(e, 'message', None)}",
            )
            return Response(
                400,
                headers={"Content-Type": "application/json"},
                content='{"ec": 400, "em": "Webhook data request failed when verify"}',
            )

        # 订单列表为空，代表订单不存在，验证失败
        if not verify_order.data.list:
            log("ERROR", "Webhook data <y>list</y> is <r>empty</r>! Verify failed.")
            return Response(
                400,
                headers={"Content-Type": "application/json"},
                content='{"ec": 400, "em": "order list is empty"}',
            )

        # 订单列表不为空，但不一定有需要的数据
        for order in verify_order.data.list:
            if order.out_trade_no == event.data.order.out_trade_no:
                bot = cast(Bot, self.bots[user_id])
                asyncio.create_task(bot.handle_event(event))
                return Response(
                    200,
                    headers={"Content-Type": "application/json"},
                    content='{"ec": 200, "em": "success"}',
                )
        else:
            log(
                "ERROR",
                "Webhook data <y>out_trade_no</y> not found in <y>list</y>! Verify failed.",
            )
            return Response(
                400,
                headers={"Content-Type": "application/json"},
                content='{"ec": 400, "em": "order not found when verify"}',
            )

    @override
    async def _call_api(self, bot: Bot, api: str, **data: Any) -> Any:
        response_models = {
            "/api/open/ping": PingResponse,
            "/api/open/query-order": OrderResponse,
            "/api/open/query-sponsor": SponsorResponse,
            "/api/open/query-random-reply": RandomReplyResponse,
            "/api/open/update-plan-reply": UpdatePlanReplyResponse,
            "/api/open/send-msg": SendMsgResponse,
            "/api/open/query-plan": PlanResponse,
        }
        if api not in response_models:
            log("ERROR", f"Unsupported api: {api}")
            raise ApiNotAvailable(api)
        if not isinstance(bot, TokenBot):
            raise ApiNotAvailable(api)
        request = construct_request(
            self.afdian_config.afdian_api_base + api,
            bot.self_id,
            bot.token,
            params=data,
        )
        response = await self.request(request)
        return parse_response(response, response_models[api])

    async def add_bot(self, bot_info: BotInfo) -> Bot | None:
        """
        在适配器中新增一个Bot
        :param bot_info: Bot信息
        :return: Bot 实例，连接失败则返回 None
        """
        if bot := await self._connect_bot(bot_info):
            webhook_route = HTTPServerSetup(
                URL("/afdian/webhooks/" + bot_info.user_id),
                "POST",
                self.get_name(),
                partial(
                    self._handle_webhook, user_id=bot_info.user_id, token=bot_info.token
                ),
            )
            self.setup_http_server(webhook_route)
            return bot
        return None

    async def _connect_bot(self, bot_info: BotInfo) -> TokenBot | None:
        assert bot_info.token
        request = construct_request(
            self.afdian_config.afdian_api_base + "/api/open/ping",
            bot_info.user_id,
            bot_info.token,
            params={"a": 333},
        )
        response = await self.request(request)
        try:
            ping = parse_response(response, PingResponse)
            if ping.ec != 200:
                log(
                    "ERROR",
                    f"<y>Bot {bot_info.user_id}</y> connect <r>failed</r>, ec={ping.ec} em={ping.em}",
                )
                return None
        except ActionFailed as e:
            if e.wrong:
                log(
                    "ERROR",
                    f"<y>Bot {bot_info.user_id}</y> connect <r>failed</r>, explain: {e.wrong.data.explain}, debug: {e.wrong.data.debug.kv_string}",
                )
            else:
                log(
                    "ERROR",
                    f"<y>Bot {bot_info.user_id}</y> connect <r>failed</r>, status={e.status_code}",
                )
            return None

        bot = TokenBot(self, self_id=bot_info.user_id, token=bot_info.token)
        self.bot_connect(bot)
        log("INFO", f"<y>Bot {escape_tag(bot_info.user_id)}</y> connected")
        return bot
