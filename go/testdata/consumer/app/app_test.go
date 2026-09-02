package app

import "testing"

func TestLive(t *testing.T) {
	if liveParam(1000) {
		t.Log("out of contract on purpose")
	}
	v := view{Status: "PARTIAL"}
	_ = classify(v)
	_ = describe(nil)
}
