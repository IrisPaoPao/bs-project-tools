from setuptools import setup, find_packages

setup(
    name="bs-jenkins-cli",
    version="1.0.0",
    description="Jenkins CLI - 命令行 Jenkins 管理工具",
    packages=find_packages(),
    install_requires=[
        "click>=8.0",
        "requests>=2.28",
        "rich>=13.0",
    ],
    entry_points={
        "console_scripts": [
            "bsq-jenkins=jenkins_cli.main:cli",
        ],
    },
    python_requires=">=3.8",
)
