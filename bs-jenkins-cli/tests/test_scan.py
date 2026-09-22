"""扫描多分支流水线命令回归测试，所有 API 与等待均使用本地桩。"""
import unittest
from unittest.mock import Mock, patch
from click.testing import CliRunner
from jenkins_cli.main import Context
from jenkins_cli.commands.scan import scan_cmd


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.ctx = Context()
        self.ctx.api = Mock()
        self.ctx.api.get_job_info.return_value = {
            '_class': 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject',
            'name': 'demo-multibranch',
        }
        self.ctx.api.scan_job.return_value = 'https://example.invalid/queue/item/10/'
        self.ctx.api.get_queue_item.return_value = {
            'executable': {'url': 'https://example.invalid/job/demo-multibranch/indexing/', 'number': 1}
        }
        self.ctx.api.get_indexing_info.return_value = {
            'building': False,
            'result': 'SUCCESS',
        }

    def invoke(self, *args):
        return CliRunner().invoke(scan_cmd, ['demo-multibranch', *args], obj=self.ctx)

    def test_missing_job_fails(self):
        self.ctx.api.get_job_info.return_value = None
        result = self.invoke()
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("不存在", result.output)
        self.ctx.api.scan_job.assert_not_called()

    def test_non_multibranch_job_fails(self):
        self.ctx.api.get_job_info.return_value = {
            '_class': 'hudson.model.FreeStyleProject',
            'name': 'demo-freestyle',
        }
        result = self.invoke()
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("不是多分支流水线", result.output)
        self.ctx.api.scan_job.assert_not_called()

    def test_scan_no_wait_default(self):
        result = self.invoke()
        self.assertEqual(0, result.exit_code)
        self.assertIn("已提交多分支流水线 'demo-multibranch' 扫描请求", result.output)
        self.assertIn("queue/item/10", result.output)
        self.ctx.api.scan_job.assert_called_once_with('demo-multibranch')
        self.ctx.api.get_queue_item.assert_not_called()

    def test_scan_wait_success(self):
        result = self.invoke('--wait')
        self.assertEqual(0, result.exit_code)
        self.assertIn("扫描完成", result.output)
        self.ctx.api.scan_job.assert_called_once_with('demo-multibranch')
        self.ctx.api.get_queue_item.assert_called_once()
        self.ctx.api.get_indexing_info.assert_called_once()

    def test_scan_wait_queue_cancelled(self):
        self.ctx.api.get_queue_item.return_value = {'cancelled': True}
        result = self.invoke('--wait')
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("在队列中被取消", result.output)

    def test_scan_wait_indexing_failed(self):
        self.ctx.api.get_indexing_info.return_value = {
            'building': False,
            'result': 'FAILURE',
        }
        result = self.invoke('--wait')
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("未成功，状态: FAILURE", result.output)

    def test_scan_wait_indexing_unsupported_but_queue_exited(self):
        # 若服务端返回 404，即不支持 /indexing/api/json，出队后直接视为完成
        self.ctx.api.get_indexing_info.return_value = None
        result = self.invoke('--wait')
        self.assertEqual(0, result.exit_code)
        self.assertIn("扫描完成", result.output)

    def test_scan_wait_timeout(self):
        # 模拟出队但在队列中超时
        self.ctx.api.get_queue_item.return_value = {}  # 仍在队列中
        clock = [0.0]

        def sleep(seconds):
            clock[0] += seconds

        with patch('jenkins_cli.commands.scan.time.monotonic', side_effect=lambda: clock[0]), \
             patch('jenkins_cli.commands.scan.time.sleep', side_effect=sleep):
            result = self.invoke('--wait', '--timeout', '5')
        self.assertNotEqual(0, result.exit_code)
        self.assertIn("等待扫描超时", result.output)


if __name__ == '__main__':
    unittest.main()
