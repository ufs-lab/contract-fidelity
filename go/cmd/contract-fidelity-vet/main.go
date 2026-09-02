// Command contract-fidelity-vet runs the analyzer as a `go vet` tool:
//
//	go vet -vettool=$(command -v contract-fidelity-vet) ./...
package main

import (
	"golang.org/x/tools/go/analysis/singlechecker"

	"github.com/ufs-lab/contract-fidelity/go/analyzer"
)

func main() {
	singlechecker.Main(analyzer.Analyzer)
}
