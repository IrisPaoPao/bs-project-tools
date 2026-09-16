"""构建命令回归测试，所有 API 与等待均使用本地桩。"""
import unittest
from unittest.mock import Mock, patch
from click.testing import CliRunner
from jenkins_cli.main import Context
from jenkins_cli.commands.build import build_cmd


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.ctx = Context()
        self.ctx.api = Mock()
        self.ctx.api.get_job_info.return_value = {'name': 'demo'}
        self.ctx.api.build_job.return_value = 'https://example.invalid/queue/1/'
        self.ctx.api.get_queue_item.return_value = {
            'executable': {'url': 'https://example.invalid/job/demo/1/', 'number': 1}}
        self.ctx.api.get_build_info.return_value = {'building': False, 'result': 'SUCCESS'}

    def invoke(self, *args):
        return CliRunner().invoke(build_cmd, ['demo', *args], obj=self.ctx)

    def test_success_and_failure_exit_codes(self):
        for status in ['SUCCESS', 'FAILURE', 'ABORTED', 'UNSTABLE', None]:
            with self.subTest(status=status):
                self.ctx.api.get_build_info.return_value = {'building': False, 'result': status}
                result = self.invoke()
                self.assertEqual(status == 'SUCCESS', result.exit_code == 0, result.output)

    def test_missing_job_and_trigger_errors_fail(self):
        self.ctx.api.get_job_info.return_value = None
        self.assertNotEqual(0, self.invoke().exit_code)
        self.ctx.api.build_job.assert_not_called()
        self.ctx.api.get_job_info.return_value = {'name': 'demo'}
        self.ctx.api.build_job.side_effect = OSError('network')
        self.assertNotEqual(0, self.invoke().exit_code)
        self.ctx.api.build_job.assert_called_once()

    def test_invalid_param_never_triggers_job(self):
        for param in ['invalid', '=value']:
            result = self.invoke('-p', param)
            self.assertNotEqual(0, result.exit_code)
        self.ctx.api.build_job.assert_not_called()

    def test_queue_cancelled(self):
        self.ctx.api.get_queue_item.return_value = {'cancelled': True}
        self.assertNotEqual(0, self.invoke().exit_code)

    def test_no_queue_fails_when_waiting_but_no_wait_succeeds(self):
        self.ctx.api.build_job.return_value = None
        self.assertNotEqual(0, self.invoke().exit_code)
        self.assertEqual(0, self.invoke('--no-wait').exit_code)

    def test_timeout_covers_queue_and_build_without_resubmitting(self):
        for phase in ['queue', 'build', 'network']:
            with self.subTest(phase=phase):
                self.setUp()
                if phase == 'queue':
                    self.ctx.api.get_queue_item.return_value = None
                elif phase == 'network':
                    self.ctx.api.get_queue_item.side_effect = OSError('unreachable')
                else:
                    self.ctx.api.get_build_info.return_value = {'building': True}
                clock = [0.0]
                def sleep(seconds):
                    clock[0] += seconds
                with patch('jenkins_cli.commands.build.time.monotonic', side_effect=lambda: clock[0]), \
                     patch('jenkins_cli.commands.build.time.sleep', side_effect=sleep):
                    result = self.invoke('--timeout', '5')
                self.assertNotEqual(0, result.exit_code)
                self.assertIn('超时', result.output)
                self.ctx.api.build_job.assert_called_once()


if __name__ == '__main__':
    unittest.main()
