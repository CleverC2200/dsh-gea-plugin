import socket
import threading
import time
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from test_generation import GenerationHTTPFixture, GenerationUpstream


class ModelConnectHTTPTests(GenerationHTTPFixture):
    def model_endpoint(self):
        class Model(GenerationUpstream):
            received = 0
            failure = None
            def do_POST(self):
                if self.path == '/chat/completions':
                    type(self).received += 1
                    if self.failure:
                        self.rfile.read(int(self.headers['Content-Length']))
                        if self.failure == 'http':
                            return self.reply(503, {})
                        self.close_connection = True
                        self.connection.close()
                        return
                super().do_POST()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.gateway.model_url = 'http://127.0.0.1:' + str(server.server_port)
        return server, Model

    @contextmanager
    def refused_connections(self, port, failures):
        closed = socket.socket()
        closed.bind(('127.0.0.1', 0))
        address_refused = closed.getsockname()
        closed.close()
        original = socket.create_connection
        attempts = []
        def connect(address, *args, **kwargs):
            if address[1] == port:
                attempts.append(address)
                if len(attempts) <= failures:
                    return original(address_refused, *args, **kwargs)
            return original(address, *args, **kwargs)
        with patch('socket.create_connection', connect):
            yield attempts

    def test_one_refused_model_connection_recovers_with_one_retain_and_no_operation_replay(self):
        server, model = self.model_endpoint()
        self.enabled()
        with self.refused_connections(server.server_port, 1) as attempts:
            result = self.capture()[1]['result']
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(attempts), 2)
        self.assertEqual(model.received, 1)
        self.assertEqual(len(GenerationUpstream.writes), 1)
        self.assertEqual(len(self.request('list')[1]['result']['items']), 1)
        self.assertEqual(self.capture()[1]['result']['status'], 'completed')
        self.assertEqual((model.received, len(GenerationUpstream.writes)), (1, 1))

    def test_repeated_connection_refusal_is_bounded_and_leaves_future_turn_usable(self):
        server, model = self.model_endpoint()
        self.enabled()
        started = time.monotonic()
        with self.refused_connections(server.server_port, 10) as attempts:
            result = self.capture()[1]['result']
        self.assertEqual((result['status'], result['errorCode']), ('failed', 'MEMORY_BACKEND_UNAVAILABLE'))
        self.assertEqual(len(attempts), 2)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual((model.received, len(GenerationUpstream.writes)), (0, 0))
        self.assertEqual(self.request('list')[1]['result']['items'], [])
        fresh = self.capture(operationId='fresh-after-refused-connect')[1]['result']
        self.assertEqual(fresh['status'], 'completed')
        self.assertEqual((model.received, len(GenerationUpstream.writes)), (1, 1))
        self.assertEqual(self.capture()[1]['result']['status'], 'failed')
        self.assertEqual((model.received, len(GenerationUpstream.writes)), (1, 1))

    def test_http_failure_accepted_request_disconnect_and_non_model_refusal_are_not_retried(self):
        server, model = self.model_endpoint()
        self.enabled()
        for failure in ('http', 'disconnect'):
            with self.subTest(failure=failure):
                model.failure = failure
                before = model.received
                result = self.capture(operationId='model-failure-' + failure)[1]['result']
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(model.received, before + 1)
                self.assertEqual(GenerationUpstream.writes, [])
        with self.refused_connections(self.upstream.server_port, 10) as attempts:
            status, result = self.request('state')
        self.assertEqual((status, result['errorCode']), (503, 'MEMORY_IDENTITY_UNAVAILABLE'))
        self.assertEqual(len(attempts), 1)
        model.failure = None
        self.gateway.hindsight_url = 'http://127.0.0.1:' + str(server.server_port)
        self.gateway.model_url = 'http://127.0.0.1:' + str(self.upstream.server_port)
        with self.refused_connections(server.server_port, 10) as bank_attempts:
            result = self.capture(operationId='bank-connect-refused')[1]['result']
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(len(bank_attempts), 1)
        self.assertEqual(GenerationUpstream.writes, [])

    def test_submitted_retain_with_lost_ack_does_not_retry_model_or_retain(self):
        server, model = self.model_endpoint()
        class LostAck(GenerationUpstream):
            def reply(self, status, body):
                if self.path.endswith('/memories'):
                    self.close_connection = True
                    self.connection.close()
                    return
                super().reply(status, body)
        self.upstream.RequestHandlerClass = LostAck
        self.enabled()
        result = self.capture()[1]['result']
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual((model.received, len(GenerationUpstream.writes)), (1, 1))
        self.assertEqual(self.capture()[1]['result']['status'], 'failed')
        self.assertEqual((model.received, len(GenerationUpstream.writes)), (1, 1))
