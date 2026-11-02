import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from personal_memory import Gateway, Metadata, make_server


class Upstream(BaseHTTPRequestHandler):
    identity_calls = []
    documents = {}
    delayed = {}

    def do_GET(self):
        if self.path == '/sys/user/getUserInfo':
            token = self.headers.get('X-Access-Token')
            self.identity_calls.append(token)
            identities = {'a': ('10', 'alice'), 'b': ('10', 'bob'), 'c': ('11', 'alice')}
            if token not in identities:
                return self.reply(401, {})
            tenant, user = identities[token]
            return self.reply(200, {'success': True, 'result': {'userInfo': {'id': user, 'loginTenantId': tenant}}})
        if self.path in self.delayed:
            started, release = self.delayed[self.path]
            started.set()
            release.wait(3)
        if self.path in self.documents:
            return self.reply(200, self.documents[self.path])
        self.reply(404, {})

    def reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_):
        pass


class MemoryHTTPFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        base = 'http://127.0.0.1:' + str(self.upstream.server_port)
        self.metadata = Metadata(str(Path(self.tmp.name) / 'memory.sqlite'))
        self.gateway = Gateway(self.metadata, {'production': base, 'test': base}, base, 'backend-secret')
        self.server = make_server(('127.0.0.1', 0), self.gateway)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.tmp.cleanup()

    def request(self, endpoint, body=None, token='a', environment='production'):
        req = urllib.request.Request('http://127.0.0.1:' + str(self.server.server_port) + '/v1/memory/' + endpoint,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'X-Access-Token': token, 'X-GEA-Environment': environment, 'Content-Type': 'application/json'},
            method='POST')
        if body is None:
            req.data = b'{}'
        try:
            response = urllib.request.urlopen(req)
        except urllib.error.HTTPError as error:
            response = error
        return response.status, json.load(response)



class MemoryHTTPTests(MemoryHTTPFixture):
    def test_new_account_defaults_off_and_identity_is_checked_on_every_request(self):
        before = len(Upstream.identity_calls)
        status, value = self.request('state')
        self.assertEqual(status, 200)
        self.assertEqual(value['result']['scope'], {'environment': 'production', 'tenantId': '10', 'userId': 'alice'})
        self.assertFalse(value['result']['generationEnabled'])
        self.assertEqual(value['result']['count'], 0)
        self.request('list')
        self.assertEqual(len(Upstream.identity_calls) - before, 2)

    def test_settings_are_durable_isolated_and_idempotent_with_version_barrier(self):
        body = {'generationEnabled': True, 'expectedRevision': 0, 'operationId': 'settings-0001'}
        status, first = self.request('settings', body)
        self.assertEqual(status, 200)
        self.assertEqual(first['result']['status'], 'completed')
        self.assertEqual(first['result']['state']['revision'], 1)
        self.assertEqual(self.request('settings', body)[1], first)
        self.gateway.metadata = Metadata(self.metadata.path)
        self.assertTrue(self.request('state')[1]['result']['generationEnabled'])
        for token, environment in [('b', 'production'), ('c', 'production'), ('a', 'test')]:
            self.assertFalse(self.request('state', token=token, environment=environment)[1]['result']['generationEnabled'])
            self.assertEqual(self.request('operations', {'operationId': 'settings-0001'}, token=token, environment=environment)[0], 404)
        self.assertEqual(self.request('settings', dict(body, generationEnabled=False))[0], 409)
        self.assertEqual(self.request('settings', dict(body, operationId='settings-0002'))[0], 409)
        status, off = self.request('settings', {'generationEnabled': False, 'expectedRevision': 1, 'operationId': 'settings-0003'})
        self.assertEqual(status, 200)
        self.assertEqual(off['result']['state']['revision'], 2)
        self.assertFalse(off['result']['state']['generationEnabled'])
        self.assertEqual(self.request('operations', {'operationId': 'settings-0003'})[1]['result'], off['result'])

    def test_client_scope_and_backend_paths_are_never_authority(self):
        for field in ['scope', 'userId', 'tenantId', 'bank', 'bankId', 'uri', 'path']:
            self.assertEqual(self.request('list', {field: 'other-user'})[0], 400)
        self.assertEqual(self.request('state', token='invalid')[0], 401)
        self.assertEqual(self.request('state', environment='unregistered')[0], 400)
        self.assertEqual(self.request('../banks')[0], 404)

    def test_list_reads_only_owned_documents_and_searches_body_without_storing_it(self):
        from personal_memory import scope_key, bank_id
        scope = {'environment': 'production', 'tenantId': '10', 'userId': 'alice'}
        source = {'sessionId': 'session-a', 'messageId': 'message-a', 'time': '2026-10-29T00:00:00Z'}
        with self.metadata.transaction() as db:
            self.metadata.state(db, scope)
            db.execute('INSERT INTO documents(scope,generation,id,category,title,source,updated_at) VALUES (?,?,?,?,?,?,?)',
                       (scope_key(scope), 0, 'doc-a', 'preference', '回复方式', json.dumps(source), '2026-10-29T00:00:00Z'))
        path = '/v1/default/banks/' + bank_id(scope, 0) + '/documents/doc-a'
        Upstream.documents[path] = {'id': 'doc-a', 'bank_id': bank_id(scope, 0), 'original_text': '先给结论，再给依据。'}
        status, value = self.request('list', {'query': '结论', 'category': 'preference'})
        self.assertEqual(status, 200)
        self.assertEqual([row['content'] for row in value['result']['items']], ['先给结论，再给依据。'])
        self.assertEqual(value['result']['state']['count'], 1)
        self.assertEqual(self.request('list', {'query': '不存在'})[1]['result']['items'], [])
        self.assertEqual(self.request('list', token='b')[1]['result']['items'], [])
        self.assertEqual(self.request('get', {'id': 'doc-a'}, token='b')[0], 404)
        Upstream.documents[path] = {'id': 'doc-a', 'bank_id': 'other-bank', 'original_text': 'private'}
        self.assertEqual(self.request('list')[0], 503)
        Upstream.documents[path] = {'id': 'doc-a', 'bank_id': bank_id(scope, 0), 'original_text': '先给结论。'}
        started, release, saved = threading.Event(), threading.Event(), threading.Event()
        Upstream.delayed[path] = (started, release)
        listed = []
        reader = threading.Thread(target=lambda: listed.append(self.request('list')))
        reader.start()
        self.assertTrue(started.wait(1))
        writer = threading.Thread(target=lambda: (self.request('settings', {'generationEnabled': False, 'expectedRevision': 0, 'operationId': 'settings-slow-list'}), saved.set()))
        writer.start()
        try:
            self.assertTrue(saved.wait(1), 'slow document read must not hold the metadata transaction')
        finally:
            release.set()
            writer.join()
            reader.join()
            Upstream.delayed.pop(path)
        self.assertEqual(listed[0][0], 409)



if __name__ == '__main__':
    unittest.main()
