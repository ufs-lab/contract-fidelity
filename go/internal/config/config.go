// Package config reads contract-fidelity.config.json, the same file the
// TypeScript tool reads. Keys that only make sense for a TypeScript
// program (`tsconfig`) are accepted and ignored so one file can configure
// both tools.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
)

// FileName is the configuration file at the project root.
const FileName = "contract-fidelity.config.json"

// Config is the parsed configuration with defaults applied.
type Config struct {
	ContractPackages []string                    `json:"contractPackages"`
	ScanRoots        []string                    `json:"scanRoots"`
	TrustContract    *bool                       `json:"trustContract"`
	InferConstraints *bool                       `json:"inferConstraints"`
	ClosedWorld      *bool                       `json:"closedWorld"`
	CensusTests      *bool                       `json:"censusTests"`
	BaselineDir      string                      `json:"baselineDir"`
	DocPatterns      []constraint.DocPatternSpec `json:"docPatterns"`
	Tsconfig         string                      `json:"tsconfig"`

	// Patterns are the go/packages patterns derived from ScanRoots.
	Patterns []string `json:"-"`
	// CompiledDocPatterns are the validated DocPatterns.
	CompiledDocPatterns []constraint.DocPattern `json:"-"`
}

// Load reads the config at path (or FileName under dir when path is
// empty). `contractPackages` is required: a scan that matches no contract
// would report clean while it checks nothing.
func Load(dir, path string) (*Config, error) {
	if path == "" {
		path = filepath.Join(dir, FileName)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("contract-fidelity: no %s found in %s; it must name `contractPackages`", FileName, dir)
		}
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("contract-fidelity: parse %s: %w", path, err)
	}
	if len(c.ContractPackages) == 0 {
		return nil, errors.New("contract-fidelity: `contractPackages` is required and has no default")
	}
	if c.BaselineDir == "" {
		c.BaselineDir = ".contract-fidelity"
	}
	if len(c.ScanRoots) == 0 {
		c.Patterns = []string{"./..."}
	}
	for _, root := range c.ScanRoots {
		root = filepath.ToSlash(filepath.Clean(root))
		switch {
		case root == "." || root == "":
			c.Patterns = append(c.Patterns, "./...")
		case root == "./..." || len(root) > 4 && root[len(root)-4:] == "/...":
			c.Patterns = append(c.Patterns, "./"+root)
		default:
			c.Patterns = append(c.Patterns, "./"+root+"/...")
		}
	}
	c.CompiledDocPatterns, err = constraint.CompileDocPatterns(c.DocPatterns)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

// Trust reports trustContract (default true).
func (c *Config) Trust() bool { return boolOr(c.TrustContract, true) }

// Closed reports closedWorld (default true).
func (c *Config) Closed() bool { return boolOr(c.ClosedWorld, true) }

// Tests reports censusTests (default true, the upstream behaviour).
func (c *Config) Tests() bool { return boolOr(c.CensusTests, true) }
