#!/usr/bin/env python3
"""
Polymarket 环境配置一键脚本

输入:  仅需私钥 (通过参数或交互式输入)
自动派生: 钱包地址、代理地址、API 凭证
自动更新: 本地 .env + 远端服务器 .env + PM2 重启

用法:
  python tools/setup-polymarket-env.py                          # 交互式输入私钥
  python tools/setup-polymarket-env.py <private_key>            # 命令行传入私钥
  python tools/setup-polymarket-env.py --dry-run <private_key>  # 仅展示结果，不写入
"""

import sys
import os
import re
import subprocess
import shutil
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

SSH_HOST = "predict-server"
SSH_ENV_PATH = "~/predict_arb/.env"
SSH_PM2_APP = "dashboard"


def _find_ssh() -> str:
    """定位 ssh 可执行文件，Windows 上 Git 自带的 ssh 可能不在 PATH 中"""
    found = shutil.which("ssh")
    if found:
        return found
    # 回退: Git for Windows 常见安装路径
    for candidate in [
        r"C:\Program Files\Git\usr\bin\ssh.exe",
        r"C:\Program Files (x86)\Git\usr\bin\ssh.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Git\usr\bin\ssh.exe"),
    ]:
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError(
        "找不到 ssh 命令。请安装 OpenSSH 或 Git for Windows，"
        "并确保 ssh.exe 在 PATH 中。"
    )

# .env 中需要更新的 key 列表
ENV_KEYS = {
    "POLYMARKET_TRADER_ADDRESS": None,
    "POLYMARKET_TRADER_PRIVATE_KEY": None,
    "POLYMARKET_PROXY_ADDRESS": None,
    "POLYMARKET_API_KEY": None,
    "POLYMARKET_API_SECRET": None,
    "POLYMARKET_PASSPHRASE": None,
}


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


def derive_proxy_address(address: str) -> str:
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
    try:
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
        # 多个 Safe 钱包，提示用户选择
        print(f"\n发现 {len(safes)} 个 Safe 钱包:")
        for i, s in enumerate(safes):
            print(f"  [{i}] {s}")
        while True:
            choice = input(f"请选择 Polymarket 代理钱包 (0-{len(safes)-1}): ").strip()
            if choice.isdigit() and 0 <= int(choice) < len(safes):
                return safes[int(choice)]
            print("无效选择，请重试")
    except requests.RequestException:
        # Safe API 不可达时尝试通过 SSH 服务器中转
        print("本地 Safe API 连接失败，尝试通过 SSH 服务器查询...")
        return _derive_proxy_via_ssh(checksummed)


def _derive_proxy_via_ssh(checksummed_address: str) -> str:
    """通过 SSH 服务器中转查询 Safe API"""
    cmd = [
        _find_ssh(), SSH_HOST,
        f"curl -sL '{SAFE_API_BASE}/owners/{checksummed_address}/safes/' "
        f"-H 'Accept: application/json' --max-time 15 2>/dev/null"
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(f"SSH 查询失败: {result.stderr}")
        import json
        data = json.loads(result.stdout)
        safes = data.get("safes", [])
        if not safes:
            raise RuntimeError(f"Safe API (via SSH) 未找到 {checksummed_address} 的代理钱包")
        if len(safes) == 1:
            return safes[0]
        print(f"\n发现 {len(safes)} 个 Safe 钱包:")
        for i, s in enumerate(safes):
            print(f"  [{i}] {s}")
        while True:
            choice = input(f"请选择 Polymarket 代理钱包 (0-{len(safes)-1}): ").strip()
            if choice.isdigit() and 0 <= int(choice) < len(safes):
                return safes[int(choice)]
            print("无效选择，请重试")
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        raise RuntimeError(f"SSH 中转查询失败: {e}")


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
        # 跳过空行和注释行，原样保留
        if not stripped or stripped.startswith("#"):
            new_lines.append(line)
            continue

        # 解析 key=value
        match = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=', stripped)
        if match:
            key = match.group(1)
            if key in updates:
                new_lines.append(f"{key}={updates[key]}")
                updated_keys.add(key)
                continue

        new_lines.append(line)

    # 检查是否有未更新的 key（.env 中不存在的）
    missing = set(updates.keys()) - updated_keys
    if missing:
        new_lines.append("")
        new_lines.append("# === Polymarket (auto-generated) ===")
        for key in sorted(missing):
            new_lines.append(f"{key}={updates[key]}")

    env_path.write_text("\n".join(new_lines) + "\n", encoding=encoding)


def upload_env_to_server() -> None:
    """将本地 .env 写入服务器 /dev/shm (tmpfs, 纯内存不落盘) 并软链到项目目录"""
    shm_path = "/dev/shm/predict-env"
    print(f"\n上传 .env 到 {SSH_HOST}:{shm_path} (tmpfs, 不落盘) ...")
    # 按原编码读，原样上传字节，避免编码转换损坏内容
    env_bytes = ENV_FILE.read_bytes()
    # 写入 /dev/shm (RAM) + 软链到项目目录
    remote_cmd = (
        f"cat > {shm_path} && chmod 600 {shm_path} && "
        f"ln -sf {shm_path} {SSH_ENV_PATH} && "
        f"echo 'OK: {shm_path} -> {SSH_ENV_PATH}'"
    )
    cmd = [_find_ssh(), SSH_HOST, remote_cmd]
    result = subprocess.run(cmd, input=env_bytes, capture_output=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"上传失败: {result.stderr.decode('utf-8', errors='replace')}")
    print(f"上传成功 (内存: {shm_path}, 软链: {SSH_ENV_PATH})")


def restart_pm2() -> None:
    """重启远端 PM2 进程"""
    print(f"\n重启远端 PM2 ({SSH_PM2_APP}) ...")
    # 非交互式 SSH 不加载 .bashrc，显式补充 PATH 以找到 node/pm2
    remote_cmd = (
        f"export PATH=\"$HOME/.npm-global/bin:$PATH\" && "
        f"cd ~/predict_arb && pm2 restart {SSH_PM2_APP} --update-env"
    )
    cmd = [_find_ssh(), SSH_HOST, remote_cmd]
    result = subprocess.run(cmd, capture_output=True, timeout=60)
    stdout = result.stdout.decode("utf-8", errors="replace") if result.stdout else ""
    stderr = result.stderr.decode("utf-8", errors="replace") if result.stderr else ""
    # 过滤 SSH 隧道端口占用警告 (不影响远端命令执行)
    fatal_lines = [
        line for line in stderr.splitlines()
        if line.strip()
        and "cannot listen to port" not in line
        and "Address already in use" not in line
        and "channel_setup_fwd_listener" not in line
        and "Could not request local forwarding" not in line
    ]
    if result.returncode != 0:
        raise RuntimeError(f"PM2 重启失败: {chr(10).join(fatal_lines) or stderr}")
    if stderr.strip():
        # 打印非致命警告
        for line in stderr.splitlines():
            if line.strip() and line not in "\n".join(fatal_lines):
                print(f"  [warn] {line.strip()}")
    for line in stdout.splitlines():
        if "online" in line or "errored" in line or "│" in line:
            print(line)


def main():
    parser = argparse.ArgumentParser(description="Polymarket 环境配置一键脚本")
    parser.add_argument("private_key", nargs="?", help="交易私钥 (hex)")
    parser.add_argument("--dry-run", action="store_true", help="仅展示结果，不写入文件")
    parser.add_argument("--no-upload", action="store_true", help="不上传到服务器")
    parser.add_argument("--no-restart", action="store_true", help="不重启 PM2")
    args = parser.parse_args()

    # 获取私钥
    private_key = args.private_key
    if not private_key:
        private_key = input("请输入 Polymarket 交易私钥 (hex): ").strip()
    if not private_key:
        print("ERROR: 私钥不能为空")
        sys.exit(1)

    # 标准化私钥格式
    if not private_key.startswith("0x"):
        private_key = "0x" + private_key

    # ---- Step 1: 派生钱包地址 ----
    print("\n[1/4] 派生钱包地址...")
    address = derive_address(private_key)
    print(f"  地址: {address}")

    # ---- Step 2: 派生 API 凭证 ----
    print("\n[2/4] 派生 API 凭证...")
    creds = derive_api_creds(private_key, address)
    print(f"  API Key:    {creds['api_key']}")
    print(f"  Secret:     {creds['api_secret'][:16]}...")
    print(f"  Passphrase: {creds['api_passphrase'][:16]}...")

    # ---- Step 3: 获取代理钱包地址 ----
    print("\n[3/4] 查询代理钱包地址...")
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

    # ---- Step 4: 写入 .env 并同步 ----
    print(f"\n[4/4] 写入 {ENV_FILE} ...")
    update_env_file(ENV_FILE, updates)
    print("本地 .env 更新完成")

    if not args.no_upload:
        upload_env_to_server()

    if not args.no_upload and not args.no_restart:
        restart_pm2()

    print("\n全部完成!")


if __name__ == "__main__":
    main()
