import json
import threading
from test_memory import MemoryHTTPFixture, Upstream


class GenerationUpstream(Upstream):
    memories = {}
    writes = []
    candidates = []
    model_started = None
    model_release = None
    model_failure = False
    guard_keys = []
    operation_status = 'completed'

    def do_PUT(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.reply(200, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/chat/completions':
            if self.model_started:
                self.model_started.set()
                self.model_release.wait(3)
            if self.model_failure:
                return self.reply(503, {})
            prompt = body['messages'][0]['content']
            result = {'safeKeys': self.guard_keys} if 'manual-protection' in prompt else {'candidates': self.candidates}
            return self.reply(200, {'choices': [{'message': {'content': json.dumps(result)}}]})
        if self.path.endswith('/memories/recall'):
            bank = self.path.split('/')[4]
            return self.reply(200, {'results': [{'document_id': key, 'text': value['original_text']} for (owner, key), value in self.memories.items() if owner == bank]})
        if self.path.endswith('/memories'):
            bank = self.path.split('/')[4]
            for item in body['items']:
                value = {'id': item['document_id'], 'bank_id': bank, 'original_text': item['content']}
                self.memories[(bank, item['document_id'])] = value
                self.documents['/v1/default/banks/' + bank + '/documents/' + item['document_id']] = value
            self.writes.append(body)
            return self.reply(200, {'success': True, 'operation_id': body['operation_id']})
        self.reply(404, {})

    def do_DELETE(self):
        if '/operations/' in self.path:
            return self.reply(200, {'success': True})
        bank = self.path.split('/')[4]
        if '/documents/' in self.path:
            doc = self.path.rsplit('/', 1)[1]
            self.memories.pop((bank, doc), None)
            self.documents.pop(self.path, None)
        else:
            for owner, doc in list(self.memories):
                if owner == bank:
                    self.memories.pop((owner, doc), None)
                    self.documents.pop('/v1/default/banks/' + bank + '/documents/' + doc, None)
        self.reply(200, {'success': True})

    def do_GET(self):
        if '/operations?' in self.path:
            return self.reply(200, {'operations': [], 'total': 0})
        if '/operations/' in self.path:
            return self.reply(200, {'status': self.operation_status})
        super().do_GET()


class GenerationHTTPFixture(MemoryHTTPFixture):
    def setUp(self):
        super().setUp()
        self.upstream.RequestHandlerClass = GenerationUpstream
        GenerationUpstream.memories = {}
        GenerationUpstream.writes = []
        GenerationUpstream.candidates = [{'key': 'response-style', 'category': 'preference', 'title': '表达偏好', 'content': '偏好简短中文回复。', 'evidence': '我喜欢简短中文回复'}]
        GenerationUpstream.model_started = None
        GenerationUpstream.model_failure = False
        GenerationUpstream.operation_status = 'completed'
        self.gateway.model_url = 'http://127.0.0.1:' + str(self.upstream.server_port)
        self.gateway.model_key = 'model-only-secret'
        self.gateway.model_name = 'fixture'

    def enabled(self):
        return self.request('settings', {'generationEnabled': True, 'expectedRevision': 0, 'operationId': 'enable-generation'})

    def capture(self, **changes):
        body = {'operationId': 'capture-message-001', 'expectedRevision': 1, 'bankGeneration': 0,
                'text': '我喜欢简短中文回复', 'source': {'sessionId': 'session-a', 'messageId': 'message-a', 'time': '2026-10-29T00:00:00Z'}}
        return self.request('generate', dict(body, **changes))



class GenerationHTTPTests(GenerationHTTPFixture):
    def test_generation_persists_short_document_once_and_off_keeps_recall(self):
        self.enabled()
        status, first = self.capture()
        self.assertEqual(status, 200)
        self.assertEqual(first['result']['status'], 'completed')
        listed = self.request('list')[1]['result']
        self.assertEqual([item['content'] for item in listed['items']], ['偏好简短中文回复。'])
        self.assertEqual(listed['items'][0]['source']['messageId'], 'message-a')
        self.assertEqual(self.capture()[1], first)
        self.assertEqual(len(GenerationUpstream.writes), 1)
        self.request('settings', {'generationEnabled': False, 'expectedRevision': listed['state']['revision'], 'operationId': 'disable-generation'})
        recalled = self.request('recall', {'query': '回复偏好'})
        self.assertEqual(recalled[0], 200)
        self.assertEqual(recalled[1]['result']['memories'][0]['content'], '偏好简短中文回复。')
        self.assertEqual(self.request('recall', {'query': '回复偏好'}, token='b')[1]['result']['memories'], [])

    def test_empty_or_excluded_input_does_not_write_and_model_failure_is_truthful(self):
        self.enabled()
        GenerationUpstream.candidates = []
        self.assertEqual(self.capture()[1]['result']['status'], 'completed')
        self.assertEqual(self.request('list')[1]['result']['items'], [])
        for number, text in enumerate(['我的密码是secret-value', '> 我喜欢英文回复', '假设我喜欢英文回复', '我的api_key=sk-synthetic-secret']):
            GenerationUpstream.model_failure = True
            response = self.capture(operationId='excluded-input-' + str(number), text=text)
            self.assertEqual(response[1]['result']['status'], 'completed')
        failed = self.capture(operationId='failed-model-001')
        self.assertEqual(failed[1]['result']['status'], 'failed')
        self.assertEqual(self.request('operations', {'operationId': 'failed-model-001'})[1]['result'], failed[1]['result'])
        self.assertEqual(GenerationUpstream.writes, [])

    def test_off_during_extraction_cancels_admitted_write_without_holding_global_transaction(self):
        self.enabled()
        started, release = threading.Event(), threading.Event()
        GenerationUpstream.model_started = started
        GenerationUpstream.model_release = release
        output = []
        worker = threading.Thread(target=lambda: output.append(self.capture()))
        worker.start()
        self.assertTrue(started.wait(1))
        try:
            self.assertEqual(self.request('state', token='b')[0], 200)
            off = self.request('settings', {'generationEnabled': False, 'expectedRevision': 1, 'operationId': 'disable-in-flight'})
            self.assertEqual(off[1]['result']['status'], 'completed')
        finally:
            release.set()
            worker.join()
        self.assertEqual(output[0][1]['result']['status'], 'failed')
        self.assertEqual(output[0][1]['result']['errorCode'], 'MEMORY_VERSION_CONFLICT')
        self.assertEqual(GenerationUpstream.writes, [])
        self.assertEqual(self.request('list')[1]['result']['items'], [])

    def test_same_operation_survives_gateway_restart_and_rejects_changed_request(self):
        from personal_memory import Metadata
        self.enabled()
        first = self.capture()
        self.gateway.metadata = Metadata(self.metadata.path)
        self.assertEqual(self.capture(), first)
        self.assertEqual(self.capture(text='我喜欢英文回复')[0], 409)
        self.assertEqual(len(GenerationUpstream.writes), 1)

    def test_pending_backend_is_unknown_and_retry_never_duplicates_backend_submission(self):
        from personal_memory import Metadata
        self.enabled()
        self.gateway.timeout = 0.15
        GenerationUpstream.operation_status = 'processing'
        first = self.capture()
        self.assertEqual(first[1]['result']['status'], 'unknown')
        self.assertEqual(self.request('list')[1]['result']['items'], [])
        self.gateway.metadata = Metadata(self.metadata.path)
        self.assertEqual(self.request('operations', {'operationId': 'capture-message-001'})[1]['result']['status'], 'unknown')
        self.assertEqual(self.capture(), first)
        self.assertEqual(len(GenerationUpstream.writes), 1)

    def test_new_information_updates_automatic_topic_without_creating_duplicate_document(self):
        self.enabled()
        self.capture()
        GenerationUpstream.candidates = [{'key': 'response-style', 'category': 'preference', 'title': '表达偏好', 'content': '偏好详细中文回复。', 'evidence': '我喜欢详细中文回复'}]
        response = self.capture(operationId='next-user-message-002', text='我喜欢详细中文回复', source={'sessionId': 'session-a', 'messageId': 'message-b', 'time': '2026-10-29T01:00:00Z'})
        self.assertEqual(response[1]['result']['status'], 'completed')
        rows = self.request('list')[1]['result']['items']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['content'], '偏好详细中文回复。')
        self.assertEqual(rows[0]['version'], 2)
        self.assertEqual(rows[0]['source']['messageId'], 'message-b')
