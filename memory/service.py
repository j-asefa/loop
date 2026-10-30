"""Single-writer, private MemSearch 0.4.21 service. No native-home scanning or LLM calls."""
import asyncio
import hashlib
import hmac
import json
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# Must be set before importing model libraries. Warming is an explicit build step.
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
import onnxruntime as ort
_real_session=ort.InferenceSession
def bounded_session(path,*args,**kwargs):
    options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
    return _real_session(path,sess_options=options,*args,**kwargs)
ort.InferenceSession=bounded_session
from memsearch import MemSearch
from memsearch.embeddings.onnx import OnnxEmbedding
import memsearch.core

ROOT = Path(os.environ['LOOP55_MEMORY_DATA']).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
CORPUS = ROOT / 'corpus'
CORPUS.mkdir(exist_ok=True)
MODEL = Path(os.environ['LOOP55_EMBEDDING_MODEL_PATH']).resolve()
TOKEN = Path(os.environ['LOOP55_MEMORY_TOKEN_FILE']).read_text().strip()
if len(TOKEN) < 32:
    raise RuntimeError('Private memory authentication is required')
# Narrow pinned-library seam: use the exact image/cache model files. Never download at runtime.
def local_model_files(*_):
    files = MODEL / 'tokenizer.json', MODEL / 'model_quantized.onnx'
    if not all(p.is_file() for p in files):
        raise RuntimeError('Pinned embedding cache is incomplete')
    return tuple(str(p) for p in files)
OnnxEmbedding._download_model_files = staticmethod(local_model_files)
embedder = OnnxEmbedding('gpahal/bge-m3-onnx-int8', batch_size=2)
memsearch.core.get_provider = lambda provider, **kwargs: embedder if provider == 'onnx' else (_ for _ in ()).throw(RuntimeError('Paid embedding providers are disabled'))
index = MemSearch(paths=[str(CORPUS)], embedding_provider='onnx', embedding_model='gpahal/bge-m3-onnx-int8', embedding_batch_size=2, milvus_uri=str(ROOT / 'milvus.db'), max_chunk_size=1500, overlap_lines=2, reranker_model='')
ledger = sqlite3.connect(ROOT / 'revisions.db')
ledger.execute('CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, path TEXT NOT NULL, deleted INTEGER NOT NULL)')
ledger.commit()

def scope(owner, project):
    if not isinstance(owner,str) or not owner or project is not None and not isinstance(project,str):
        raise ValueError('Invalid scope')
    return CORPUS / hashlib.sha256(json.dumps([owner,project],separators=(',',':')).encode()).hexdigest()

def source(data):
    identifier = data['id']
    if not re.fullmatch('[a-f0-9]{64}', identifier) or not isinstance(data['revision'],int) or data['revision']<1:
        raise ValueError('Invalid source identity')
    previous=ledger.execute('SELECT revision,path,deleted FROM sources WHERE id=?',(identifier,)).fetchone()
    if previous and previous[0] >= data['revision']:
        return {'ok':True,'revision':previous[0]}
    directory=scope(data['owner'],data.get('project'))
    directory.mkdir(exist_ok=True)
    path=directory/(identifier+'.md')
    deleted=data['action']=='delete'
    if deleted:
        if previous:
            index._store.delete_by_source(previous[1])
            Path(previous[1]).unlink(missing_ok=True)
        index._store.delete_by_source(str(path))
        path.unlink(missing_ok=True)
    else:
        text=data['content']
        if not isinstance(text,str) or len(text)>100000:
            raise ValueError('Source too large')
        temporary=path.with_suffix('.tmp')
        temporary.write_text('# '+str(data['title']).replace('\n',' ')[:180]+'\n\n'+text)
        temporary.replace(path)
        asyncio.run(index.index_file(path))
        if previous and previous[1]!=str(path):
            index._store.delete_by_source(previous[1])
            Path(previous[1]).unlink(missing_ok=True)
    ledger.execute('INSERT INTO sources VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,path=excluded.path,deleted=excluded.deleted',(identifier,data['revision'],str(path),int(deleted)))
    ledger.commit()
    return {'ok':True,'revision':data['revision']}

def search(data):
    if not isinstance(data['query'],str) or len(data['query'])>2000: raise ValueError('Query too large')
    results=[]
    vector=asyncio.run(embedder.embed([data['query']]))[0]
    projects=[data.get('project')]
    if projects[0] is not None: projects.append(None)
    for project in projects:
        directory=scope(data['owner'],project)
        if not directory.exists(): continue
        if not index._store._collection_exists: continue
        filter_expr='source like "'+str(directory)+'/%"'
        count=min(30,max(1,int(data.get('limit',5))))
        hits=index._store.search(vector,query_text=data['query'],top_k=count,filter_expr=filter_expr)
        # RRF rank is not confidence. Require cosine support from the same
        # pinned index before injecting merely-nearest, unrelated documents.
        dense=index._store._connected_client().search(collection_name=index._store._collection,data=[vector],anns_field='embedding',search_params={'metric_type':'COSINE','params':{}},limit=count,filter=filter_expr,output_fields=['source'])
        supported={h['entity']['source'] for h in (dense[0] if dense else []) if h['distance']>=0.50}
        for hit in hits:
            path=Path(hit['source']).resolve()
            if path.parent!=directory or str(path) not in supported: continue
            row=ledger.execute('SELECT revision,deleted FROM sources WHERE id=? AND path=?',(path.stem,str(path))).fetchone()
            if row and not row[1]: results.append({'id':path.stem,'revision':row[0],'score':hit['score']})
    return {'results':sorted(results,key=lambda r:r['score'],reverse=True)[:30],'provider':'onnx','modelRevision':'2b34e84df040034d4b9eabb62383a87c18955822'}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_): pass  # Never log corpus, credentials or queries.
    def respond(self,status,value):
        body=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_GET(self):
        if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN): return self.respond(401,{'error':'Unauthorized'})
        if self.path=='/health': return self.respond(200,{'ready':True,'provider':'onnx','model':'gpahal/bge-m3-onnx-int8','revision':'2b34e84df040034d4b9eabb62383a87c18955822','sources':ledger.execute('SELECT count(*) FROM sources WHERE deleted=0').fetchone()[0]})
        self.respond(404,{'error':'Unknown operation'})
    def do_POST(self):
        if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN): return self.respond(401,{'error':'Unauthorized'})
        size=int(self.headers.get('Content-Length','0'))
        if not 0<size<200000: return self.respond(413,{'error':'Invalid body size'})
        try:
            data=json.loads(self.rfile.read(size))
            if self.path=='/source': result=source(data)
            elif self.path=='/search': result=search(data)
            else: return self.respond(404,{'error':'Unknown operation'})
            self.respond(200,result)
        except Exception:
            self.respond(503,{'error':'Memory operation failed; lexical fallback remains available'})

if __name__=='__main__':
    HTTPServer((os.environ.get('LOOP55_MEMORY_HOST','127.0.0.1'),int(os.environ.get('PORT','3011'))),Handler).serve_forever()
