"""使用响应桩验证附件上传协议和保存边界，不连接 Jira。"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests
from click.testing import CliRunner
from jira_cli.client import JiraClient, JiraAPIError
from jira_cli.main import cli


class AttachmentUploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.first = self.root / '测试 报告.txt'
        self.first.write_bytes('中文内容'.encode('utf-8'))
        self.second = self.root / 'image.png'
        self.second.write_bytes(b'\x89PNG\r\n')
        self.client = JiraClient('https://example.invalid/jira', 'test', 'test')
        self.addCleanup(self.client.session.close)
        self.client._logged_in = True

    def response(self, data, status=200):
        response = requests.Response()
        response.status_code = status
        response._content = json.dumps(data).encode('utf-8')
        return response

    def metadata(self, paths):
        return [{'id': str(index), 'filename': path.name,
                 'content': f'https://example.invalid/attachment/{index}'}
                for index, path in enumerate(paths, 1)]

    def test_multipart_keeps_unicode_names_and_bytes_and_session_headers(self):
        paths = [self.first, self.second]
        metadata = self.metadata(paths)
        # 拦截发送环节，验证 requests 真正组装的协议头和 multipart 正文。
        with patch.object(self.client.session, 'send', return_value=self.response(metadata)) as send:
            result = self.client.upload_attachments(' test-1 ', paths)
        self.assertEqual(metadata, result)
        request = send.call_args.args[0]
        self.assertEqual('POST', request.method)
        self.assertEqual('https://example.invalid/jira/rest/api/2/issue/TEST-1/attachments', request.url)
        self.assertTrue(request.headers['Content-Type'].startswith('multipart/form-data; boundary='))
        self.assertEqual('nocheck', request.headers['X-Atlassian-Token'])
        self.assertEqual('application/json', request.headers['Accept'])
        self.assertEqual(2, request.body.count(b'name="file"'))
        for path in paths:
            self.assertIn(path.name.encode('utf-8'), request.body)
            self.assertIn(path.read_bytes(), request.body)
        self.assertIn(b'Content-Type: text/plain', request.body)
        self.assertIn(b'Content-Type: image/png', request.body)
        self.assertNotIn(str(self.root).encode(), request.body)
        self.assertEqual(300, send.call_args.kwargs['timeout'])
        self.assertEqual('application/json', self.client.session.headers['Content-Type'])
        self.assertNotIn('X-Atlassian-Token', self.client.session.headers)

    def test_upload_logs_in_with_existing_session(self):
        self.client._logged_in = False
        responses = [self.response({'session': {'name': 'JSESSIONID', 'value': 'test'}}),
                     self.response(self.metadata([self.first]))]
        with patch.object(self.client.session, 'send', side_effect=responses) as send:
            self.client.upload_attachments('TEST-1', [self.first])
        self.assertEqual(2, send.call_count)
        login_request = send.call_args_list[0].args[0]
        self.assertTrue(login_request.url.endswith('/rest/auth/1/session'))
        self.assertEqual('application/json', login_request.headers['Content-Type'])
        self.assertTrue(self.client._logged_in)

    def test_invalid_inputs_fail_before_login_or_upload(self):
        cases = [('', [self.first]), ('TEST-1', []),
                 ('TEST-1', [self.first, self.root / 'missing.txt']),
                 ('TEST-1', [self.root])]
        with patch.object(self.client, '_login') as login, patch.object(self.client.session, 'send') as send:
            for key, paths in cases:
                with self.subTest(key=key, paths=paths), self.assertRaises(ValueError):
                    self.client.upload_attachments(key, paths)
        login.assert_not_called()
        send.assert_not_called()

    def test_open_failure_closes_previous_file_without_request(self):
        opened = []
        original_open = Path.open

        def open_file(path, *args, **kwargs):
            if path == self.second:
                raise PermissionError('simulated unreadable file')
            stream = original_open(path, *args, **kwargs)
            opened.append(stream)
            return stream

        with patch.object(Path, 'open', open_file), patch.object(self.client.session, 'send') as send:
            with self.assertRaises(PermissionError):
                self.client.upload_attachments('TEST-1', [self.first, self.second])
        send.assert_not_called()
        self.assertEqual(1, len(opened))
        self.assertTrue(opened[0].closed)

    def test_http_errors_and_timeout_release_files_without_retry(self):
        errors = [self.response({'errorMessages': ['forbidden']}, 403),
                  self.response({'errorMessages': ['too large']}, 413),
                  requests.Timeout('simulated timeout'),
                  requests.ConnectionError('simulated disconnect')]
        for error in errors:
            with self.subTest(error=error):
                file_streams = []
                request_method = self.client.session.request

                def capture_files(*args, **kwargs):
                    file_streams.extend(part[1][1] for part in kwargs['files'])
                    return request_method(*args, **kwargs)

                with patch.object(self.client.session, 'request', side_effect=capture_files), \
                        patch.object(self.client.session, 'send') as send:
                    if isinstance(error, Exception):
                        send.side_effect = error
                    else:
                        send.return_value = error
                    with self.assertRaises(JiraAPIError):
                        self.client.upload_attachments('TEST-1', [self.first])
                self.assertEqual(1, send.call_count)
                self.assertTrue(file_streams[0].closed)

    def test_incomplete_response_is_not_reported_as_success(self):
        for payload in [None, [], {}, [{}], [{'id': '1'}]]:
            with self.subTest(payload=payload), \
                    patch.object(self.client.session, 'send', return_value=self.response(payload)):
                with self.assertRaisesRegex(JiraAPIError, '核对任务附件'):
                    self.client.upload_attachments('TEST-1', [self.first])

    def test_cli_upload_displays_metadata_and_normalizes_key(self):
        client = Mock()
        client.upload_attachments.return_value = self.metadata([self.first, self.second])
        result = CliRunner().invoke(cli, ['attachment', 'upload', 'test-1', str(self.first), str(self.second)],
                                    obj={'client': client})
        self.assertEqual(0, result.exit_code, result.output)
        client.upload_attachments.assert_called_once_with('TEST-1', [str(self.first), str(self.second)])
        self.assertIn(self.first.name, result.output)
        self.assertIn('ID: 1', result.output)
        self.assertIn('https://example.invalid/attachment/1', result.output)

    def test_cli_rejects_missing_file_directory_or_no_files_without_client(self):
        for paths in [[], [str(self.root)], [str(self.first), str(self.root / 'missing')]]:
            with self.subTest(paths=paths), patch('jira_cli.main._create_client') as create_client:
                result = CliRunner().invoke(cli, ['attachment', 'upload', 'TEST-1', *paths])
            self.assertEqual(2, result.exit_code, result.output)
            create_client.assert_not_called()

    def test_cli_errors_exit_nonzero_and_advise_verification(self):
        client = Mock()
        client.upload_attachments.side_effect = JiraAPIError(403, 'forbidden')
        result = CliRunner().invoke(cli, ['attachment', 'upload', 'TEST-1', str(self.first)],
                                    obj={'client': client})
        self.assertNotEqual(0, result.exit_code)
        self.assertIn('403', result.output)
        self.assertIn('核对任务附件', result.output)
        self.assertNotIn('✅', result.output)


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
