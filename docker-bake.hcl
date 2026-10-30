# PRs restore default-branch caches without uploading private per-PR copies.
# Manual/default-branch runs seed compact caches of shipped image layers.
variable "CACHE_WRITE" { default = "false" }
group "server-stack" { targets = ["server", "runtime", "broker", "mcp"] }
group "companion-stack" { targets = ["companion", "connection"] }
target "server" {
  context = "."
  dockerfile = "Dockerfile"
  tags = ["loop55-ci-server:validation"]
  cache-from = ["type=gha,scope=loop55-server-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop55-server-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "runtime" {
  context = "."
  dockerfile = "Dockerfile.runtime"
  tags = ["loop55-runtime:0.2"]
  cache-from = ["type=gha,scope=loop55-runtime-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop55-runtime-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "broker" {
  context = "."
  dockerfile = "Dockerfile.runtime-broker"
  tags = ["loop55-ci-broker:validation"]
  cache-from = ["type=gha,scope=loop55-broker-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop55-broker-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "mcp" {
  context = "."
  dockerfile = "Dockerfile.mcp"
  tags = ["loop55-mcp:0.1"]
  cache-from = ["type=gha,scope=loop55-mcp-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop55-mcp-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "companion" {
  context = "."
  dockerfile = "Dockerfile.companion"
  tags = ["loop55-ci-companion:validation"]
  cache-from = ["type=gha,scope=loop55-companion-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop55-companion-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
target "connection" {
  context = "."
  dockerfile = "Dockerfile.connection"
  tags = ["loop55-ci-connection:validation"]
  cache-from = ["type=gha,scope=loop55-connection-linux-amd64,version=2"]
  cache-to = CACHE_WRITE == "true" ? ["type=gha,scope=loop55-connection-linux-amd64,version=2,mode=min,ignore-error=true,timeout=2m"] : []
}
