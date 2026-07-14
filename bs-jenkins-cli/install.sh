#!/bin/bash
set -e

# 进入脚本所在目录
cd "$(dirname "$0")"

echo "🔧 开始安装 Jenkins CLI (bsq-jenkins)..."

# 检查是否安装了 pipx
if command -v pipx &> /dev/null; then
    echo "📦 发现 pipx，正在使用 pipx 安装..."
    pipx install -e . --force
    echo ""
    echo "✅ 使用 pipx 安装完成！"
    echo "你现在可以在任何地方直接运行 'bsq-jenkins' 命令了。"
    echo "请将配置文件放置到 ~/.bsq-jenkins.json 以便全局生效。"
else
    echo "⚠️ 未找到 pipx，回退到虚拟环境安装模式。"
    # 检查虚拟环境
    if [ ! -d ".venv" ]; then
        echo "📦 创建 Python 虚拟环境..."
        python3 -m venv .venv
    fi

    # 激活虚拟环境并安装
    echo "📥 安装依赖及打包工具..."
    source .venv/bin/activate
    pip install -e .

    echo ""
    echo "✅ 安装完成！"
    echo "请执行以下命令使命令在当前终端生效："
    echo "    alias bsq-jenkins='$(pwd)/.venv/bin/bsq-jenkins'"
    echo ""
    echo "💡 建议将 alias 添加到你的 ~/.zshrc 或 ~/.bash_profile 中。"
fi
