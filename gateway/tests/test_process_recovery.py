import json
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from test_generation import GenerationHTTPFixture, GenerationUpstream


class ProcessRecoveryTests(GenerationHTTPFixture):
    def start_process(self):
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('process_fixture.py')),
            str(Path(self.tmp.name) / 'process.sqlite'), 'http://127.0.0.1:' + str(self.upstream.server_port)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def stop():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        self.addCleanup(stop)
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(process.stderr.read())
        return process, json.loads(line)['port']

    def process_request(self, port, endpoint, body=None):
        request = urllib.request.Request('http://127.0.0.1:' + str(port) + '/v1/memory/' + endpoint,
            data=json.dumps(body or {}).encode(), method='POST',
            headers={'X-Access-Token': 'a', 'X-GEA-Environment': 'production', 'Content-Type': 'application/json'})
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        return response.status, json.load(response)

    def kill_during_generation(self, stage):
        accepted, release = threading.Event(), threading.Event()
        class AcceptedRetain(GenerationUpstream):
            def reply(self, status, body):
                if stage == 'retain' and self.path.endswith('/memories'):
                    accepted.set()
                    release.wait(5)
                try:
                    super().reply(status, body)
                except BrokenPipeError:
                    pass
        self.upstream.RequestHandlerClass = AcceptedRetain
        if stage == 'model':
            GenerationUpstream.model_started, GenerationUpstream.model_release = accepted, release
        process, port = self.start_process()
        self.process_request(port, 'settings', {'generationEnabled': True, 'expectedRevision': 0, 'operationId': 'enable-process-memory'})
        body = {'operationId': 'interrupted-generation', 'expectedRevision': 1, 'bankGeneration': 0,
                'text': '我喜欢简短中文回复', 'source': {'sessionId': 'process-session', 'messageId': 'process-message', 'time': '2026-10-29T00:00:00Z'}}
        errors = []
        def generate():
            try:
                self.process_request(port, 'generate', body)
            except Exception as error:
                errors.append(type(error).__name__)
        caller = threading.Thread(target=generate)
        caller.start()
        self.assertTrue(accepted.wait(2))
        self.assertEqual(self.process_request(port, 'operations', {'operationId': body['operationId']})[1]['result']['status'], 'processing')
        if stage == 'retain':
            contender = subprocess.run([sys.executable, str(Path(__file__).with_name('process_fixture.py')),
                str(Path(self.tmp.name) / 'process.sqlite'), 'http://127.0.0.1:' + str(self.upstream.server_port)],
                capture_output=True, text=True, timeout=3)
            self.assertNotEqual(contender.returncode, 0)
            self.assertIn('MEMORY_GATEWAY_ALREADY_RUNNING', contender.stderr)
            self.assertEqual(self.process_request(port, 'operations', {'operationId': body['operationId']})[1]['result']['status'], 'processing')
        process.kill()
        process.wait(timeout=5)
        caller.join(timeout=2)
        self.assertTrue(errors)
        release.set()
        GenerationUpstream.model_started = None
        self.upstream.RequestHandlerClass = GenerationUpstream
        restarted, new_port = self.start_process()
        result = self.process_request(new_port, 'operations', {'operationId': body['operationId']})[1]['result']
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(self.process_request(new_port, 'list')[1]['result']['items'], [])
        self.assertEqual(GenerationUpstream.memories, {})
        fresh = self.process_request(new_port, 'generate', dict(body, operationId='fresh-after-process-death'))
        self.assertEqual(fresh[1]['result']['status'], 'completed')
        self.assertEqual(len(self.process_request(new_port, 'list')[1]['result']['items']), 1)

    def test_process_death_after_backend_acceptance_cleans_abandoned_candidate_and_allows_new_turn(self):
        self.kill_during_generation('retain')

    def test_process_death_during_model_without_candidate_finishes_interrupted_operation(self):
        self.kill_during_generation('model')
