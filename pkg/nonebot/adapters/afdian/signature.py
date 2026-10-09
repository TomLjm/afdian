import base64
import binascii

from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from .payload import Order

AFDIAN_WEBHOOK_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwdaCg1Bt+UKZKs0R54y
lYnuANma49IpgoOwNmk3a0rhg/PQuhUJ0EOZSowIC44l0K3+fqGns3Ygi4AfmEfS
4EKbdk1ahSxu7Zkp2rHMt+R9GarQFQkwSS/5x1dYiHNVMiR8oIXDgjmvxuNes2Cr
8fw9dEF0xNBKdkKgG2qAawcN1nZrdyaKWtPVT9m2Hl0ddOO9thZmVLFOb9NVzgYf
jEgI+KWX6aY19Ka/ghv/L4t1IXmz9pctablN5S0CRWpJW3Cn0k6zSXgjVdKm4uN7j
RlgSRaf/Ind46vMCm3N2sgwxu/g3bnooW+db0iLo13zzuvyn727Q3UDQ0MmZcEWM
QIDAQAB
-----END PUBLIC KEY-----"""
"""爱发电平台 Webhook 签名验证公钥，来自官方文档"""


def construct_sign_str(order: Order) -> bytes:
    """构造签名原文：out_trade_no、user_id、plan_id、total_amount 依次拼接"""
    return (
        f"{order.out_trade_no}{order.user_id}{order.plan_id}{order.total_amount}"
    ).encode()


def verify_webhook_sign(
    order: Order, public_key_pem: str = AFDIAN_WEBHOOK_PUBLIC_KEY
) -> bool:
    """验证 Webhook 订单签名

    :param order: 订单对象，需包含 sign 字段
    :param public_key_pem: RSA 公钥 PEM，默认使用爱发电平台公钥
    :return: 签名是否有效
    """
    if not order.sign:
        return False
    try:
        public_key = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
        signature = base64.b64decode(order.sign)
        public_key.verify(
            signature,
            construct_sign_str(order),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
    except (
        InvalidSignature,
        UnsupportedAlgorithm,
        TypeError,
        ValueError,
        binascii.Error,
    ):
        # 签名错误 / PEM 格式错误 / 不支持的算法 / 非 RSA 公钥，均视为验证失败
        return False
    return True
