import json
import sys
import threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from personal_memory import Gateway, Metadata, make_server
from test_generation import GenerationUpstream
from http.server import ThreadingHTTPServer

GenerationUpstream.candidates = [{'key': 'response-style', 'category': 'preference', 'title': '表达偏好', 'content': '偏好简短中文回复。', 'evidence': '我喜欢简短中文回复'}]
upstream = ThreadingHTTPServer(('127.0.0.1', 0), GenerationUpstream)
threading.Thread(target=upstream.serve_forever, daemon=True).start()
base = 'http://127.0.0.1:' + str(upstream.server_port)
gateway = Gateway(Metadata(sys.argv[1]), {'production': base}, base, 'fixture-hindsight',
                  model_url=base, model_key='fixture-model', model_name='fixture')
server = make_server(('127.0.0.1', 0), gateway)
print(json.dumps({'port': server.server_port}), flush=True)
server.serve_forever()
