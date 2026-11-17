import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from personal_memory import Gateway, Metadata, make_server

base = sys.argv[2]
gateway = Gateway(Metadata(sys.argv[1]), {'production': base}, base, 'fixture-hindsight',
                  timeout=10, model_url=base, model_key='fixture-model', model_name='fixture')
server = make_server(('127.0.0.1', 0), gateway)
print(json.dumps({'port': server.server_port}), flush=True)
server.serve_forever()
