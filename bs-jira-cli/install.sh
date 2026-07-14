#!/usr/bin/env bash
set -e

echo "📦 正在安装 bsq-jira 依赖..."
poetry install

echo "🔗 正在创建全局命令软链接..."
mkdir -p ~/.local/bin
ln -sf "$(pwd)/.venv/bin/bsq-jira" ~/.local/bin/bsq-jira

echo "✅ 安装完成！"
echo "👉 请确保 ~/.local/bin 在你的环境变量 PATH 中。"
echo "如果你使用的是 zsh，可以执行以下命令使其立即生效："
echo "export PATH=\"\$HOME/.local/bin:\$PATH\""
