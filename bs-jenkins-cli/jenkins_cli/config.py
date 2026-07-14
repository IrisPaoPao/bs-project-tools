import os
import json
import click

CONFIG_FILE = "config.json"

def load_config():
    """Load configuration from config.json in the current working directory, tool root, or user home."""
    # Try current directory
    paths_to_try = [
        os.path.join(os.getcwd(), CONFIG_FILE),
        os.path.expanduser("~/.bsq-jenkins.json"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), CONFIG_FILE)
    ]
    
    config_path = None
    for path in paths_to_try:
        if os.path.exists(path):
            config_path = path
            break
            
    if not config_path:
        click.secho(f"❌ 找不到配置文件！", fg="red")
        click.secho(f"请在当前目录创建 config.json，或者在用户目录创建 ~/.bsq-jenkins.json 并填写信息。", fg="yellow")
        exit(1)
        
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        click.secho(f"❌ 解析配置文件失败: {e}", fg="red")
        exit(1)

def get_server_config(config, server_name=None):
    """Get the configuration for the specified server, or the default server."""
    if not server_name:
        server_name = config.get("default_server")
        if not server_name:
            click.secho("❌ 配置文件中没有设置 default_server，且未通过参数指定服务器！", fg="red")
            exit(1)
            
    servers = config.get("servers", {})
    if server_name not in servers:
        click.secho(f"❌ 找不到服务器 '{server_name}' 的配置！", fg="red")
        click.secho(f"当前可用服务器: {', '.join(servers.keys())}", fg="yellow")
        exit(1)
        
    server_conf = servers[server_name]
    server_conf['name'] = server_name
    return server_conf
