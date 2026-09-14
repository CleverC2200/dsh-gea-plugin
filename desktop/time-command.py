"""Measure an exact command, keeping its raw output and exit code beside a timing record."""
from pathlib import Path
import subprocess,sys,time,datetime,json
record=Path(sys.argv[1]);record.parent.mkdir(parents=True,exist_ok=True)
start=datetime.datetime.now(datetime.timezone.utc).isoformat();timer=time.perf_counter()
with record.with_suffix('.log').open('wb')as log:
 code=subprocess.call(sys.argv[2:],stdout=log,stderr=subprocess.STDOUT)
r={'startedUtc':start,'endedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsedSeconds':round(time.perf_counter()-timer,3),'command':sys.argv[2:],'exitCode':code}
record.write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps(r,ensure_ascii=False));sys.exit(code)
