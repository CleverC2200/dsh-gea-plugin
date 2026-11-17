from test_generation import GenerationHTTPFixture, GenerationUpstream


CleanupUpstream = GenerationUpstream

class CleanupHTTPTests(GenerationHTTPFixture):
    def setUp(self):
        super().setUp()
        self.upstream.RequestHandlerClass = CleanupUpstream

    def test_delete_is_durable_idempotent_and_physically_removes_recall(self):
        self.enabled()
        self.capture()
        listed = self.request('list')[1]['result']
        item = listed['items'][0]
        body = {'operationId': 'delete-memory-001', 'id': item['id'], 'expectedVersion': item['version'],
                'expectedRevision': listed['state']['revision'], 'bankGeneration': 0}
        response = self.request('delete', body)
        self.assertEqual(response[0], 200)
        self.assertEqual(response[1]['result']['status'], 'completed')
        self.assertEqual(self.request('delete', body), response)
        self.assertEqual(self.request('list')[1]['result']['items'], [])
        self.assertEqual(self.request('recall', {'query': '偏好'})[1]['result']['memories'], [])
        self.assertEqual(CleanupUpstream.memories, {})
        self.assertTrue(self.request('state')[1]['result']['generationEnabled'])

    def test_clear_all_categories_switches_bank_and_rejects_old_model_result(self):
        import threading
        self.enabled()
        self.capture()
        GenerationUpstream.candidates = [{'key': 'work', 'category': 'background', 'title': '背景', 'content': '我负责生产。', 'evidence': '我负责生产'}]
        self.capture(operationId='second-category-001', text='我负责生产')
        started, release = threading.Event(), threading.Event()
        GenerationUpstream.model_started, GenerationUpstream.model_release = started, release
        output = []
        worker = threading.Thread(target=lambda: output.append(self.capture(operationId='old-model-job-001')))
        worker.start()
        self.assertTrue(started.wait(1))
        body = {'operationId': 'clear-all-memory-001', 'expectedRevision': 1, 'bankGeneration': 0, 'confirmation': '清空'}
        try:
            self.assertEqual(self.request('clear', dict(body, confirmation='清理'))[0], 400)
            cleared = self.request('clear', body)
            self.assertEqual(cleared[1]['result']['status'], 'completed')
            self.assertEqual(cleared[1]['result']['state']['bankGeneration'], 1)
            self.assertTrue(cleared[1]['result']['state']['generationEnabled'])
        finally:
            release.set()
            worker.join()
        self.assertEqual(output[0][1]['result']['status'], 'failed')
        self.assertEqual(self.request('clear', body), cleared)
        self.assertEqual(self.request('list')[1]['result']['items'], [])
        self.assertEqual(CleanupUpstream.memories, {})
        self.assertEqual(self.request('clear', body, token='b')[0], 409)

    def test_delete_completed_allows_future_new_turn_to_relearn_same_topic(self):
        self.enabled()
        self.capture()
        listed = self.request('list')[1]['result']
        item = listed['items'][0]
        edit = self.request('update', {'operationId': 'edit-before-delete', 'id': item['id'], 'expectedVersion': 1,
                'expectedRevision': 1, 'bankGeneration': 0, 'category': 'habit', 'content': '人工修改'})[1]['result']
        deleted = self.request('delete', {'operationId': 'delete-edited-001', 'id': item['id'], 'expectedVersion': 2,
                'expectedRevision': edit['state']['revision'], 'bankGeneration': 0})[1]['result']
        self.assertEqual(deleted['status'], 'completed')
        result = self.capture(operationId='new-user-turn-001', expectedRevision=deleted['state']['revision'],
                source={'sessionId': 'new-session', 'messageId': 'new-message', 'time': '2026-10-29T03:00:00Z'})
        self.assertEqual(result[1]['result']['status'], 'completed')
        new = self.request('list')[1]['result']['items'][0]
        self.assertFalse(new['manuallyEdited'])
        self.assertEqual(new['source']['messageId'], 'new-message')

    def delayed_retain(self):
        import json
        import threading
        class Delayed(CleanupUpstream):
            started = threading.Event()
            release = threading.Event()
            finished = threading.Event()
            pending = set()
            delay = False
            def do_POST(self):
                if self.path.endswith('/memories') and self.delay:
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    bank = self.path.split('/')[4]
                    self.pending.add(body['operation_id'])
                    self.writes.append(body)
                    def complete():
                        self.started.set()
                        self.release.wait(3)
                        for item in body['items']:
                            value = {'id': item['document_id'], 'bank_id': bank, 'original_text': item['content']}
                            self.memories[(bank, item['document_id'])] = value
                            self.documents['/v1/default/banks/' + bank + '/documents/' + item['document_id']] = value
                        self.pending.remove(body['operation_id'])
                        self.finished.set()
                    threading.Thread(target=complete, daemon=True).start()
                    self.close_connection = True
                    self.connection.close()
                    return
                super().do_POST()
            def do_GET(self):
                if '/operations/' in self.path:
                    return self.reply(200, {'status': 'processing' if self.path.rsplit('/',1)[1] in self.pending else 'completed'})
                super().do_GET()
        self.upstream.RequestHandlerClass = Delayed
        return Delayed

    def test_off_waits_for_late_ignored_abort_write_and_reconciles_after_restart(self):
        from personal_memory import Metadata
        delayed = self.delayed_retain()
        self.enabled()
        self.capture()
        delayed.delay = True
        GenerationUpstream.candidates = [{'key': 'new-habit', 'category': 'habit', 'title': '工作习惯', 'content': '我先核库存。', 'evidence': '我先核库存'}]
        result = self.capture(operationId='unknown-late-auto', text='我先核库存')
        self.assertEqual(result[1]['result']['status'], 'unknown')
        off_body = {'generationEnabled': False, 'expectedRevision': 1, 'operationId': 'off-await-late-write'}
        off = self.request('settings', off_body)
        self.assertEqual(off[1]['result']['status'], 'unknown')
        self.assertEqual(len(self.request('recall', {'query': '偏好'})[1]['result']['memories']), 1)
        self.assertEqual(self.request('settings', off_body)[1]['result']['status'], 'unknown')
        self.gateway.metadata = Metadata(self.metadata.path)
        delayed.release.set()
        self.assertTrue(delayed.finished.wait(1))
        confirmed = self.request('operations', {'operationId': off_body['operationId']})[1]['result']
        self.assertEqual(confirmed['status'], 'completed')
        self.assertFalse(confirmed['state']['generationEnabled'])
        self.assertEqual([i['content'] for i in self.request('list')[1]['result']['items']], ['偏好简短中文回复。'])
        self.assertEqual(len(delayed.memories), 1)
        self.assertEqual(len(delayed.writes), 2)
        self.assertEqual(self.capture(operationId='unknown-late-auto', text='我先核库存')[1]['result']['status'], 'failed')
        self.assertEqual(len(delayed.writes), 2)

    def test_clear_quarantines_unknown_manual_edit_and_old_bank_until_physical_cleanup(self):
        from personal_memory import Metadata
        delayed = self.delayed_retain()
        self.enabled()
        self.capture()
        listed = self.request('list')[1]['result']
        delayed.delay = True
        edit_body = {'operationId': 'lost-manual-late-ack', 'id': listed['items'][0]['id'], 'expectedVersion': 1,
                     'expectedRevision': 1, 'bankGeneration': 0, 'category': 'habit', 'content': '这次人工修改会迟到。'}
        edit = self.request('update', edit_body)[1]['result']
        self.assertEqual(edit['status'], 'unknown')
        self.assertEqual(self.request('list')[1]['result']['items'], listed['items'])
        body = {'operationId': 'clear-during-manual', 'expectedRevision': edit['state']['revision'], 'bankGeneration': 0, 'confirmation': '清空'}
        cleared = self.request('clear', body)[1]['result']
        self.assertEqual(cleared['status'], 'unknown')
        self.assertEqual(cleared['state']['bankGeneration'], 1)
        self.assertEqual(self.request('clear', dict(body, operationId='second-clear-pending', expectedRevision=cleared['state']['revision'], bankGeneration=1))[0], 409)
        self.assertEqual(self.request('recall', {'query': '人工修改'})[1]['result']['memories'], [])
        self.gateway.metadata = Metadata(self.metadata.path)
        self.assertEqual(self.request('clear', body)[1]['result']['state']['bankGeneration'], 1)
        delayed.release.set()
        self.assertTrue(delayed.finished.wait(1))
        confirmed = self.request('operations', {'operationId': body['operationId']})[1]['result']
        self.assertEqual(confirmed['status'], 'completed')
        self.assertEqual(delayed.memories, {})
        self.assertEqual(self.request('operations', {'operationId': edit_body['operationId']})[1]['result']['status'], 'failed')
        self.assertEqual(self.request('update', edit_body)[1]['result']['status'], 'failed')
        self.assertEqual(len(delayed.writes), 2)
        self.assertEqual(self.request('state')[1]['result']['bankGeneration'], 1)

    def test_delete_waits_for_derivation_and_removes_parent_child_payload_receipts(self):
        import json
        class Derived(CleanupUpstream):
            busy = True
            operation_rows = {}
            def do_GET(self):
                if '/operations?' in self.path:
                    return self.reply(200, {'operations': [dict(value, operation_id=key) for key, value in self.operation_rows.items()], 'total': len(self.operation_rows)})
                if '/operations/' in self.path:
                    key = self.path.rsplit('/', 1)[1]
                    row = self.operation_rows.get(key)
                    return self.reply(200, row or {'status': 'not_found'})
                super().do_GET()
            def do_POST(self):
                if self.path.endswith('/memories/recall'):
                    self.rfile.read(int(self.headers['Content-Length']))
                    return self.reply(200, {'results': [{'document_id': None, 'text': '过期归纳'}, {'document_id': self.doc_id, 'text': '已删记忆'}, {'document_id': self.valid_id, 'text': '仍有效'}]})
                super().do_POST()
            def do_DELETE(self):
                if '/operations/' in self.path:
                    self.operation_rows.pop(self.path.split('/')[-2], None)
                    return self.reply(200, {'success': True})
                super().do_DELETE()
        self.enabled()
        self.capture()
        item = self.request('list')[1]['result']['items'][0]
        GenerationUpstream.candidates = [{'key': 'valid-background', 'category': 'background', 'title': '背景', 'content': '我负责生产。', 'evidence': '我负责生产'}]
        self.capture(operationId='unrelated-valid-document', text='我负责生产')
        Derived.valid_id = GenerationUpstream.writes[1]['items'][0]['document_id']
        Derived.doc_id = GenerationUpstream.writes[0]['items'][0]['document_id']
        Derived.operation_rows = {
            'parent-retain': {'status': 'completed', 'document_id': Derived.doc_id, 'child_operations': [{'operation_id': 'child-retain'}]},
            'child-retain': {'status': 'completed', 'document_id': None, 'task_payload': {'content': item['content']}},
            'derived-consolidation': {'status': 'processing', 'document_id': None},
        }
        self.upstream.RequestHandlerClass = Derived
        body = {'operationId': 'delete-with-derivation', 'id': item['id'], 'expectedVersion': 1, 'expectedRevision': 1, 'bankGeneration': 0}
        first = self.request('delete', body)[1]['result']
        self.assertEqual(first['status'], 'unknown')
        self.assertEqual([row['content'] for row in self.request('recall', {'query': '偏好'})[1]['result']['memories']], ['我负责生产。'])
        self.assertEqual(self.capture(operationId='blocked-old-cleanup', expectedRevision=first['state']['revision'])[0], 409)
        Derived.operation_rows['derived-consolidation']['status'] = 'completed'
        done = self.request('operations', {'operationId': body['operationId']})[1]['result']
        self.assertEqual(done['status'], 'completed')
        self.assertNotIn('parent-retain', Derived.operation_rows)
        self.assertNotIn('child-retain', Derived.operation_rows)
        self.assertEqual([row['original_text'] for row in Derived.memories.values()], ['我负责生产。'])

    def test_delete_unknown_physical_cleanup_retries_same_job_without_new_generation(self):
        class FailedDelete(CleanupUpstream):
            fail = True
            def do_DELETE(self):
                if '/documents/' in self.path and self.fail:
                    return self.reply(503, {})
                super().do_DELETE()
        self.upstream.RequestHandlerClass = FailedDelete
        self.enabled()
        self.capture()
        item = self.request('list')[1]['result']['items'][0]
        body = {'operationId': 'retry-physical-cleanup', 'id': item['id'], 'expectedVersion': 1, 'expectedRevision': 1, 'bankGeneration': 0}
        first = self.request('delete', body)[1]['result']
        self.assertEqual(first['status'], 'unknown')
        from personal_memory import Metadata
        self.gateway.metadata = Metadata(self.metadata.path)
        self.assertEqual(self.request('list')[1]['result']['state']['pendingCleanup']['operationId'], body['operationId'])
        FailedDelete.fail = False
        confirmed = self.request('delete', body)[1]['result']
        self.assertEqual(confirmed['status'], 'completed')
        self.assertEqual(confirmed['state']['bankGeneration'], 0)
        self.assertEqual(len(FailedDelete.writes), 1)
        self.assertNotIn('pendingCleanup', self.request('state')[1]['result'])

    def test_off_preserves_committed_a_when_replacement_b_is_unknown_and_writes_late(self):
        from personal_memory import Metadata
        delayed = self.delayed_retain()
        self.enabled()
        self.capture()
        original = self.request('list')[1]['result']['items'][0]
        delayed.delay = True
        GenerationUpstream.candidates = [{'key': 'response-style', 'category': 'preference', 'title': '表达偏好', 'content': '偏好详细中文回复。', 'evidence': '我喜欢详细中文回复'}]
        replacement = self.capture(operationId='unknown-replace-b', text='我喜欢详细中文回复')
        self.assertEqual(replacement[1]['result']['status'], 'unknown')
        self.assertEqual(self.request('get', {'id': original['id']})[1]['result']['item'], original)
        off_body = {'generationEnabled': False, 'expectedRevision': 1, 'operationId': 'off-preserve-committed-a'}
        off = self.request('settings', off_body)[1]['result']
        self.assertEqual(off['status'], 'unknown')
        self.assertEqual(self.request('recall', {'query': '回复方式'})[1]['result']['memories'], [original])
        self.gateway.metadata = Metadata(self.metadata.path)
        delayed.release.set()
        self.assertTrue(delayed.finished.wait(1))
        confirmed = self.request('operations', {'operationId': off_body['operationId']})[1]['result']
        self.assertEqual(confirmed['status'], 'completed')
        self.assertFalse(confirmed['state']['generationEnabled'])
        self.assertEqual(self.request('list')[1]['result']['items'], [original])
        self.assertEqual(self.request('recall', {'query': '回复方式'})[1]['result']['memories'], [original])
        self.assertEqual([doc['original_text'] for doc in delayed.memories.values()], [original['content']])
        self.assertEqual(len(delayed.writes), 2)

    def test_delete_wins_unknown_manual_edit_and_removes_the_late_body(self):
        delayed = self.delayed_retain()
        self.enabled()
        self.capture()
        original = self.request('list')[1]['result']['items'][0]
        delayed.delay = True
        edit = self.request('update', {'operationId': 'manual-before-delete', 'id': original['id'], 'expectedVersion': 1,
            'expectedRevision': 1, 'bankGeneration': 0, 'category': 'habit', 'content': '迟到的人工修改。'})[1]['result']
        body = {'operationId': 'delete-late-manual', 'id': original['id'], 'expectedVersion': 1,
            'expectedRevision': edit['state']['revision'], 'bankGeneration': 0}
        self.assertEqual(self.request('delete', body)[1]['result']['status'], 'unknown')
        delayed.release.set()
        self.assertTrue(delayed.finished.wait(1))
        self.assertEqual(self.request('operations', {'operationId': body['operationId']})[1]['result']['status'], 'completed')
        self.assertEqual(self.request('list')[1]['result']['items'], [])
        self.assertEqual(delayed.memories, {})

    def test_committed_pointer_never_rolls_back_when_old_version_gc_restarts_or_off_takes_ownership(self):
        from personal_memory import Metadata
        class FailOldDelete(CleanupUpstream):
            fail = True
            old_id = None
            def do_DELETE(self):
                if self.fail and self.path.endswith('/documents/' + self.old_id):
                    return self.reply(503, {})
                super().do_DELETE()
        self.upstream.RequestHandlerClass = FailOldDelete
        self.enabled()
        self.capture()
        FailOldDelete.old_id = GenerationUpstream.writes[0]['items'][0]['document_id']
        GenerationUpstream.candidates = [{'key': 'response-style', 'category': 'preference', 'title': '表达偏好', 'content': '偏好详细中文回复。', 'evidence': '我喜欢详细中文回复'}]
        result = self.capture(operationId='committed-new-version', text='我喜欢详细中文回复')[1]['result']
        self.assertEqual(result['status'], 'unknown')
        adopted = self.request('list')[1]['result']['items'][0]
        self.assertEqual(adopted['content'], '偏好详细中文回复。')
        self.assertEqual(adopted['version'], 2)
        self.gateway.metadata = Metadata(self.metadata.path)
        off = self.request('settings', {'generationEnabled': False, 'expectedRevision': 1, 'operationId': 'off-after-committed-new'})[1]['result']
        self.assertEqual(off['status'], 'unknown')
        FailOldDelete.fail = False
        self.assertEqual(self.request('operations', {'operationId': off['operationId']})[1]['result']['status'], 'completed')
        self.assertEqual(self.request('list')[1]['result']['items'], [adopted])
        self.assertEqual([doc['original_text'] for doc in FailOldDelete.memories.values()], [adopted['content']])

    def test_off_barrier_overtakes_normal_delayed_ack_before_automatic_pointer_commit(self):
        import json
        import threading
        import time
        class DelayedAck(CleanupUpstream):
            delay = False
            started = threading.Event()
            release = threading.Event()
            pending = set()
            def do_POST(self):
                if self.path.endswith('/memories') and self.delay:
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    bank = self.path.split('/')[4]
                    self.pending.add(body['operation_id'])
                    self.started.set()
                    self.release.wait(4)
                    for item in body['items']:
                        value = {'id': item['document_id'], 'bank_id': bank, 'original_text': item['content']}
                        self.memories[(bank, item['document_id'])] = value
                        self.documents['/v1/default/banks/' + bank + '/documents/' + item['document_id']] = value
                    self.writes.append(body)
                    self.pending.remove(body['operation_id'])
                    return self.reply(200, {'success': True, 'operation_id': body['operation_id']})
                super().do_POST()
            def do_GET(self):
                if '/operations/' in self.path:
                    return self.reply(200, {'status': 'processing' if self.path.rsplit('/', 1)[1] in self.pending else 'completed'})
                super().do_GET()
        self.upstream.RequestHandlerClass = DelayedAck
        self.enabled()
        self.capture()
        original = self.request('list')[1]['result']['items'][0]
        DelayedAck.delay = True
        GenerationUpstream.candidates = [{'key': 'response-style', 'category': 'preference', 'title': '表达偏好', 'content': '偏好详细中文回复。', 'evidence': '我喜欢详细中文回复'}]
        captured = []
        worker = threading.Thread(target=lambda: captured.append(self.capture(operationId='normal-late-ack-b', text='我喜欢详细中文回复')))
        worker.start()
        self.assertTrue(DelayedAck.started.wait(1))
        try:
            started = time.monotonic()
            off = self.request('settings', {'generationEnabled': False, 'expectedRevision': 1, 'operationId': 'off-before-normal-ack'})[1]['result']
            self.assertLess(time.monotonic() - started, 1, 'OFF must advance its barrier while the retain ACK is still pending')
            self.assertEqual(off['status'], 'unknown')
            self.assertEqual(self.request('get', {'id': original['id']})[1]['result']['item'], original)
            self.assertEqual(self.request('state', token='b')[0], 200)
        finally:
            DelayedAck.release.set()
            worker.join()
        self.assertEqual(captured[0][1]['result']['status'], 'failed')
        self.assertEqual(captured[0][1]['result']['errorCode'], 'MEMORY_VERSION_CONFLICT')
        confirmed = self.request('operations', {'operationId': off['operationId']})[1]['result']
        self.assertEqual(confirmed['status'], 'completed')
        self.assertFalse(confirmed['state']['generationEnabled'])
        self.assertEqual(self.request('recall', {'query': '偏好'})[1]['result']['memories'], [original])
        self.assertEqual([doc['original_text'] for doc in DelayedAck.memories.values()], [original['content']])

    def test_partial_generation_restart_cleans_unconfirmed_candidate_without_rolling_back_adopted_version(self):
        from personal_memory import Metadata
        class LostLastReceipt(CleanupUpstream):
            def reply(self, status, body):
                if self.path.endswith('/memories') and len(self.writes) == 3:
                    self.close_connection = True
                    self.connection.close()
                    return
                super().reply(status, body)
        self.upstream.RequestHandlerClass = LostLastReceipt
        self.enabled()
        self.capture()
        GenerationUpstream.candidates = [
            {'key': 'response-style', 'category': 'preference', 'title': '表达偏好', 'content': '偏好详细回复。', 'evidence': '我喜欢详细回复'},
            {'key': 'new-work', 'category': 'background', 'title': '工作背景', 'content': '我负责生产。', 'evidence': '我负责生产'},
        ]
        result = self.capture(operationId='partial-generation', text='我喜欢详细回复，我负责生产')[1]['result']
        self.assertEqual(result['status'], 'unknown')
        self.gateway.metadata = Metadata(self.metadata.path)
        reconciled = self.request('operations', {'operationId': result['operationId']})[1]['result']
        self.assertEqual(reconciled['status'], 'failed')
        self.assertEqual([row['content'] for row in self.request('list')[1]['result']['items']], ['偏好详细回复。'])
        self.assertEqual([row['original_text'] for row in LostLastReceipt.memories.values()], ['偏好详细回复。'])

    def test_first_unknown_candidate_is_abandoned_and_cleaned_after_restart_without_control_action(self):
        from personal_memory import Metadata
        delayed = self.delayed_retain()
        self.enabled()
        delayed.delay = True
        result = self.capture(operationId='first-unknown-no-control')[1]['result']
        self.assertEqual(result['status'], 'unknown')
        self.gateway.metadata = Metadata(self.metadata.path)
        delayed.release.set()
        self.assertTrue(delayed.finished.wait(1))
        reconciled = self.request('operations', {'operationId': result['operationId']})[1]['result']
        self.assertEqual(reconciled['status'], 'failed')
        self.assertEqual(self.request('list')[1]['result']['items'], [])
        self.assertEqual(delayed.memories, {})
        delayed.delay = False
        self.assertEqual(self.capture(operationId='fresh-turn-after-abandoned')[1]['result']['status'], 'completed')
        self.assertEqual(len(self.request('list')[1]['result']['items']), 1)

    def test_off_abandons_pending_manual_candidate_preserving_confirmed_current(self):
        from personal_memory import Metadata
        delayed = self.delayed_retain()
        self.enabled()
        self.capture()
        original = self.request('list')[1]['result']['items'][0]
        delayed.delay = True
        edit = self.request('update', {'operationId': 'manual-pending-before-off', 'id': original['id'], 'expectedVersion': 1,
            'expectedRevision': 1, 'bankGeneration': 0, 'category': 'habit', 'content': '不能替换 A 的迟到人工 B。'})[1]['result']
        self.assertEqual(edit['status'], 'unknown')
        self.assertEqual(self.request('list')[1]['result']['items'], [original])
        off = self.request('settings', {'generationEnabled': False, 'expectedRevision': edit['state']['revision'],
            'operationId': 'off-pending-manual'})[1]['result']
        self.assertEqual(off['status'], 'unknown')
        self.gateway.metadata = Metadata(self.metadata.path)
        delayed.release.set()
        self.assertTrue(delayed.finished.wait(1))
        confirmed = self.request('operations', {'operationId': off['operationId']})[1]['result']
        self.assertEqual(confirmed['status'], 'completed')
        self.assertFalse(confirmed['state']['generationEnabled'])
        self.assertEqual(self.request('operations', {'operationId': edit['operationId']})[1]['result']['status'], 'failed')
        self.assertEqual(self.request('list')[1]['result']['items'], [original])
        self.assertEqual([row['original_text'] for row in delayed.memories.values()], [original['content']])

    def test_partial_new_generation_without_old_gc_keeps_adopted_item_and_abandons_unknown_item(self):
        from personal_memory import Metadata
        class LostSecondReceipt(CleanupUpstream):
            def reply(self, status, body):
                if self.path.endswith('/memories') and len(self.writes) == 2:
                    self.close_connection = True
                    self.connection.close()
                    return
                super().reply(status, body)
        self.upstream.RequestHandlerClass = LostSecondReceipt
        self.enabled()
        GenerationUpstream.candidates = [
            {'key': 'response-style', 'category': 'preference', 'title': '表达偏好', 'content': '偏好详细回复。', 'evidence': '我喜欢详细回复'},
            {'key': 'new-work', 'category': 'background', 'title': '工作背景', 'content': '我负责生产。', 'evidence': '我负责生产'},
        ]
        result = self.capture(operationId='partial-first-generation', text='我喜欢详细回复，我负责生产')[1]['result']
        self.assertEqual(result['status'], 'unknown')
        self.gateway.metadata = Metadata(self.metadata.path)
        listed = self.request('list')[1]['result']['items']
        self.assertEqual([row['content'] for row in listed], ['偏好详细回复。'])
        self.assertEqual(self.request('operations', {'operationId': result['operationId']})[1]['result']['status'], 'failed')
        self.assertEqual([row['original_text'] for row in LostSecondReceipt.memories.values()], ['偏好详细回复。'])

    def test_abandoned_candidate_cleanup_resumes_parent_child_payload_deletion_after_partial_failure(self):
        from personal_memory import Metadata
        class ReceiptCleanup(CleanupUpstream):
            rows = {}
            fail_delete = True
            def do_POST(self):
                if self.path.endswith('/memories'):
                    super().do_POST()
                    parent = self.writes[-1]['operation_id']
                    self.rows[parent] = {'operation_id': parent, 'status': 'processing',
                        'document_id': self.writes[-1]['items'][0]['document_id'],
                        'child_operations': [{'operation_id': 'child-with-payload'}]}
                    self.rows['child-with-payload'] = {'operation_id': 'child-with-payload', 'status': 'processing',
                        'document_id': None, 'task_payload': {'content': '正文只在后端'}}
                    return
                super().do_POST()
            def do_GET(self):
                if '/operations?' in self.path:
                    return self.reply(200, {'operations': list(self.rows.values()), 'total': len(self.rows)})
                if '/operations/' in self.path:
                    return self.reply(200, self.rows.get(self.path.rsplit('/', 1)[1], {'status': 'not_found'}))
                super().do_GET()
            def do_DELETE(self):
                if '/operations/' in self.path:
                    operation = self.path.split('/')[-2]
                    if operation == 'child-with-payload' and self.fail_delete:
                        return self.reply(503, {})
                    self.rows.pop(operation, None)
                    return self.reply(200, {'success': True})
                super().do_DELETE()
        self.upstream.RequestHandlerClass = ReceiptCleanup
        self.gateway.timeout = 0.1
        self.enabled()
        result = self.capture(operationId='unknown-with-parent-child')[1]['result']
        self.assertEqual(result['status'], 'unknown')
        for row in ReceiptCleanup.rows.values():
            row['status'] = 'completed'
        self.gateway.metadata = Metadata(self.metadata.path)
        first = self.request('operations', {'operationId': result['operationId']})[1]['result']
        self.assertEqual(first['status'], 'unknown')
        self.assertEqual(ReceiptCleanup.memories, {})
        self.assertIn('child-with-payload', ReceiptCleanup.rows)
        self.gateway.metadata = Metadata(self.metadata.path)
        ReceiptCleanup.fail_delete = False
        self.assertEqual(self.request('operations', {'operationId': result['operationId']})[1]['result']['status'], 'failed')
        self.assertEqual(ReceiptCleanup.rows, {})
        self.assertEqual(self.request('list')[1]['result']['items'], [])

    def test_late_manual_poll_cannot_restore_processing_after_off_finishes_cleanup(self):
        import threading
        class LatePoll(CleanupUpstream):
            started = threading.Event()
            release = threading.Event()
            paused = False
            def do_GET(self):
                if '/operations/' in self.path and not self.paused:
                    type(self).paused = True
                    self.started.set()
                    self.release.wait(3)
                    return self.reply(200, {'status': 'processing'})
                super().do_GET()
        self.enabled()
        self.capture()
        original = self.request('list')[1]['result']['items'][0]
        self.upstream.RequestHandlerClass = LatePoll
        outputs = []
        worker = threading.Thread(target=lambda: outputs.append(self.request('update', {
            'operationId': 'manual-poll-overtaken', 'id': original['id'], 'expectedVersion': 1,
            'expectedRevision': 1, 'bankGeneration': 0, 'category': 'habit', 'content': '已被关闭超越的编辑。'})))
        worker.start()
        self.assertTrue(LatePoll.started.wait(1))
        try:
            off = self.request('settings', {'generationEnabled': False, 'expectedRevision': 2,
                'operationId': 'off-overtakes-manual-poll'})[1]['result']
            self.assertEqual(off['status'], 'completed')
        finally:
            LatePoll.release.set()
            worker.join()
        self.assertEqual(outputs[0][1]['result']['status'], 'failed')
        self.assertEqual(self.request('operations', {'operationId': 'manual-poll-overtaken'})[1]['result']['status'], 'failed')
        self.assertEqual(self.request('list')[1]['result']['items'], [original])

    def strict_receipt_backend(self):
        import json
        import threading
        class Receipts(CleanupUpstream):
            rows = {}
            purged = set()
            delay = False
            started = threading.Event()
            release = threading.Event()
            finished = threading.Event()
            def do_POST(self):
                if self.path.endswith('/memories'):
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    parent = body['operation_id']
                    if parent in self.purged:
                        return self.reply(409, {'success': False})
                    bank = self.path.split('/')[4]
                    child = parent + '-child'
                    self.rows[parent] = {'operation_id': parent, 'bank_id': bank, 'status': 'processing',
                        'document_id': body['items'][0]['document_id'], 'child_operations': [{'operation_id': child}]}
                    self.rows[child] = {'operation_id': child, 'bank_id': bank, 'status': 'processing',
                        'document_id': None, 'task_payload': body}
                    if self.delay:
                        self.started.set()
                        self.release.wait(3)
                    for item in body['items']:
                        value = {'id': item['document_id'], 'bank_id': bank, 'original_text': item['content']}
                        self.memories[(bank, item['document_id'])] = value
                        self.documents['/v1/default/banks/' + bank + '/documents/' + item['document_id']] = value
                    self.writes.append(body)
                    self.rows[parent]['status'] = self.rows[child]['status'] = 'completed'
                    self.finished.set()
                    try:
                        return self.reply(200, {'success': True, 'operation_id': parent})
                    except BrokenPipeError:
                        return
                super().do_POST()
            def do_GET(self):
                if '/operations?' in self.path:
                    bank = self.path.split('/')[4]
                    rows = [row for row in self.rows.values() if row['bank_id'] == bank]
                    return self.reply(200, {'operations': rows, 'total': len(rows)})
                if '/operations/' in self.path:
                    row = self.rows.get(self.path.rsplit('/', 1)[1])
                    return self.reply(200, row or {'status': 'not_found'})
                super().do_GET()
            def do_DELETE(self):
                if '/operations/' in self.path:
                    operation = self.path.split('/')[-2]
                    self.rows.pop(operation, None)
                    self.purged.add(operation)
                    return self.reply(200, {'success': True})
                super().do_DELETE()
        self.upstream.RequestHandlerClass = Receipts
        return Receipts

    def test_cleared_late_retain_receipts_do_not_block_repeated_clear_new_turn_or_restart(self):
        import threading
        from personal_memory import Gateway, Metadata, make_server
        backend = self.strict_receipt_backend()
        self.enabled()
        self.gateway.timeout = 0.3
        backend.delay = True
        captured = []
        caller = threading.Thread(target=lambda: captured.append(self.capture(operationId='late-retain-before-first-clear')))
        caller.start()
        self.assertTrue(backend.started.wait(1))
        try:
            first = self.request('clear', {'operationId': 'first-clear-during-retain', 'expectedRevision': 1,
                'bankGeneration': 0, 'confirmation': '清空'})[1]['result']
            self.assertEqual(first['status'], 'unknown')
            caller.join(timeout=2)
            self.assertFalse(caller.is_alive())
        finally:
            backend.release.set()
            caller.join()
        self.assertTrue(backend.finished.wait(1))
        self.assertIn(captured[0][1]['result']['status'], ('failed', 'unknown'))
        self.assertEqual(self.request('operations', {'operationId': first['operationId']})[1]['result']['status'], 'completed')
        self.assertEqual(backend.rows, {})
        self.assertEqual(backend.memories, {})
        second = self.request('clear', {'operationId': 'second-clear-after-purge', 'expectedRevision': 2,
            'bankGeneration': 1, 'confirmation': '清空'})[1]['result']
        self.assertEqual(second['status'], 'completed')
        backend.delay = False
        fresh = self.capture(operationId='fresh-turn-after-repeat-clear', expectedRevision=3, bankGeneration=2)
        self.assertEqual(fresh[1]['result']['status'], 'completed')
        current = self.request('list')[1]['result']['items']
        self.assertEqual(len(current), 1)
        self.server.shutdown()
        self.server.server_close()
        base = 'http://127.0.0.1:' + str(self.upstream.server_port)
        self.gateway = Gateway(Metadata(self.metadata.path), {'production': base}, base, 'backend-secret',
            model_url=base, model_key='model-only-secret', model_name='fixture')
        self.server = make_server(('127.0.0.1', 0), self.gateway)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.assertEqual(self.request('list')[1]['result']['items'], current)
        final = self.request('clear', {'operationId': 'clear-after-source-restart', 'expectedRevision': 3,
            'bankGeneration': 2, 'confirmation': '清空'})[1]['result']
        self.assertEqual(final['status'], 'completed')
        self.assertEqual(backend.rows, {})
        self.assertEqual(backend.memories, {})

    def test_not_found_without_a_completed_clear_in_this_scope_stays_unknown(self):
        backend = self.strict_receipt_backend()
        class HiddenReceipt(backend):
            hidden = True
            def do_GET(self):
                if self.hidden and '/operations/' in self.path:
                    return self.reply(200, {'status': 'not_found'})
                super().do_GET()
        self.upstream.RequestHandlerClass = HiddenReceipt
        self.enabled()
        other = self.request('clear', {'operationId': 'completed-clear-other-scope', 'expectedRevision': 0,
            'bankGeneration': 0, 'confirmation': '清空'}, token='b')[1]['result']
        self.assertEqual(other['status'], 'completed')
        self.gateway.timeout = 0.1
        unknown = self.capture(operationId='unproven-retain-not-found')[1]['result']
        self.assertEqual(unknown['status'], 'unknown')
        cleared = self.request('clear', {'operationId': 'unproven-clear-not-found', 'expectedRevision': 1,
            'bankGeneration': 0, 'confirmation': '清空'})[1]['result']
        self.assertEqual(cleared['status'], 'unknown')
        self.assertEqual(self.request('operations', {'operationId': cleared['operationId']})[1]['result']['status'], 'unknown')
        self.assertTrue(backend.memories)
        self.assertTrue(backend.rows)
        HiddenReceipt.hidden = False
        self.assertEqual(self.request('operations', {'operationId': cleared['operationId']})[1]['result']['status'], 'completed')
        self.assertEqual(backend.memories, {})
        self.assertEqual(backend.rows, {})
