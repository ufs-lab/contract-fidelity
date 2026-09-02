// Package plugin registers contract-fidelity as a golangci-lint module
// plugin. Build a custom binary with `golangci-lint custom` and a
// .custom-gcl.yml that names this module, then enable `contractfidelity`
// under linters.settings.custom with type "module".
package plugin

import (
	"github.com/golangci/plugin-module-register/register"
	"golang.org/x/tools/go/analysis"

	"github.com/ufs-lab/contract-fidelity/go/analyzer"
)

func init() {
	register.Plugin("contractfidelity", New)
}

// Settings are the keys accepted under linters.settings.custom.contractfidelity.settings.
type Settings struct {
	// Config names the config file; empty finds contract-fidelity.config.json
	// upward from each package.
	Config string `json:"config"`
	// DeadCode and Widening select the checks (both on by default).
	DeadCode *bool `json:"dead-code"`
	Widening *bool `json:"widening"`
	// Cache stores findings on disk keyed by the module's sources (on by
	// default).
	Cache *bool `json:"cache"`
}

// New is the plugin constructor golangci-lint calls.
func New(conf any) (register.LinterPlugin, error) {
	s, err := register.DecodeSettings[Settings](conf)
	if err != nil {
		return nil, err
	}
	return &linter{settings: s}, nil
}

type linter struct {
	settings Settings
}

func (l *linter) BuildAnalyzers() ([]*analysis.Analyzer, error) {
	a := analyzer.Analyzer
	if l.settings.Config != "" {
		if err := a.Flags.Set("config", l.settings.Config); err != nil {
			return nil, err
		}
	}
	for name, v := range map[string]*bool{"dead-code": l.settings.DeadCode, "widening": l.settings.Widening, "cache": l.settings.Cache} {
		if v == nil {
			continue
		}
		val := "false"
		if *v {
			val = "true"
		}
		if err := a.Flags.Set(name, val); err != nil {
			return nil, err
		}
	}
	return []*analysis.Analyzer{a}, nil
}

func (l *linter) GetLoadMode() string {
	return register.LoadModeTypesInfo
}
