
import { describe, it, expect } from "vitest";
import { formatProjectOutput } from "../project-output.js";

function makeProject() {
  return {
    id: "P1",
    metadata: { label: "P1", kind: "project" },
    title: "P1 — Test",
    content: "Test project",
    tags: [],
    createdAt: "2026-06-01T00:00:00Z",
  } as any;
}

describe("renderDepthLoad / renderDepthRead", () => {
  it("load mode: renderDepthLoad=0 skips, renderDepthRead=0 shows", () => {
    const project = makeProject();
    const sectionA = {
      id: "sec-a", parentId: "P1", title: "Always Shows",
      metadata: { order: 0 },
      tags: [], content: "", createdAt: "",
    } as any;
    const sectionB = {
      id: "sec-b", parentId: "P1", title: "Load Only",
      metadata: { order: 1, renderDepthLoad: 2, renderDepthRead: 0 },
      tags: [], content: "", createdAt: "",
    } as any;
    const sectionC = {
      id: "sec-c", parentId: "P1", title: "Read Only",
      metadata: { order: 2, renderDepthLoad: 0, renderDepthRead: 2 },
      tags: [], content: "", createdAt: "",
    } as any;

    const result = { project, children: [sectionA, sectionB, sectionC], truncated: false };

    // Load: sectionA shows, sectionB shows, sectionC skipped (renderDepthLoad=0)
    const loadOut = formatProjectOutput(result, 50, undefined, "load");
    expect(loadOut).toContain("Always Shows");
    expect(loadOut).toContain("Load Only");
    expect(loadOut).not.toContain("Read Only");

    // Read: sectionA shows, sectionB skipped (renderDepthRead=0), sectionC shows
    const readOut = formatProjectOutput(result, 50, undefined, "read");
    expect(readOut).toContain("Always Shows");
    expect(readOut).not.toContain("Load Only");
    expect(readOut).toContain("Read Only");
  });

  it("no renderMode: falls back to legacy render_depth", () => {
    const project = makeProject();
    const section = {
      id: "sec", parentId: "P1", title: "Legacy",
      metadata: { order: 0, render_depth: 0 },
      tags: [], content: "", createdAt: "",
    } as any;

    const result = { project, children: [section], truncated: false };

    // No renderMode, legacy render_depth=0 → skipped
    const out = formatProjectOutput(result, 50);
    expect(out).not.toContain("Legacy");
  });

  it("renderMode-specific overrides legacy render_depth", () => {
    const project = makeProject();
    const section = {
      id: "sec", parentId: "P1", title: "Specific Wins",
      metadata: { order: 0, render_depth: 3, renderDepthLoad: 0 },
      tags: [], content: "", createdAt: "",
    } as any;

    const result = { project, children: [section], truncated: false };

    // Load: renderDepthLoad=0 wins → skipped (not legacy render_depth=3)
    const out = formatProjectOutput(result, 50, undefined, "load");
    expect(out).not.toContain("Specific Wins");

    // Read: no renderDepthRead set, falls back to render_depth=3 → shows
    const readOut = formatProjectOutput(result, 50, undefined, "read");
    expect(readOut).toContain("Specific Wins");
  });
});

