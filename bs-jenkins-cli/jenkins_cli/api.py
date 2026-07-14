import requests
from requests.auth import HTTPBasicAuth
from urllib.parse import urljoin

class JenkinsAPI:
    def __init__(self, server_config):
        self.url = server_config['url']
        if not self.url.endswith('/'):
            self.url += '/'
        self.auth = HTTPBasicAuth(server_config['username'], server_config['password'])
        self.session = requests.Session()
        self.session.auth = self.auth
        # Try to get CSRF crumb
        self._get_crumb()

    def _get_crumb(self):
        try:
            crumb_url = urljoin(self.url, 'crumbIssuer/api/json')
            response = self.session.get(crumb_url, timeout=5)
            if response.status_code == 200:
                crumb_data = response.json()
                self.session.headers.update({crumb_data['crumbRequestField']: crumb_data['crumb']})
        except Exception:
            # Crumb issuer might be disabled
            pass

    def get_jobs(self):
        """Get list of all jobs."""
        url = urljoin(self.url, 'api/json?tree=jobs[name,url,color]')
        response = self.session.get(url, timeout=10)
        response.raise_for_status()
        return response.json().get('jobs', [])

    def get_job_info(self, job_name):
        url = urljoin(self.url, f'job/{job_name}/api/json')
        response = self.session.get(url, timeout=10)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    def build_job(self, job_name, parameters=None):
        """Trigger a build for a job. Returns queue item URL or None."""
        if parameters:
            url = urljoin(self.url, f'job/{job_name}/buildWithParameters')
            response = self.session.post(url, data=parameters, timeout=10)
        else:
            url = urljoin(self.url, f'job/{job_name}/build')
            response = self.session.post(url, timeout=10)
            # Jenkins 多分支流水线的子任务等情况，如果报错 400 (Nothing is submitted / expects form submission)
            # 则退化为调用 buildWithParameters 并带上一个空延迟参数
            if response.status_code == 400:
                url_fallback = urljoin(self.url, f'job/{job_name}/buildWithParameters')
                response = self.session.post(url_fallback, data={'delay': '0sec'}, timeout=10)
        
        response.raise_for_status()
        # Usually returns 201 Created and the queue item location in headers
        return response.headers.get('Location')
        
    def get_queue_item(self, queue_url):
        """Get queue item info to find the executable (build) URL."""
        if not queue_url.endswith('/'):
            queue_url += '/'
        url = urljoin(queue_url, 'api/json')
        response = self.session.get(url, timeout=10)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    def get_build_info(self, job_name, build_number):
        url = urljoin(self.url, f'job/{job_name}/{build_number}/api/json')
        response = self.session.get(url, timeout=10)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()
