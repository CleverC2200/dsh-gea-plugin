import json
import test_generation
from test_generation import GenerationUpstream


class EditHTTPTests(test_generation.GenerationHTTPFixture):
    def test_edit_is_versioned_durable_and_manual_wins_over_later_automatic_candidates(self):
        self.enabled()
        self.capture()
        before = self.request('list')[1]['result']
        item = before['items'][0]
        body = {'operationId': 'manual-edit-0001', 'id': item['id'], 'expectedVersion': 1,
                'expectedRevision': before['state']['revision'], 'bankGeneration': 0,
                'category': 'habit', 'content': '我现在偏好分步说明。'}
        status, updated = self.request('update', body)
        self.assertEqual(status, 200)
        self.assertEqual(updated['result']['status'], 'completed')
        self.assertEqual(self.request('update', body)[1], updated)
        current = self.request('get', {'id': item['id']})[1]['result']['item']
        self.assertEqual(current['content'], '我现在偏好分步说明。')
        self.assertEqual(current['category'], 'habit')
        self.assertEqual(current['version'], 2)
        self.assertTrue(current['manuallyEdited'])
        self.assertEqual(current['source'], item['source'])
        self.assertEqual(self.request('update', dict(body, content='不同请求'))[0], 409)
        self.assertEqual(self.request('update', dict(body, operationId='manual-edit-0002'))[0], 409)
        self.assertEqual(self.request('update', dict(body, operationId='manual-edit-empty', content=' \n '))[0], 400)
        self.assertEqual(self.request('update', body, token='b')[0], 409)
        generation = self.request('state')[1]['result']
        GenerationUpstream.guard_keys = []
        self.capture(operationId='capture-message-002', expectedRevision=generation['revision'])
        after = self.request('list')[1]['result']['items']
        self.assertEqual([(row['content'], row['version']) for row in after], [('我现在偏好分步说明。', 2)])
        self.assertEqual(GenerationUpstream.writes[-1]['items'][0]['metadata']['manuallyEdited'], 'true')

    def test_unknown_edit_receipt_is_reconciled_after_gateway_restart_without_a_second_write(self):
        class LostReceipt(GenerationUpstream):
            lost = False
            def reply(self, status, body):
                if self.path.endswith('/memories') and self.lost:
                    self.close_connection = True
                    self.connection.close()
                    return
                super().reply(status, body)
        self.upstream.RequestHandlerClass = LostReceipt
        self.enabled()
        self.capture()
        listed = self.request('list')[1]['result']
        body = {'operationId': 'lost-edit-receipt', 'id': listed['items'][0]['id'], 'expectedVersion': 1,
                'expectedRevision': listed['state']['revision'], 'bankGeneration': 0,
                'category': 'preference', 'content': '未知结果仍保留同一操作。'}
        LostReceipt.lost = True
        first = self.request('update', body)
        self.assertEqual(first[0], 200)
        self.assertEqual(first[1]['result']['status'], 'unknown')
        writes = len(GenerationUpstream.writes)
        state = self.request('state')[1]['result']
        self.assertEqual(self.capture(operationId='blocked-during-edit', expectedRevision=state['revision'])[0], 409)
        from personal_memory import Metadata
        self.gateway.metadata = Metadata(self.metadata.path)
        result = self.request('operations', {'operationId': body['operationId']})
        self.assertEqual(result[1]['result']['status'], 'completed')
        self.assertEqual(len(GenerationUpstream.writes), writes)
        self.assertEqual(self.request('get', {'id': body['id']})[1]['result']['item']['content'], body['content'])

    def test_manual_protection_rejects_contradiction_under_new_key_but_allows_unrelated_same_category(self):
        self.enabled()
        self.capture()
        listed = self.request('list')[1]['result']
        item = listed['items'][0]
        edited = self.request('update', {'operationId': 'manual-protected-fact', 'id': item['id'], 'expectedVersion': 1,
            'expectedRevision': listed['state']['revision'], 'bankGeneration': 0, 'category': 'preference', 'content': '用户偏好详细回复。'})
        revision = edited[1]['result']['state']['revision']
        GenerationUpstream.candidates = [{'key': 'brand-new-contradiction', 'category': 'preference', 'title': '回复详细程度', 'content': '用户偏好简短回复。', 'evidence': '我喜欢简短回复'}]
        GenerationUpstream.guard_keys = []
        response = self.capture(operationId='contradiction-new-key', expectedRevision=revision, text='我喜欢简短回复')
        self.assertEqual(response[1]['result']['status'], 'completed')
        self.assertEqual(self.request('list')[1]['result']['state']['count'], 1)
        GenerationUpstream.candidates = [{'key': 'spreadsheet-units', 'category': 'preference', 'title': '表格金额单位', 'content': '表格金额注明元。', 'evidence': '我喜欢表格金额注明元'}]
        GenerationUpstream.guard_keys = ['spreadsheet-units']
        response = self.capture(operationId='unrelated-same-category', expectedRevision=revision, text='我喜欢表格金额注明元')
        self.assertEqual(response[1]['result']['status'], 'completed')
        rows = self.request('list')[1]['result']['items']
        self.assertEqual({row['content'] for row in rows}, {'用户偏好详细回复。', '表格金额注明元。'})
        self.assertTrue(self.request('get', {'id': item['id']})[1]['result']['item']['manuallyEdited'])

    def test_terminal_failed_edit_preserves_current_and_new_retry_can_succeed(self):
        class FailedEdit(GenerationUpstream):
            def do_POST(self):
                if self.path.endswith('/memories'):
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    self.writes.append(body)
                    return self.reply(200, {'success': True, 'operation_id': body['operation_id']})
                super().do_POST()
        self.enabled()
        self.capture()
        original = self.request('list')[1]['result']['items'][0]
        self.upstream.RequestHandlerClass = FailedEdit
        GenerationUpstream.operation_status = 'failed'
        body = {'operationId': 'failed-manual-no-write', 'id': original['id'], 'expectedVersion': 1,
                'expectedRevision': 1, 'bankGeneration': 0, 'category': 'habit', 'content': '人工修改 B。'}
        failed = self.request('update', body)[1]['result']
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(self.request('get', {'id': original['id']})[1]['result']['item'], original)
        self.upstream.RequestHandlerClass = GenerationUpstream
        GenerationUpstream.operation_status = 'completed'
        retried = self.request('update', dict(body, operationId='successful-manual-retry', expectedRevision=failed['state']['revision']))[1]['result']
        self.assertEqual(retried['status'], 'completed')
        item = self.request('list')[1]['result']['items'][0]
        self.assertEqual((item['id'], item['content'], item['version'], item['manuallyEdited']), (original['id'], body['content'], 2, True))
        self.assertEqual(item['source'], original['source'])

    def test_failed_edit_after_backend_mutation_never_overwrites_current_body_or_metadata(self):
        from personal_memory import Metadata
        self.enabled()
        self.capture()
        original = self.request('list')[1]['result']['items'][0]
        GenerationUpstream.operation_status = 'failed'
        body = {'operationId': 'failed-partial-manual', 'id': original['id'], 'expectedVersion': 1,
                'expectedRevision': 1, 'bankGeneration': 0, 'category': 'habit', 'content': '后端先写 B 然后失败。'}
        failed = self.request('update', body)[1]['result']
        self.assertEqual(failed['status'], 'failed')
        self.gateway.metadata = Metadata(self.metadata.path)
        self.assertEqual(self.request('list')[1]['result']['items'], [original])
        self.assertEqual(self.request('recall', {'query': '偏好'})[1]['result']['memories'], [original])
        self.assertEqual([row['original_text'] for row in GenerationUpstream.memories.values()], [original['content']])
        self.assertEqual(self.request('operations', {'operationId': body['operationId']})[1]['result']['status'], 'failed')

    def test_adopted_manual_version_stays_current_while_old_physical_cleanup_restarts(self):
        from personal_memory import Metadata
        class FailedOldCleanup(GenerationUpstream):
            fail = True
            old_id = None
            def do_DELETE(self):
                if self.fail and self.path.endswith('/documents/' + self.old_id):
                    return self.reply(503, {})
                super().do_DELETE()
        self.enabled()
        self.capture()
        original = self.request('list')[1]['result']['items'][0]
        FailedOldCleanup.old_id = GenerationUpstream.writes[0]['items'][0]['document_id']
        self.upstream.RequestHandlerClass = FailedOldCleanup
        body = {'operationId': 'manual-adopted-gc-restart', 'id': original['id'], 'expectedVersion': 1,
                'expectedRevision': 1, 'bankGeneration': 0, 'category': 'habit', 'content': '已经采用的人工版本。'}
        result = self.request('update', body)[1]['result']
        self.assertEqual(result['status'], 'unknown')
        adopted = self.request('get', {'id': original['id']})[1]['result']['item']
        self.assertEqual((adopted['content'], adopted['version'], adopted['manuallyEdited']), (body['content'], 2, True))
        self.gateway.metadata = Metadata(self.metadata.path)
        self.assertEqual(self.request('operations', {'operationId': body['operationId']})[1]['result']['status'], 'unknown')
        FailedOldCleanup.fail = False
        self.assertEqual(self.request('operations', {'operationId': body['operationId']})[1]['result']['status'], 'completed')
        self.assertEqual(self.request('list')[1]['result']['items'], [adopted])
        self.assertEqual([row['original_text'] for row in FailedOldCleanup.memories.values()], [body['content']])

    def unaccepted_edit(self):
        import io
        class UnacceptedEdit(GenerationUpstream):
            attempts = []
            accepted = False
            ack_started = None
            ack_release = None
            def do_POST(self):
                if self.path.endswith('/memories'):
                    raw = self.rfile.read(int(self.headers['Content-Length']))
                    self.attempts.append(json.loads(raw))
                    if len(self.attempts) == 1:
                        self.close_connection = True
                        self.connection.close()
                        return
                    type(self).accepted = True
                    self.rfile = io.BytesIO(raw)
                super().do_POST()
            def reply(self, status, body):
                if self.path.endswith('/memories') and self.ack_started:
                    self.ack_started.set()
                    self.ack_release.wait(3)
                super().reply(status, body)
            def do_GET(self):
                if '/operations/' in self.path and self.attempts and self.path.endswith('/' + self.attempts[0]['operation_id']) and not self.accepted:
                    return self.reply(200, {'status': 'not_found'})
                super().do_GET()
        self.upstream.RequestHandlerClass = UnacceptedEdit
        return UnacceptedEdit

    def test_same_id_retry_resubmits_unaccepted_manual_candidate_without_changing_its_identity(self):
        from personal_memory import Metadata
        self.enabled()
        self.capture()
        original = self.request('list')[1]['result']['items'][0]
        UnacceptedEdit = self.unaccepted_edit()
        body = {'operationId': 'retry-unaccepted-manual', 'id': original['id'], 'expectedVersion': 1,
                'expectedRevision': 1, 'bankGeneration': 0, 'category': 'habit', 'content': '重试同一人工候选。'}
        first = self.request('update', body)[1]['result']
        self.assertEqual(first['status'], 'unknown')
        self.gateway.metadata = Metadata(self.metadata.path)
        self.assertEqual(self.request('operations', {'operationId': body['operationId']})[1]['result']['status'], 'unknown')
        self.assertEqual(self.request('get', {'id': original['id']})[1]['result']['item'], original)
        self.assertEqual(self.request('update', dict(body, content='不能更换原请求正文'))[0], 409)
        retry = self.request('update', body)[1]['result']
        self.assertEqual(retry['status'], 'completed')
        self.assertEqual(UnacceptedEdit.attempts[0], UnacceptedEdit.attempts[1])
        self.assertEqual(self.request('update', body)[1]['result']['status'], 'completed')
        self.assertEqual(len(UnacceptedEdit.attempts), 2)
        current = self.request('get', {'id': original['id']})[1]['result']['item']
        self.assertEqual((current['content'], current['version'], current['manuallyEdited']), (body['content'], 2, True))
        self.assertEqual(current['source'], original['source'])

    def test_clear_overtakes_an_explicit_retry_without_recreating_the_purged_backend_operation(self):
        import threading
        self.enabled()
        self.capture()
        original = self.request('list')[1]['result']['items'][0]
        backend = self.unaccepted_edit()
        body = {'operationId': 'retry-overtaken-by-clear', 'id': original['id'], 'expectedVersion': 1,
                'expectedRevision': 1, 'bankGeneration': 0, 'category': 'habit', 'content': '清空不能被迟到重试撤销。'}
        self.assertEqual(self.request('update', body)[1]['result']['status'], 'unknown')
        backend.ack_started, backend.ack_release = threading.Event(), threading.Event()
        results = []
        caller = threading.Thread(target=lambda: results.append(self.request('update', body)))
        caller.start()
        self.assertTrue(backend.ack_started.wait(1))
        try:
            cleared = self.request('clear', {'operationId': 'clear-during-explicit-retry', 'expectedRevision': 2,
                'bankGeneration': 0, 'confirmation': '清空'})[1]['result']
            self.assertEqual(cleared['status'], 'unknown')
            self.assertEqual(self.request('update', body)[1]['result']['status'], 'failed')
        finally:
            backend.ack_release.set()
            caller.join()
        self.assertEqual(results[0][1]['result']['status'], 'failed')
        self.assertEqual(self.request('operations', {'operationId': cleared['operationId']})[1]['result']['status'], 'completed')
        self.assertEqual(self.request('update', body)[1]['result']['status'], 'failed')
        self.assertEqual(len(backend.attempts), 2)
        self.assertEqual(self.request('list')[1]['result']['items'], [])
        self.assertEqual(backend.memories, {})
