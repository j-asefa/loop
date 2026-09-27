"""Build-only model preparation, immutable revision, runtime downloads forbidden."""
from pathlib import Path
from huggingface_hub import snapshot_download
import json
import sys
pins=json.loads(Path(sys.argv[1]).read_text())
target=Path(sys.argv[2])
snapshot_download(pins['embeddingModel'],revision=pins['embeddingRevision'],local_dir=target,allow_patterns=['tokenizer.json','model_quantized.onnx','model_quantized.onnx_data'])
for name in ['tokenizer.json','model_quantized.onnx']:
    if not (target/name).is_file(): raise RuntimeError('Incomplete model cache')
(target/'revision').write_text(pins['embeddingRevision'])
