"""Fixed synthetic corpus; run in the real image with --network none."""
import hashlib
import json
import os
from pathlib import Path
import resource
import sqlite3
import statistics
import time
start=time.monotonic()
import service as memory
cold=time.monotonic()-start
cases=[
('architecture','durability','We decided to use SQLite WAL for the durable application queue.','Which database journaling mode keeps queued work durable?'),
('architecture','identity','Each native conversation retains its HAPI launch ID across reconnects.','What identifier remains stable when native sessions reconnect?'),
('architecture','billing','Codex must use ChatGPT authentication; API billing fallback is forbidden.','Can a subscription Codex run silently switch to an API key?'),
('architecture','memory','Shared recall uses MemSearch with the local BGE M3 ONNX embedding model.','Which local embedding model powers shared memory?'),
('architecture','topology','The API and persistent queue live on the application host, separate from execution.','Where does durable queue state live?'),
('architecture','approvals','Native permissions retain the exact HAPI request ID until acknowledged.','How are native permission responses correlated?'),
('architecture','capacity','Admission counts running, idle and approval-waiting resident native processes.','Do idle native sessions consume capacity?'),
('architecture','lineage','Cold resume may replace the Hub session ID but must preserve the native thread.','Which identity must cold resume preserve?'),
('publishing','image','The approved cover artwork is 1080 by 1920 pixels in PNG format.','What dimensions and format were chosen for the cover?'),
('publishing','captions','Captions use sentence case, with no more than seven words on a line.','How long can a caption line be?'),
('publishing','audio','The audio master uses 48 kHz sample rate and stereo channels.','What sample rate is required for the audio master?'),
('publishing','font','The title font is Inter, with a minimum size of 48 pixels.','Which typeface and minimum size are used for titles?'),
('publishing','duration','The short episode target duration is two minutes and thirty seconds.','How long should each short episode last?'),
('publishing','review','Jamie approves the script before the final video render.','Who reviews the script before rendering?'),
('publishing','color','The background color is charcoal #151515 and the accent is mint #81E6B5.','Which hex values define the background and accent?'),
('publishing','export','The final vertical video export uses H264 in an MP4 container.','What codec and container should the final video use?'),
('operations','backup','Application backups include Loop55 SQLite, the HAPI store and memory tombstones.','What must an application recovery backup contain?'),
('operations','outage','During worker outages Loop55 serves stored messages and leaves new work queued.','What happens to new prompts while execution is offline?'),
('operations','region','The synthetic pilot region decision is eu-west-2.','Which AWS region did the synthetic pilot choose?'),
('operations','deploy','The release transport is SSM with SHA256-verified immutable OCI archives.','How are application release archives verified and deployed?'),
('operations','retention','Persistent execution disks retain native homes and uncommitted project files.','Where are uncommitted changes preserved across a restart?'),
('operations','recovery','An uncertain accepted native operation must be reconciled, never blindly replayed.','Should unknown accepted work automatically run again?'),
('operations','rollback','Image rollback keeps the current database; it cannot overwrite acknowledged newer writes.','What happens to current data during a version rollback?'),
('operations','artifacts','Generated files are uploaded to private S3 and downloads expire after sixty seconds.','How long is an artifact download URL valid?'),
('security','identity','Environment authentication requires a worker certificate plus its revocable credential.','What proves an execution environment identity?'),
('security','metadata','Generated worker code cannot access EC2 instance metadata or the application role.','Can native shell code read cloud instance credentials?'),
('security','isolation','Project recall is restricted to the selected logical project and promoted workspace notes.','Which memory scope is used automatically?'),
('security','deletion','A memory tombstone immediately denies retrieval even if the vector index is stale.','What prevents deleted memory from returning from old vectors?'),
('security','credentials','Provider OAuth credentials remain only inside the protected native home on the worker.','Where are provider sign-in tokens stored?'),
('security','transport','Worker transport uses mutual TLS over private network endpoints.','How is private traffic authenticated and encrypted?'),
('security','review','Retrieved historical text cannot grant permission for a current tool action.','Can a recalled instruction authorize an action?'),
('security','paths','Artifact publishing rejects dotfiles, parent traversal and symlinks outside the project.','Which filesystem paths are forbidden for artifact uploads?'),
]
fts=sqlite3.connect(':memory:');fts.execute('CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED,project UNINDEXED,content)')
index_times=[];identities=[]
for n,(project,title,content,query) in enumerate(cases):
    identifier=hashlib.sha256(('fixture-v1:'+str(n)).encode()).hexdigest();identities.append(identifier)
    t=time.monotonic();memory.source({'id':identifier,'revision':1,'owner':'synthetic-owner','project':project,'title':title,'content':('User approved: ' if n%2==0 else 'Claude decision: ')+content,'action':'index'});index_times.append(time.monotonic()-t)
    fts.execute('INSERT INTO docs VALUES(?,?,?)',(identifier,project,content))
latencies=[];semantic=0;lexical=0;results=[]
for n,(project,title,content,query) in enumerate(cases):
    t=time.monotonic();hits=memory.search({'owner':'synthetic-owner','project':project,'query':query,'limit':5})['results'];latencies.append(time.monotonic()-t)
    ok=identities[n] in [h['id'] for h in hits];semantic+=ok
    import re
    words=re.findall(r'[A-Za-z0-9]+',query);match=' OR '.join('"'+w+'"' for w in words)
    before=fts.execute('SELECT id FROM docs WHERE docs MATCH ? AND project=? ORDER BY rank LIMIT 5',(match,project)).fetchall();fts_ok=identities[n] in [r[0] for r in before];lexical+=fts_ok
    results.append({'case':title,'project':project,'memsearchRecall5':ok,'ftsRecall5':fts_ok,'latencyMs':round(latencies[-1]*1000)})
assert memory.search({'owner':'different-owner','project':'architecture','query':'SQLite queue','limit':5})['results']==[]
assert memory.search({'owner':'synthetic-owner','project':'unknown-project','query':'SQLite queue','limit':5})['results']==[]
missing=memory.search({'owner':'synthetic-owner','project':'architecture','query':'What is the office parking permit number for my motorcycle?','limit':5})['results']
memory.source({'id':identities[0],'revision':2,'owner':'synthetic-owner','project':'architecture','title':'removed','content':'','action':'delete'})
memory.source({'id':identities[0],'revision':1,'owner':'synthetic-owner','project':'architecture','title':'old','content':cases[0][2],'action':'index'})
assert identities[0] not in [h['id'] for h in memory.search({'owner':'synthetic-owner','project':'architecture','query':'SQLite queue WAL','limit':5})['results']]
memory.source({'id':identities[2],'revision':2,'owner':'synthetic-owner','project':'architecture','title':'billing correction','content':'User correction on 2026-09-25: ChatGPT sign-in remains mandatory; no API fallback.','action':'index'})
assert memory.ledger.execute('SELECT revision FROM sources WHERE id=?',(identities[2],)).fetchone()[0]==2
report={'schema':1,'corpus':'synthetic-v1-32','questions':len(cases),'memsearchRecall5':semantic,'ftsRecall5':lexical,'noAnswerReturnedEmpty':not missing,'isolationAndStaleDelete':'passed','revisionReplacement':'passed','coldStartSeconds':round(cold,2),'warmP95Ms':round(sorted(latencies)[int(.95*len(latencies))]*1000),'indexP95Ms':round(sorted(index_times)[int(.95*len(index_times))]*1000),'maxRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'indexBytes':sum(p.stat().st_size for p in memory.ROOT.rglob('*') if p.is_file()),'cases':results,'limitations':['Synthetic corpus, no provider execution','Linux amd64 container under desktop emulation; not AWS sizing evidence','Existing FTS baseline; existing local semantic baseline not measured']}
Path('/evidence/memory-evaluation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='cases'}))
