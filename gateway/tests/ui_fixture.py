import json
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from personal_memory import Gateway, Metadata, make_server
from test_generation import GenerationUpstream
from test_cleanup import CleanupUpstream

upstream = ThreadingHTTPServer(('127.0.0.1', 0), CleanupUpstream)
threading.Thread(target=upstream.serve_forever, daemon=True).start()
base = 'http://127.0.0.1:' + str(upstream.server_port)
gateway = Gateway(Metadata(sys.argv[1]), {'production': base, 'test': base}, base, 'synthetic-backend-key',
                  model_url=base, model_key='synthetic-model-key', model_name='fixture')
server = make_server(('127.0.0.1', 0), gateway)
threading.Thread(target=server.serve_forever, daemon=True).start()

def request(endpoint, body):
    req = urllib.request.Request('http://127.0.0.1:' + str(server.server_port) + '/v1/memory/' + endpoint,
        data=json.dumps(body).encode(), headers={'X-Access-Token': 'a', 'X-GEA-Environment': 'production', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as response:
        return json.load(response)['result']

state = request('settings', {'generationEnabled': True, 'expectedRevision': 0, 'operationId': 'fixture-enable'})['state']
examples = [('preference','使用中文，先给结论再展开说明','我喜欢回答尽量简洁，结合具体业务场景给出建议。'),('background','关注产销协同与企业 AI 应用','我负责计划、生产、库存之间的衔接。'),('habit','方案需要明确负责人和验收标准','我习惯行动建议同时说明下一步与预期结果。'),('preference','优先用表格呈现多方案对比','我偏好对比方案时列出适用场景、收益和限制。')]
for index, (category, title, content) in enumerate(examples):
    GenerationUpstream.candidates = [{'key': 'fixture-' + str(index), 'category': category, 'title': title, 'content': content, 'evidence': content}]
    result = request('generate', {'operationId': 'fixture-generate-' + str(index), 'expectedRevision': state['revision'], 'bankGeneration': 0,
        'source': {'sessionId': 'synthetic-session', 'messageId': 'synthetic-message-' + str(index), 'time': '2026-10-29T02:24:00Z'}, 'text': content})
    if result['status'] != 'completed':
        raise RuntimeError(result['errorCode'])
request('settings', {'generationEnabled': False, 'expectedRevision': state['revision'], 'operationId': 'fixture-disable'})
print(json.dumps({'port': server.server_port}), flush=True)
threading.Event().wait()
