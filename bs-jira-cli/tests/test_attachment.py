"""使用响应桩验证附件保存边界，不连接 Jira。"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

import requests
from jira_cli.client import JiraClient


class AttachmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.dest = self.root / 'downloads'
        self.dest.mkdir()
        self.client = JiraClient.__new__(JiraClient)
        self.client._login = Mock()
        self.client.session = Mock()

    def response(self, filename=None, chunks=None):
        response = Mock(status_code=200)
        response.headers = {} if filename is None else {'Content-Disposition': filename}
        response.iter_content.return_value = iter(chunks or [b'content'])
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        self.client.session.get.return_value = response
        return response

    def download(self, url='https://example.invalid/attachment/file.txt'):
        return self.client.download_attachment(url, str(self.dest))

    def test_rejects_path_components_and_encoded_separators(self):
        for name in ['../outside.txt', str(self.root / 'absolute.txt'), '..\\outside.txt', '%2e%2e%2foutside.txt', 'C:\\file.txt']:
            with self.subTest(name=name):
                self.response(f'attachment; filename="{name}"')
                with self.assertRaises(ValueError):
                    self.download()
        self.assertEqual([], list(self.dest.iterdir()))

    def test_existing_file_and_symlink_are_not_overwritten(self):
        outside = self.root / 'outside.txt'
        outside.write_bytes(b'original')
        for symlink in [False, True]:
            target = self.dest / 'file.txt'
            if symlink:
                target.symlink_to(outside)
            else:
                target.write_bytes(b'original')
            self.response()
            with self.assertRaises((FileExistsError, ValueError)):
                self.download()
            self.assertEqual(b'original', target.read_bytes())
            target.unlink()
        self.assertEqual(b'original', outside.read_bytes())

    def test_unicode_extended_filename_and_header_parameters(self):
        self.response("attachment; filename=fallback.txt; filename*=UTF-8''%E6%B5%8B%E8%AF%95.txt; size=7")
        result = Path(self.download())
        self.assertEqual(self.dest / '测试.txt', result)
        self.assertEqual(b'content', result.read_bytes())
        self.assertEqual([result], list(self.dest.iterdir()))

    def test_unquoted_filename(self):
        self.response('attachment; filename=report.txt')
        self.assertEqual(self.dest / 'report.txt', Path(self.download()))

    def test_interrupted_download_does_not_leave_partial_target(self):
        def chunks():
            yield b'partial'
            raise requests.ConnectionError('simulated interruption')
        self.response(chunks=chunks())
        with self.assertRaises(Exception):
            self.download()
        self.assertEqual([], list(self.dest.iterdir()))

    def test_url_encoded_filename_is_checked_after_decode(self):
        self.response()
        with self.assertRaises(ValueError):
            self.download('https://example.invalid/a/%2e%2e%2foutside.txt')

    def test_file_created_during_download_is_preserved(self):
        target = self.dest / 'file.txt'
        def chunks():
            yield b'partial'
            target.write_bytes(b'concurrent user file')
            yield b'completed'
        self.response(chunks=chunks())
        with self.assertRaises(FileExistsError):
            self.download()
        self.assertEqual(b'concurrent user file', target.read_bytes())
        self.assertEqual([target], list(self.dest.iterdir()))


if __name__ == '__main__':
    unittest.main()
