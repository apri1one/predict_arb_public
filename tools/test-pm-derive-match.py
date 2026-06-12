#!/usr/bin/env python3
"""
测试: 验证 .env 中的 POLYMARKET_TRADER_PRIVATE_KEY 能否派生出
与 .env 现有值一致的 Polymarket 配置 (proxy 地址 + L2 API 凭证)。

只读不写; 敏感值仅显示掩码。

运行: python tools/test-pm-derive-match.py
退出码: 0=全部一致(或 .env 为空可填入), 1=派生失败, 2=存在不一致
"""
import sys
import re
import importlib.util
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 导入 get-pm-apikey.py (文件名含连字符, 用 importlib 加载)
_SPEC = importlib.util.spec_from_file_location(
    "pmapi", Path(__file__).resolve().parent / "get-pm-apikey.py"
)
pmapi = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(pmapi)

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def mask(v: str) -> str:
    if not v:
        return "(空)"
    return v[:6] + "..." + v[-4:] if len(v) > 14 else v[:3] + "..."


def read_env() -> dict:
    text, _ = pmapi._read_env_with_encoding(ENV_FILE)
    out = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", s)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def main() -> int:
    env = read_env()
    pk = env.get("POLYMARKET_TRADER_PRIVATE_KEY", "")
    if not pk:
        print("ERROR: .env 缺少 POLYMARKET_TRADER_PRIVATE_KEY")
        return 1
    if not pk.startswith("0x"):
        pk = "0x" + pk

    print("[1/3] 派生钱包地址 ...")
    address = pmapi.derive_address(pk)
    print(f"  EOA: {address}")

    print("[2/3] 派生 API 凭证 (CLOB API, 含 get_api_keys 验证) ...")
    creds = pmapi.derive_api_creds(pk, address)

    print("[3/3] 查询代理钱包地址 ...")
    proxy = pmapi.derive_proxy_address(address, auto_select=True)

    derived = {
        "POLYMARKET_PROXY_ADDRESS": proxy,
        "POLYMARKET_API_KEY": creds["api_key"],
        "POLYMARKET_API_SECRET": creds["api_secret"],
        "POLYMARKET_PASSPHRASE": creds["api_passphrase"],
    }

    print()
    print("=" * 78)
    print(f"{'KEY':<28} {'派生值(掩码)':<22} 与 .env 对比")
    print("=" * 78)
    mismatch = False
    for k, v in derived.items():
        existing = env.get(k, "")
        # 地址类大小写不敏感 (checksum vs 小写), 凭证类精确对比
        same = (existing.lower() == v.lower()) if k.endswith("_ADDRESS") else (existing == v)
        if not existing:
            status = ".env 为空 -> 可自动填入"
        elif same:
            status = "一致 [OK]"
        else:
            status = f"不一致 [MISMATCH] (.env: {mask(existing)})"
            mismatch = True
        print(f"{k:<28} {mask(v):<22} {status}")
    print("=" * 78)

    if mismatch:
        print("\n结论: 派生值与 .env 现有值不一致, 请人工核对")
        return 2
    print("\n结论: 私钥可完整派生 Polymarket 配置, 与 .env 现有值兼容")
    return 0


if __name__ == "__main__":
    sys.exit(main())
