"""配置管理模块

负责 Jira CLI 凭据的读取、保存和验证。
配置文件存储在 ~/.jira-cli/config.json，密码使用 base64 编码。
支持环境变量覆盖：JIRA_URL, JIRA_USERNAME, JIRA_PASSWORD
"""

import base64
import json
import os
import stat
from pathlib import Path


CONFIG_DIR = Path.home() / ".jira-cli"
CONFIG_FILE = CONFIG_DIR / "config.json"


def _encode_password(password: str) -> str:
    """将密码进行 base64 编码（避免明文存储）"""
    return base64.b64encode(password.encode("utf-8")).decode("utf-8")


def _decode_password(encoded: str) -> str:
    """解码 base64 密码"""
    return base64.b64decode(encoded.encode("utf-8")).decode("utf-8")


def save_config(url: str, username: str, password: str) -> Path:
    """保存配置到 ~/.jira-cli/config.json

    Args:
        url: Jira 服务器地址
        username: 用户名
        password: 密码（明文输入，base64 编码存储）

    Returns:
        配置文件路径
    """
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    # 保持原有的 aliases（如果有）
    aliases = {}
    if CONFIG_FILE.exists():
        try:
            old_config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            aliases = old_config.get("aliases", {})
        except Exception:
            pass

    config = {
        "url": url.rstrip("/"),
        "username": username,
        "password": _encode_password(password),
        "aliases": aliases,
    }

    CONFIG_FILE.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")

    # 设置文件权限为 600（仅用户可读写）
    try:
        CONFIG_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass  # Windows 不支持此操作

    return CONFIG_FILE


def load_config() -> dict:
    """加载配置，环境变量优先级最高

    Returns:
        dict: {"url": str, "username": str, "password": str}

    Raises:
        FileNotFoundError: 配置文件不存在且未设置环境变量
    """
    # 环境变量优先
    env_url = os.environ.get("JIRA_URL")
    env_username = os.environ.get("JIRA_USERNAME")
    env_password = os.environ.get("JIRA_PASSWORD")

    if env_url and env_username and env_password:
        return {
            "url": env_url.rstrip("/"),
            "username": env_username,
            "password": env_password,
        }

    # 读取配置文件
    if not CONFIG_FILE.exists():
        raise FileNotFoundError(
            f"配置文件不存在: {CONFIG_FILE}\n"
            f"请先运行 'bsq-jira config init' 初始化配置，\n"
            "或设置环境变量: JIRA_URL, JIRA_USERNAME, JIRA_PASSWORD"
        )

    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))

    return {
        "url": env_url or config.get("url", ""),
        "username": env_username or config.get("username", ""),
        "password": env_password or _decode_password(config.get("password", "")),
        "aliases": config.get("aliases", {}),
    }


def config_exists() -> bool:
    """检查配置是否存在（文件或环境变量）"""
    if os.environ.get("JIRA_URL") and os.environ.get("JIRA_USERNAME") and os.environ.get("JIRA_PASSWORD"):
        return True
    return CONFIG_FILE.exists()


def get_config_display() -> dict:
    """获取用于显示的配置信息（密码脱敏）"""
    try:
        config = load_config()
        password = config["password"]
        masked = password[:1] + "*" * (len(password) - 2) + password[-1:] if len(password) > 2 else "***"
        return {
            "url": config["url"],
            "username": config["username"],
            "password": masked,
            "source": "环境变量" if os.environ.get("JIRA_URL") else f"文件: {CONFIG_FILE}",
        }
    except FileNotFoundError:
        return None


def get_aliases() -> dict:
    """获取所有别名"""
    try:
        config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return config.get("aliases", {})
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_aliases(aliases: dict):
    """保存别名"""
    if not CONFIG_FILE.exists():
        raise FileNotFoundError("未找到配置文件，请先执行 config init")
    
    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    config["aliases"] = aliases
    CONFIG_FILE.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
