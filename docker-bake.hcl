# PRs restore default-branch caches without uploading private per-PR copies.
# Manual/default-branch runs seed compact caches of shipped image layers.
variable "CACHE_WRITE" { default = "false" }
group "server-stack" { targets = ["server", "runtime", "broker", "mcp"] }
group "companion-stack" { targets = ["companion", "connection"] }
target "server" {
  context = "."
  dockerfile = "Dockerfile"
  tags = ["loop-ci-server:validation"]
  cache-from = ["type=gha,scope=loop-server-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop-server-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "runtime" {
  context = "."
  dockerfile = "Dockerfile.runtime"
  tags = ["loop-runtime:0.2"]
  cache-from = ["type=gha,scope=loop-runtime-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop-runtime-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "broker" {
  context = "."
  dockerfile = "Dockerfile.runtime-broker"
  tags = ["loop-ci-broker:validation"]
  cache-from = ["type=gha,scope=loop-broker-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop-broker-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "mcp" {
  context = "."
  dockerfile = "Dockerfile.mcp"
  tags = ["loop-mcp:0.1"]
  cache-from = ["type=gha,scope=loop-mcp-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop-mcp-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "companion" {
  context = "."
  dockerfile = "Dockerfile.companion"
  tags = ["loop-ci-companion:validation"]
  cache-from = ["type=gha,scope=loop-companion-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop-companion-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "connection" {
  context = "."
  dockerfile = "Dockerfile.connection"
  tags = ["loop-ci-connection:validation"]
  cache-from = ["type=gha,scope=loop-connection-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop-connection-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "native" {
  context = "."
  dockerfile = "deployment/Dockerfile.native"
  tags = ["loop-architecture-native:validation"]
  cache-from = ["type=gha,scope=loop-native-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop-native-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
