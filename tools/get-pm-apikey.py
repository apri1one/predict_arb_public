#!/usr/bin/env python3
"""
Polymarket 环境配置脚本

交互式输入私钥 → 自动派生钱包地址、API 凭证、代理地址 → 写入本地 .env

用法:
  python tools/get-pm-apikey.py                          # 交互式输入私钥
  python tools/get-pm-apikey.py <private_key>            # 命令行传入私钥
  python tools/get-pm-apikey.py --dry-run <private_key>  # 仅展示结果，不写入
  echo "0xKEY" | python tools/get-pm-apikey.py --json --stdin  # JSON 输出 + stdin 输入
"""

import sys
import re
import json
import argparse
from pathlib import Path

# ============ 依赖检查 ============
try:
    from eth_account import Account
    from eth_utils import to_checksum_address
except ImportError:
    print("ERROR: 缺少依赖 eth_account / eth_utils")
    print("  pip install eth-account eth-utils")
    sys.exit(1)

try:
    from py_clob_client.client import ClobClient
except ImportError as e:
    # 注意: ImportError 不一定是缺包 — ALL_PROXY=socks5 环境下缺 socksio 也会在此抛出
    print(f"ERROR: py_clob_client 导入失败: {e}")
    print("  pip install -r tools/requirements.txt")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("ERROR: 缺少依赖 requests")
    print("  pip install requests")
    sys.exit(1)

# ============ 常量 ============
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
ENV_FILE = PROJECT_ROOT / ".env"

POLYMARKET_CLOB_HOST = "https://clob.polymarket.com"
POLYGON_CHAIN_ID = 137

SAFE_API_BASE = "https://safe-transaction-polygon.safe.global/api/v1"


def derive_address(private_key: str) -> str:
    """从私钥派生 EOA 地址"""
    if not private_key.startswith("0x"):
        private_key = "0x" + private_key
    account = Account.from_key(private_key)
    return account.address


def derive_api_creds(private_key: str, address: str) -> dict:
    """通过 CLOB API 派生 API 凭证"""
    client = ClobClient(POLYMARKET_CLOB_HOST, key=private_key, chain_id=POLYGON_CHAIN_ID)
    creds = client.create_or_derive_api_creds()
    if creds is None:
        raise RuntimeError("CLOB API 凭证派生失败")

    # 验证
    authed_client = ClobClient(
        POLYMARKET_CLOB_HOST,
        key=private_key,
        chain_id=POLYGON_CHAIN_ID,
        creds=creds,
        signature_type=0,  # EOA
        funder=address,
    )
    keys = authed_client.get_api_keys()
    if not keys or not keys.get("apiKeys"):
        raise RuntimeError("API 凭证验证失败: get_api_keys 返回空")

    return {
        "api_key": creds.api_key,
        "api_secret": creds.api_secret,
        "api_passphrase": creds.api_passphrase,
    }


def _derive_proxy_via_polymarket(address: str) -> str | None:
    """从 polymarket.com profile 页面抓取 proxyWallet 字段 (覆盖 EOA/POLY_PROXY/Safe/Deposit Wallet 全类型)"""
    url = f"https://polymarket.com/profile/{address}"
    r = requests.get(
        url,
        headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html"},
        timeout=15,
    )
    r.raise_for_status()
    match = re.search(r'proxyWallet"\s*:\s*"(0x[a-fA-F0-9]{40})"', r.text)
    return to_checksum_address(match.group(1)) if match else None


def derive_proxy_address(address: str, auto_select: bool = False) -> str:
    """
    查询 Polymarket 代理钱包地址。

    优先从 polymarket.com profile 页面抓取 (覆盖所有钱包类型: EOA / POLY_PROXY /
    Gnosis Safe / Deposit Wallet)，失败时回退到 Gnosis Safe Transaction Service
    (仅 type 2 旧 Safe 用户可用)。
    """
    checksummed = to_checksum_address(address)

    # 优先: polymarket.com profile 页面
    try:
        proxy = _derive_proxy_via_polymarket(checksummed)
        if proxy:
            return proxy
        print("  polymarket.com profile 未找到 proxyWallet 字段，回退到 Safe API ...")
    except requests.RequestException as e:
        print(f"  polymarket.com 查询失败 ({e})，回退到 Safe API ...")

    # 回退: Gnosis Safe Transaction Service (仅老 Safe 用户)
    url = f"{SAFE_API_BASE}/owners/{checksummed}/safes/"
    r = requests.get(url, headers={"Accept": "application/json"}, timeout=15)
    r.raise_for_status()
    data = r.json()
    safes = data.get("safes", [])
    if not safes:
        raise RuntimeError(
            f"未找到 {checksummed} 的代理钱包。\n"
            "已尝试 polymarket.com profile 抓取 + Safe Transaction Service，均无结果。\n"
            "可能原因: 该地址尚未在 polymarket.com 完成首次登录/激活。"
        )
    if len(safes) == 1:
        return safes[0]
    # JSON/自动模式: 选第一个，避免交互式 input() 阻塞
    if auto_select:
        return safes[0]
    # 多个 Safe 钱包，提示用户选择
    print(f"\n发现 {len(safes)} 个 Safe 钱包:")
    for i, s in enumerate(safes):
        print(f"  [{i}] {s}")
    while True:
        choice = input(f"请选择 Polymarket 代理钱包 (0-{len(safes)-1}): ").strip()
        if choice.isdigit() and 0 <= int(choice) < len(safes):
            return safes[int(choice)]
        print("无效选择，请重试")


def _read_env_with_encoding(path: Path) -> tuple[str, str]:
    """读 .env 自动嗅探编码，返回 (内容, 编码)。支持 utf-8 / gbk / latin-1。"""
    data = path.read_bytes()
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            continue
    raise RuntimeError(f"无法识别 {path} 的文本编码")


def update_env_file(env_path: Path, updates: dict) -> None:
    """更新 .env 文件中的指定 key，保留其余内容、注释和原编码"""
    if not env_path.exists():
        raise FileNotFoundError(f".env 文件不存在: {env_path}")

    text, encoding = _read_env_with_encoding(env_path)
    lines = text.splitlines()
    updated_keys = set()
    new_lines = []

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            new_lines.append(line)
            continue

        match = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=', stripped)
        if match:
            key = match.group(1)
            if key in updates:
                new_lines.append(f"{key}={updates[key]}")
                updated_keys.add(key)
                continue

        new_lines.append(line)

    # .env 中不存在的 key 追加到末尾
    missing = set(updates.keys()) - updated_keys
    if missing:
        new_lines.append("")
        new_lines.append("# === Polymarket (auto-generated) ===")
        for key in sorted(missing):
            new_lines.append(f"{key}={updates[key]}")

    env_path.write_text("\n".join(new_lines) + "\n", encoding=encoding)


def main():
    parser = argparse.ArgumentParser(description="Polymarket 环境配置 (本地 .env)")
    parser.add_argument("private_key", nargs="?", help="交易私钥 (hex)")
    parser.add_argument("--dry-run", action="store_true", help="仅展示结果，不写入文件")
    parser.add_argument("--json", action="store_true", dest="json_mode", help="JSON 输出到 stdout (供程序调用)")
    parser.add_argument("--stdin", action="store_true", help="从 stdin 读取私钥 (安全模式，避免命令行泄露)")
    args = parser.parse_args()

    # JSON 模式: 静默运行，结果输出 JSON 到 stdout
    if args.json_mode:
        try:
            private_key = sys.stdin.readline().strip() if args.stdin else args.private_key
            if not private_key:
                json.dump({"error": "私钥不能为空"}, sys.stdout)
                sys.exit(1)
            if not private_key.startswith("0x"):
                private_key = "0x" + private_key
            address = derive_address(private_key)
            creds = derive_api_creds(private_key, address)
            proxy_address = derive_proxy_address(address, auto_select=True)
            json.dump({
                "address": address,
                "proxyAddress": proxy_address,
                "apiKey": creds["api_key"],
                "apiSecret": creds["api_secret"],
                "passphrase": creds["api_passphrase"],
            }, sys.stdout)
        except Exception as e:
            json.dump({"error": str(e)}, sys.stdout)
            sys.exit(1)
        return

    # 获取私钥
    private_key = args.private_key
    if args.stdin:
        private_key = sys.stdin.readline().strip()
    if not private_key:
        private_key = input("请输入 Polymarket 交易私钥 (hex): ").strip()
    if not private_key:
        print("ERROR: 私钥不能为空")
        sys.exit(1)

    if not private_key.startswith("0x"):
        private_key = "0x" + private_key

    # ---- Step 1: 派生钱包地址 ----
    print("\n[1/3] 派生钱包地址...")
    address = derive_address(private_key)
    print(f"  地址: {address}")

    # ---- Step 2: 派生 API 凭证 ----
    print("\n[2/3] 派生 API 凭证...")
    creds = derive_api_creds(private_key, address)
    print(f"  API Key:    {creds['api_key']}")
    print(f"  Secret:     {creds['api_secret'][:16]}...")
    print(f"  Passphrase: {creds['api_passphrase'][:16]}...")

    # ---- Step 3: 获取代理钱包地址 ----
    print("\n[3/3] 查询代理钱包地址...")
    proxy_address = derive_proxy_address(address)
    print(f"  代理地址: {proxy_address}")

    # ---- 汇总 ----
    updates = {
        "POLYMARKET_TRADER_ADDRESS": address,
        "POLYMARKET_TRADER_PRIVATE_KEY": private_key,
        "POLYMARKET_PROXY_ADDRESS": proxy_address,
        "POLYMARKET_API_KEY": creds["api_key"],
        "POLYMARKET_API_SECRET": creds["api_secret"],
        "POLYMARKET_PASSPHRASE": creds["api_passphrase"],
    }

    print("\n" + "=" * 55)
    print("  配置汇总")
    print("=" * 55)
    for k, v in updates.items():
        display = v if len(v) <= 50 else v[:20] + "..." + v[-10:]
        print(f"  {k} = {display}")
    print("=" * 55)

    if args.dry_run:
        print("\n[dry-run] 仅展示，未写入任何文件")
        return

    # ---- 确认写入 ----
    confirm = input(f"\n确认写入 {ENV_FILE}? (y/N): ").strip().lower()
    if confirm not in ("y", "yes"):
        print("已取消")
        return

    update_env_file(ENV_FILE, updates)
    print(f"\n本地 .env 已更新: {ENV_FILE}")
    print("完成!")


if __name__ == "__main__":
    main()
