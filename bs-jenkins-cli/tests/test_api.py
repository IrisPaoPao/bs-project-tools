"""Jenkins API 请求行为回归测试，不连接真实 Jenkins。"""
import unittest
from unittest.mock import Mock

from jenkins_cli.api import JenkinsAPI


class JenkinsApiBuildTests(unittest.TestCase):
    def setUp(self):
        self.api = JenkinsAPI.__new__(JenkinsAPI)
        self.api.url = 'http://jenkins.example/'
        self.api.session = Mock()

    def response(self, status_code=201, location=None):
        response = Mock()
        response.status_code = status_code
        response.headers = {}
        if location is not None:
            response.headers['Location'] = location
        return response

    def test_build_preserves_location_without_following_redirects(self):
        self.api.session.post.return_value = self.response(
            location='/queue/item/7/')

        queue_url = self.api.build_job('demo')

        self.assertEqual('http://jenkins.example/queue/item/7/', queue_url)
        self.api.session.post.assert_called_once_with(
            'http://jenkins.example/job/demo/build',
            timeout=10,
            allow_redirects=False,
        )

    def test_parameterized_build_uses_same_redirect_policy(self):
        self.api.session.post.return_value = self.response(
            location='http://jenkins.example/queue/item/8/')

        queue_url = self.api.build_job('demo', parameters={'env': 'dev'})

        self.assertEqual('http://jenkins.example/queue/item/8/', queue_url)
        self.api.session.post.assert_called_once_with(
            'http://jenkins.example/job/demo/buildWithParameters',
            data={'env': 'dev'},
            timeout=10,
            allow_redirects=False,
        )

    def test_build_returns_none_when_jenkins_omits_location(self):
        self.api.session.post.return_value = self.response()

        self.assertIsNone(self.api.build_job('demo'))

    def test_scan_job_preserves_location(self):
        self.api.session.post.return_value = self.response(
            location='/queue/item/99/')

        location_url = self.api.scan_job('demo-multi')

        self.assertEqual('http://jenkins.example/queue/item/99/', location_url)
        self.api.session.post.assert_called_once_with(
            'http://jenkins.example/job/demo-multi/build',
            timeout=10,
            allow_redirects=False,
        )

    def test_get_indexing_info_returns_data(self):
        resp = Mock()
        resp.status_code = 200
        resp.json.return_value = {'result': 'SUCCESS', 'building': False}
        self.api.session.get.return_value = resp

        info = self.api.get_indexing_info('demo-multi')
        self.assertEqual({'result': 'SUCCESS', 'building': False}, info)
        self.api.session.get.assert_called_once_with(
            'http://jenkins.example/job/demo-multi/indexing/api/json',
            timeout=10,
        )


if __name__ == '__main__':
    unittest.main()
